package foyer

import (
	"fmt"
	"path"
	"strings"
)

// UsageResult mirrors the JSON printed by `juicefs usage` (overlays/juicefs/cmd/usage.go).
type UsageResult struct {
	Volume    VolumeUsage `json:"volume"`
	Summaries []PathUsage `json:"summaries"`
}

type PathUsage struct {
	Path   string `json:"path"`
	Error  string `json:"error,omitempty"`
	Size   uint64 `json:"size"`
	Length uint64 `json:"length"`
	Files  uint64 `json:"files"`
	Dirs   uint64 `json:"dirs"`
	Inodes uint64 `json:"inodes"`
	// 该路径所依赖存储池的实时占用快照，由本服务采样填入（overlay 不产出这三项）。
	// 读不到池时三项都缺席（omitempty），消费方据此**不画**进度条，而不是画成 0%。
	DiskTotal uint64 `json:"disk_total,omitempty"`
	DiskUsed  uint64 `json:"disk_used,omitempty"`
	DiskFree  uint64 `json:"disk_free,omitempty"`
}

// DiskSpace 是物理数据盘的容量快照。读不到盘时调用方传 diskOK=false
// （见 BuildUsageResponse），本类型自身没有 error 字段。
//
// Used 与 Total 同源但**不互补**：Used = Blocks-Bfree（文件真实占用，同 df 的
// Used），Free = Bavail（同 df 的 Avail），Used+Free 的缺口是保留块。
// 占用率请用 Used/Total，别用 (Total-Free)/Total。
type DiskSpace struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// VolumeUsage 是 `juicefs usage` 的原始卷级输出，字段语义以 CLI 契约为准。
// 它与 UsageVolume 同名不同义，不可互换：前者是本包解析出的原始值，后者是
// GET /foyer/usage 处理后的 API 载荷。
//
// Capacity/CapacitySet 仍是 CLI 契约的一部分（CLI 照旧会报配置的额度），但本服务
// 的 API 载荷刻意不暴露它们——额度是静态快照，不能当进度条分母，理由见 UsageVolume。
type VolumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
}

// UsageVolume 是 GET /foyer/usage 的卷级载荷：逻辑用量 + 物理数据盘实时占用。
//
// 这里**没有** capacity/capacity_set：进度条分母不是「配置的额度」。额度是静态
// 快照，而挂载源依赖的是共享且动态的磁盘资源（同一块盘上还有别的目录在长），
// 写死的额度立刻失真。分母必须来自实时采样，见 DiskSpace 的注释。
type UsageVolume struct {
	Used       uint64 `json:"used"`
	UsedInodes uint64 `json:"used_inodes"`
	DiskTotal  uint64 `json:"disk_total"`
	DiskUsed   uint64 `json:"disk_used"`
	DiskFree   uint64 `json:"disk_free"`
}

type UsageResponse struct {
	Volume    UsageVolume `json:"volume"`
	Summaries []PathUsage `json:"summaries"`
}

// UsageArgs builds `juicefs usage META [PATH...]`. 没有 PATH 时只回报卷级用量。
func UsageArgs(cfg Config, paths []string) []string {
	return append([]string{"usage", cfg.MetaURL}, paths...)
}

func (r Runner) Usage(cfg Config, paths []string) (UsageResult, error) {
	c := r.cmd(UsageArgs(cfg, paths)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return UsageResult{}, fmt.Errorf("juicefs usage: %s", lastLine(msg))
		}
		return UsageResult{}, fmt.Errorf("juicefs usage: %w", err)
	}
	res, perr := parseUsage(text)
	if perr != nil {
		return UsageResult{}, fmt.Errorf("juicefs usage: %w", perr)
	}
	return res, nil
}

func parseUsage(text string) (UsageResult, error) {
	res, err := parseJSONLine[UsageResult](text)
	if err != nil {
		return UsageResult{}, fmt.Errorf("no JSON usage in juicefs output: %s", truncate(text, 200))
	}
	return res, nil
}

// BuildUsageResponse 合并卷用量、卷所在数据盘占用与**每个路径各自**的池占用。
//
// pools 以**归一化后的卷内路径**为键（见 cleanVolumePath），值为该路径来源盘的实时
// 快照；缺键表示该路径的池未知（例如来源路径不在容器里），此时该 summary 不带
// disk_* 三项，让消费方不画进度条。纯函数：不在这里做 statfs，也不做任何回退。
func BuildUsageResponse(vol VolumeUsage, disk DiskSpace, diskOK bool, summaries []PathUsage, pools map[string]DiskSpace) UsageResponse {
	out := UsageResponse{
		Volume: UsageVolume{
			Used:       vol.Used,
			UsedInodes: vol.UsedInodes,
		},
		Summaries: summaries,
	}
	if diskOK {
		out.Volume.DiskTotal = disk.Total
		out.Volume.DiskUsed = disk.Used
		out.Volume.DiskFree = disk.Free
	}
	for i := range out.Summaries {
		s := &out.Summaries[i]
		if s.Error != "" {
			continue
		}
		if d, ok := pools[s.Path]; ok {
			s.DiskTotal, s.DiskUsed, s.DiskFree = d.Total, d.Used, d.Free
		}
	}
	if out.Summaries == nil {
		out.Summaries = []PathUsage{}
	}
	return out
}

// cleanVolumePath 把请求里的卷内路径归一成 overlay 回报的形状（前导 /、折叠 //、
// 解析 . 与 ..、去掉尾斜杠），否则 /photos/ 与 /photos 会查不到同一个池。
//
// 用 path 而不是 path/filepath：卷内路径永远是 slash 分隔，Windows 上不能被转成反斜杠。
func cleanVolumePath(p string) string {
	return path.Clean("/" + strings.TrimSpace(p))
}

// poolPathFor 从挂载记录里建「卷内路径 -> 容器内来源路径」的映射。
//
// 之所以能直接 statfs 来源路径：源盘已按 scripts/gen-host-drives.ps1 绑进容器
// （G:/ -> /mnt/g 等），对来源路径 statfs 拿到的就是它所在文件系统（即那个盘）的
// 真实占用。容器路径优先 spec.container，退化到 spec.root。
//
// 只适用于 mode=metadata（仅导入元数据）——此时文件仍在源盘上，源盘就是依赖的池。
// 若将来支持整卷复制（数据落到对象存储），依赖的池应改为 cfg.DataDisk，此处必须
// 一并改，否则会报错一块跟数据无关的盘。
func poolPathFor(mounts []MountRecord) map[string]string {
	out := map[string]string{}
	for _, m := range mounts {
		dest := strings.TrimSpace(m.Spec["dest"])
		if dest == "" {
			continue
		}
		src := strings.TrimSpace(m.Spec["container"])
		if src == "" {
			src = strings.TrimSpace(m.Spec["root"])
		}
		if src == "" {
			continue
		}
		key := cleanVolumePath(dest)
		if _, seen := out[key]; !seen {
			out[key] = src
		}
	}
	return out
}
