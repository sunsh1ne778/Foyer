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
type DiskSpace struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// VolumeUsage 是 `juicefs usage` 的原始卷级输出，字段语义以 CLI 契约为准。
// 它与 UsageVolume 同名不同义，不可互换：前者是本包解析出的原始值，后者是
// GET /foyer/usage 处理后的 API 载荷。
type VolumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
}

// UsageVolume 是 GET /foyer/usage 里的卷级用量，Capacity 已把「分母」解析好。
// 它与 VolumeUsage 同名不同义、不可互换：VolumeUsage 是 `juicefs usage` 的原始输出，
// UsageVolume 是处理后的 API 载荷。
type UsageVolume struct {
	// Capacity 是进度条分母：设了配额用配额，否则用物理数据盘总量；都没有则 0。
	Capacity uint64 `json:"capacity"`
	// CapacitySet 表示「卷配置了容量配额吗」，语义与 CLI 契约里的
	// volume.capacity_set 完全一致（即 VolumeUsage.CapacitySet 的原样透传）；
	// 它 NOT 表示「分母解析出来了吗」。要判断分母是否存在请看 Capacity != 0。
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	UsedInodes  uint64 `json:"used_inodes"`
	DiskTotal   uint64 `json:"disk_total"`
	DiskUsed    uint64 `json:"disk_used"`
	DiskFree    uint64 `json:"disk_free"`
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

// BuildUsageResponse 合并卷用量与物理盘容量。纯函数：容量解析规则（配额优先、
// 否则物理盘、都没有就诚实报 0）只在这一处，别在 handler 里再写一遍。
// 注意：CapacitySet 只做透传（「卷是否设了配额」），回退到物理盘时也不会置真；
// 分母是否存在请判断 Capacity != 0。
func BuildUsageResponse(vol VolumeUsage, disk DiskSpace, diskOK bool, summaries []PathUsage) UsageResponse {
	out := UsageResponse{
		Volume: UsageVolume{
			CapacitySet: vol.CapacitySet,
			Used:        vol.Used,
			UsedInodes:  vol.UsedInodes,
			Capacity:    vol.Capacity,
		},
		Summaries: summaries,
	}
	if diskOK {
		out.Volume.DiskTotal = disk.Total
		out.Volume.DiskUsed = disk.Used
		out.Volume.DiskFree = disk.Free
	}
	if out.Volume.Capacity == 0 && diskOK {
		out.Volume.Capacity = disk.Total
	}
	if out.Summaries == nil {
		out.Summaries = []PathUsage{}
	}
	return out
}
