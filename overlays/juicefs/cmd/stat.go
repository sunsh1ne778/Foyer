package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/urfave/cli/v2"
)

// statResult 是一个卷内路径的元数据快照；失败时只填 Path 与 Error。
//
// 存在的理由是 S3 网关拿不到目录时间：带分隔符时目录只出现在 CommonPrefixes
// （没有 LastModified），对目录键 HeadObject 还会 404。控制面必须能单独读出真值。
type statResult struct {
	Path      string `json:"path"`
	Error     string `json:"error,omitempty"`
	Inode     uint64 `json:"inode"`
	Type      string `json:"type,omitempty"`
	Mode      uint16 `json:"mode"`
	Uid       uint32 `json:"uid"`
	Gid       uint32 `json:"gid"`
	Size      uint64 `json:"size"`
	Nlink     uint32 `json:"nlink"`
	Mtime     int64  `json:"mtime"`
	Mtimensec uint32 `json:"mtimensec"`
}

func cmdStat() *cli.Command {
	return &cli.Command{
		Name:      "stat",
		Action:    statPaths,
		Category:  "INSPECTOR",
		Usage:     "Print metadata attributes of volume paths as JSON lines",
		ArgsUsage: "META-URL PATH [PATH...]",
		Description: `
Resolve each PATH inside the volume and print its attributes.

Output is one JSON object per line (a failure prints {"path":...,"error":...}),
so callers can parse it line by line; log lines may be interleaved. Several paths
are resolved in a single session on purpose: a directory listing needs the mtime
of every subdirectory, and one process per path does not scale.

Read-only: this command never modifies metadata.

Note: for directories Size is the metadata length (usually 4096) rather than 0 —
it is the raw attribute, not the object-store view.

Exit code is 0 if at least one path resolved, non-zero if none did.

Examples:
$ juicefs stat redis://localhost /photos/sub
$ juicefs stat redis://localhost /photos/a /photos/b /photos/c`,
	}
}

func statPaths(c *cli.Context) error {
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
	enc := json.NewEncoder(os.Stdout)
	resolved := 0
	var lastErr error
	for _, p := range paths {
		inode, attr, err := lookupPathAttr(m, ctx, p)
		var res statResult
		if err != nil {
			res = statResult{Path: normalizeVolumePath(p), Error: err.Error()}
			lastErr = err
		} else {
			res = statResultOf(p, inode, attr)
			resolved++
		}
		if encErr := enc.Encode(res); encErr != nil {
			return encErr
		}
	}
	if resolved == 0 {
		// 单路径用法（拼错路径）必须仍以非零退出码暴露失败。
		return fmt.Errorf("stat: %w", lastErr)
	}
	return nil
}

// statResultOf 把 inode + attr 折成可序列化的快照；纯函数，便于单测。
func statResultOf(p string, inode meta.Ino, attr meta.Attr) statResult {
	return statResult{
		Path:      normalizeVolumePath(p),
		Inode:     uint64(inode),
		Type:      statTypeString(attr.Typ),
		Mode:      attr.Mode,
		Uid:       attr.Uid,
		Gid:       attr.Gid,
		Size:      attr.Length,
		Nlink:     attr.Nlink,
		Mtime:     attr.Mtime,
		Mtimensec: attr.Mtimensec,
	}
}

// normalizeVolumePath 统一成以 "/" 开头、无尾斜杠的卷内绝对路径。
// 空白与相对写法都收敛到根下的绝对形式，避免 "/a/b/" 这类输入漏配。
func normalizeVolumePath(p string) string {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return "/"
	}
	return path.Clean("/" + strings.TrimPrefix(trimmed, "/"))
}

func statTypeString(typ uint8) string {
	switch typ {
	case meta.TypeDirectory:
		return "directory"
	case meta.TypeSymlink:
		return "symlink"
	case meta.TypeFile:
		return "file"
	default:
		return "other"
	}
}

// lookupPathAttr 按卷内绝对路径逐段解析 inode，再取完整属性。
// 走 GetAttr 而不是复用 Lookup 的 attr：根路径没有 Lookup，且 Lookup 返回的
// attr 可能是缓存里的部分字段。
func lookupPathAttr(m meta.Meta, ctx meta.Context, p string) (meta.Ino, meta.Attr, error) {
	inode := meta.RootInode
	var attr meta.Attr
	for _, name := range strings.Split(normalizeVolumePath(p), "/") {
		if name == "" {
			continue
		}
		var child meta.Ino
		var childAttr meta.Attr
		if st := m.Lookup(ctx, inode, name, &child, &childAttr, false); st != 0 {
			return 0, childAttr, fmt.Errorf("lookup %s: %s", name, st)
		}
		inode = child
	}
	if st := m.GetAttr(ctx, inode, &attr); st != 0 {
		return 0, attr, fmt.Errorf("stat %s: %s", normalizeVolumePath(p), st)
	}
	return inode, attr, nil
}
