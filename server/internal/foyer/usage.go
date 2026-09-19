package foyer

import (
	"fmt"
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

// BuildUsageResponse 合并卷用量与物理数据盘占用。纯函数：磁盘字段是否带出
// 只取决于 diskOK，这里不做任何"分母回退"——没有实时采样就没有分母，
// 消费方据此不画进度条。
func BuildUsageResponse(vol VolumeUsage, disk DiskSpace, diskOK bool, summaries []PathUsage) UsageResponse {
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
	if out.Summaries == nil {
		out.Summaries = []PathUsage{}
	}
	return out
}
