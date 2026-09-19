package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/urfave/cli/v2"
)

// volumeUsage 是卷级用量。Capacity 取 Format.Capacity（配额真值），为 0 表示未设
// 配额——此时 StatFS 的 totalspace 是合成值，绝不能当容量用。
type volumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
}

// pathUsage 是一个卷内路径的真实用量。Size/Inodes 直接来自元数据 DirStats 计数，
// 与 `juicefs quota get` 同源，不需要先设置配额就能读到。
type pathUsage struct {
	Path   string `json:"path"`
	Error  string `json:"error,omitempty"`
	Size   uint64 `json:"size"`
	Length uint64 `json:"length"`
	Files  uint64 `json:"files"`
	Dirs   uint64 `json:"dirs"`
	Inodes uint64 `json:"inodes"`
}

type usageResult struct {
	Volume    volumeUsage `json:"volume"`
	Summaries []pathUsage `json:"summaries"`
}

func cmdUsage() *cli.Command {
	return &cli.Command{
		Name:      "usage",
		Action:    usagePaths,
		Category:  "INSPECTOR",
		Usage:     "Print real space and inode usage of volume paths as JSON",
		ArgsUsage: "META-URL [PATH...]",
		Description: `
Report real used space and inodes, per path, plus the volume-level usage.

Space is read from the metadata DirStats counters (the same counters
` + "`juicefs quota get`" + ` reports), so it is instant on huge trees — no data plane
scan. No quota needs to be set beforehand.

Capacity is only reported when a quota is actually configured; an unset quota
prints capacity 0 with capacity_set=false, because the filesystem reports a
synthesized total in that case rather than a real limit.

Output is a single line of JSON so callers can parse it directly.

Examples:
$ juicefs usage redis://localhost
$ juicefs usage redis://localhost /photos /av_20260619`,
	}
}

func usagePaths(c *cli.Context) error {
	// 至少 META-URL；PATH 可为空（只要卷级用量）。
	setup0(c, 1, 0)
	metaURL := c.Args().Get(0)
	paths := c.Args().Slice()[1:]
	removePassword(metaURL)

	conf := meta.DefaultConf()
	conf.NoBGJob = true
	m := meta.NewClient(metaURL, conf)
	format, err := m.Load(true)
	if err != nil {
		return err
	}
	if err := m.NewSession(false); err != nil {
		return err
	}
	defer func() { _ = m.CloseSession() }()

	ctx := meta.Background()
	var total, avail, iused, iavail uint64
	if st := m.StatFS(ctx, meta.RootInode, &total, &avail, &iused, &iavail); st != 0 {
		return fmt.Errorf("statfs: %s", st)
	}

	res := usageResult{
		Volume:    volumeUsageOf(*format, total, avail, iused, iavail),
		Summaries: make([]pathUsage, 0, len(paths)),
	}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		inode, _, err := lookupPathAttr(m, ctx, p)
		if err != nil {
			res.Summaries = append(res.Summaries, pathUsage{Path: normalizeVolumePath(p), Error: err.Error()})
			continue
		}
		var sum meta.Summary
		if st := m.GetSummary(ctx, inode, &sum, true, false); st != 0 {
			res.Summaries = append(res.Summaries, pathUsage{Path: normalizeVolumePath(p), Error: st.Error()})
			continue
		}
		res.Summaries = append(res.Summaries, pathUsageOf(p, sum))
	}

	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(res)
}

// pathUsageOf 把 meta.Summary 折成可序列化快照。Inodes = files + dirs，
// 与 `juicefs quota get` 的 IUsed 同口径。
func pathUsageOf(p string, sum meta.Summary) pathUsage {
	return pathUsage{
		Path:   normalizeVolumePath(p),
		Size:   sum.Size,
		Length: sum.Length,
		Files:  sum.Files,
		Dirs:   sum.Dirs,
		Inodes: sum.Files + sum.Dirs,
	}
}

// volumeUsageOf 折 StatFS 计数与两个配额。空间与 inode 配额各自独立判定，
// 因为 StatFS 对未设配额的那一侧返回的是合成值，不是真限额：
//   - 未设空间配额（Capacity==0）时 totalspace 从 1<<50 起翻倍，avail 是假余量；
//   - 未设 inode 配额（Inodes==0）时 iavail 固定 10<<20 起翻倍，同样是假余量。
//
// 把合成值当容量/余量会让进度条分母失真，所以只在配额真的设了（>0）时才带出对应
// 的 avail 字段；未设的一侧保持 0，让消费方能区分「没有配额」和「还有多少」。
func volumeUsageOf(format meta.Format, total, avail, iused, iavail uint64) volumeUsage {
	used := uint64(0)
	if total > avail {
		used = total - avail
	}
	v := volumeUsage{
		Capacity:    format.Capacity,
		CapacitySet: format.Capacity > 0,
		Used:        used,
		UsedInodes:  iused,
	}
	if format.Capacity > 0 {
		v.Avail = avail
	}
	if format.Inodes > 0 {
		v.AvailInodes = iavail
	}
	return v
}
