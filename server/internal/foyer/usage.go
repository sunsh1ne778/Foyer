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

type VolumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
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

// DiskSpace 是物理数据盘的容量快照。Total=0 且 err!=nil 表示这台机器读不到。
type DiskSpace struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// UsageVolume 是 GET /foyer/usage 里的卷级用量，已把「分母」解析好。
type UsageVolume struct {
	// Capacity 是进度条分母：设了配额用配额，否则用物理数据盘总量；都没有则 0。
	Capacity    uint64 `json:"capacity"`
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
		out.Volume.CapacitySet = true
	}
	if out.Summaries == nil {
		out.Summaries = []PathUsage{}
	}
	return out
}
