package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/urfave/cli/v2"
)

// unflagSummary 是一次 unflag 运行的机器可读结果。
// Cleared 只统计真正带标志位、这次被清掉的 inode；Untouched 是本来就没标志位的。
type unflagSummary struct {
	DryRun    bool     `json:"dry_run"`
	Scanned   int      `json:"scanned"`
	Cleared   int      `json:"cleared"`
	Untouched int      `json:"untouched"`
	Errors    []string `json:"errors,omitempty"`
}

func cmdUnflag() *cli.Command {
	return &cli.Command{
		Name:      "unflag",
		Action:    unflagPaths,
		Category:  "TOOL",
		Usage:     "Clear file flags (immutable/append) so locked entries can be deleted again",
		ArgsUsage: "META-URL PATH [PATH...]",
		Description: `
Clear immutable/append flags on PATH and on everything below it.

Why this exists: "juicefs import" used to mark every imported file FlagImmutable.
JuiceFS answers unlink on an immutable inode with EPERM, so those files could
never be deleted again — not through the S3 gateway (it swallows the error and
returns 204) and not through rmr. Clearing the flag restores normal deletion.
New imports no longer set it; this is the rescue path for volumes imported
before that change.

Entries without any flag are left untouched, so this is safe to re-run and safe
to point at a whole subtree.

Examples:
$ juicefs unflag redis://localhost /photos
$ juicefs unflag redis://localhost /photos/2024 /photos/2025 --dry-run`,
		Flags: []cli.Flag{
			&cli.BoolFlag{
				Name:  "dry-run",
				Usage: "only report which entries carry flags; change nothing",
			},
			&cli.BoolFlag{
				Name:  "json",
				Usage: "print a single JSON summary instead of plain text",
			},
		},
	}
}

func unflagPaths(c *cli.Context) error {
	setup0(c, 2, 0)
	metaURL := c.Args().Get(0)
	paths := c.Args().Slice()[1:]
	removePassword(metaURL)

	conf := meta.DefaultConf()
	conf.NoBGJob = true
	m := meta.NewClient(metaURL, conf)
	if _, err := m.Load(true); err != nil {
		return err
	}
	if err := m.NewSession(false); err != nil {
		return err
	}
	defer func() { _ = m.CloseSession() }()

	ctx := meta.Background()
	dryRun := c.Bool("dry-run")
	summary := unflagSummary{DryRun: dryRun}
	for _, p := range paths {
		// 复用 stat 的路径解析：逐段 Lookup 再 GetAttr，拿到完整属性。
		inode, attr, err := lookupPathAttr(m, ctx, p)
		if err != nil {
			summary.Errors = append(summary.Errors, fmt.Sprintf("%s: %s", normalizeVolumePath(p), err))
			continue
		}
		clearFlags(m, ctx, inode, attr, dryRun, &summary)
	}

	reportUnflag(os.Stdout, summary, c.Bool("json"))
	if len(summary.Errors) > 0 {
		// 逐条容错，但最终必须以非零退出码暴露出来：静默漏清会让"删不掉"复现。
		return fmt.Errorf("unflag: %d error(s), first: %s", len(summary.Errors), summary.Errors[0])
	}
	return nil
}

func reportUnflag(w io.Writer, summary unflagSummary, asJSON bool) {
	if asJSON {
		b, err := json.Marshal(summary)
		if err != nil {
			fmt.Fprintln(w, err)
			return
		}
		fmt.Fprintln(w, string(b))
		return
	}
	verb := "cleared"
	if summary.DryRun {
		verb = "would clear"
	}
	fmt.Fprintf(w, "%s %d of %d entries (%d untouched)\n", verb, summary.Cleared, summary.Scanned, summary.Untouched)
}

// flagSetter 是 unflag 需要的最小 meta 子集。
// 抽成接口是为了让递归逻辑能用假实现单测，不必起真实的元数据服务。
type flagSetter interface {
	Readdir(ctx meta.Context, inode meta.Ino, wantattr uint8, entries *[]*meta.Entry) syscall.Errno
	SetAttr(ctx meta.Context, inode meta.Ino, set uint16, sugidclearmode uint8, attr *meta.Attr) syscall.Errno
}

// hasLockingFlag 判断属性里是否存在会让 JuiceFS 拒绝 unlink 的标志位。
// 必须与 meta 侧 unlink 的判定保持一致：
//
//	third_party/juicefs/pkg/meta/redis.go: attr.Flags&(FlagAppend|FlagImmutable) -> EPERM
func hasLockingFlag(flags uint8) bool {
	return flags&(meta.FlagAppend|meta.FlagImmutable) != 0
}

// clearFlags 递归清掉 inode 及其子树的标志位。
// 目录自己先清、再进子项：父目录若带 immutable，meta 会拒绝在其下增删条目。
func clearFlags(m flagSetter, ctx meta.Context, inode meta.Ino, attr meta.Attr, dryRun bool, summary *unflagSummary) {
	summary.Scanned++
	if hasLockingFlag(attr.Flags) {
		if dryRun {
			summary.Cleared++
		} else if st := m.SetAttr(ctx, inode, meta.SetAttrFlag, 0, &meta.Attr{}); st != 0 {
			summary.Errors = append(summary.Errors, fmt.Sprintf("clear flags of inode %d: %s", inode, st))
		} else {
			summary.Cleared++
		}
	} else {
		summary.Untouched++
	}
	if attr.Typ != meta.TypeDirectory {
		return
	}
	var entries []*meta.Entry
	if st := m.Readdir(ctx, inode, 1, &entries); st != 0 {
		summary.Errors = append(summary.Errors, fmt.Sprintf("readdir inode %d: %s", inode, st))
		return
	}
	for _, e := range entries {
		name := string(e.Name)
		// "." / ".." 由上层合成，不是真实条目；attr 缺失时跳过而不是硬塞零值，
		// 否则会把 Type 认成 0 而漏掉整棵子树。
		if name == "." || name == ".." || e.Attr == nil {
			continue
		}
		clearFlags(m, ctx, e.Inode, *e.Attr, dryRun, summary)
	}
}
