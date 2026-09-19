package cmd

import (
	"encoding/json"
	"os"
	"strings"
	"syscall"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/urfave/cli/v2"
)

// searchMatch 是一条命中。Path 是卷内绝对路径，Name 是最后一段。
type searchMatch struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Size      uint64 `json:"size"`
	Mtime     int64  `json:"mtime"`
	Mtimensec uint32 `json:"mtimensec"`
}

// searchError 记一棵子树读失败。刻意不中断整体：一处坏目录不该让整次检索失败。
type searchError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type searchResult struct {
	Keyword   string        `json:"keyword"`
	Matches   []searchMatch `json:"matches"`
	Scanned   uint64        `json:"scanned"`
	Truncated bool          `json:"truncated"`
	Errors    []searchError `json:"errors,omitempty"`
}

func cmdFind() *cli.Command {
	return &cli.Command{
		Name:      "find",
		Action:    findPaths,
		Category:  "INSPECTOR",
		Usage:     "Search volume paths by name as JSON",
		ArgsUsage: "META-URL [PATH...]",
		Description: `
Walk PATH (default "/") recursively and report every entry whose NAME contains
the keyword. Names only — file contents are never read.

Matches include files, directories and symlinks; symlinks are reported but never
followed, so a link cannot pull the walk outside the tree. The volume trash
(".trash") is skipped: deleted-but-retained entries are not search results.

A directory that cannot be read is recorded in "errors" and skipped; it does not
abort the search. "scanned" counts real entries visited (the synthesized "."
and ".." entries are not counted).

The walk reads metadata only: no data plane scan, and no quota needs to be set.

Output is a single line of JSON so callers can parse it directly.

Examples:
$ juicefs find redis://localhost --name raw
$ juicefs find redis://localhost /photos --name .dng
$ juicefs find redis://localhost / --name 整理 --limit 100`,
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:     "name",
				Usage:    "substring matched against entry names (required)",
				Required: true,
			},
			&cli.BoolFlag{
				Name:  "case-sensitive",
				Usage: "match case-sensitively (default: case-insensitive)",
			},
			&cli.Uint64Flag{
				Name:  "limit",
				Usage: "stop after this many matches; 0 means unlimited",
			},
		},
	}
}

// dirReader 是遍历需要的最小元数据接头。meta.Meta 满足它；测试注入假目录树，
// 不必起真实元数据服务（与 unflag.go 的 flagSetter 同一动机）。
type dirReader interface {
	Readdir(ctx meta.Context, inode meta.Ino, wantattr uint8, entries *[]*meta.Entry) syscall.Errno
}

func findPaths(c *cli.Context) error {
	setup0(c, 1, 0)
	metaURL := c.Args().Get(0)
	roots := c.Args().Slice()[1:]
	if len(roots) == 0 {
		roots = []string{"/"}
	}
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
	res := searchResult{Keyword: c.String("name"), Matches: make([]searchMatch, 0)}
	caseSensitive := c.Bool("case-sensitive")
	limit := c.Uint64("limit")
	for _, root := range roots {
		inode, _, err := lookupPathAttr(m, ctx, root)
		if err != nil {
			res.Errors = append(res.Errors, searchError{Path: normalizeVolumePath(root), Error: err.Error()})
			continue
		}
		if walkFind(m, ctx, inode, normalizeVolumePath(root), res.Keyword, caseSensitive, limit, &res) {
			break
		}
	}

	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(res)
}

// walkFind 从 rootInode 起做广度优先遍历，把名字含 keyword 的条目收进 res。
// 返回 true 表示命中数已达 limit、调用方应停止处理后续根。
//
// 广度优先而不是递归：深度由用户的数据决定，递归会耗尽栈。
func walkFind(r dirReader, ctx meta.Context, rootInode meta.Ino, rootPath, keyword string, caseSensitive bool, limit uint64, res *searchResult) bool {
	type pending struct {
		inode meta.Ino
		path  string
	}
	queue := []pending{{inode: rootInode, path: rootPath}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		var entries []*meta.Entry
		if st := r.Readdir(ctx, cur.inode, 1, &entries); st != 0 {
			res.Errors = append(res.Errors, searchError{Path: cur.path, Error: st.Error()})
			continue
		}
		for _, e := range entries {
			if e == nil || e.Attr == nil {
				continue
			}
			name := string(e.Name)
			// "." 与 ".." 是 Readdir 自己合成的（base.go:1776-1785），不是真实条目。
			// 必须按名字跳过：".." 落入队列会让遍历在父子之间来回打转。
			if name == "." || name == ".." {
				continue
			}
			// 回收站子树整体跳过：.trash 与它下面的 subTrash，inode 都 >= TrashInode。
			// 已删除但留档的内容不该出现在检索结果里。
			if e.Inode.IsTrash() {
				continue
			}
			res.Scanned++
			childPath := normalizeVolumePath(cur.path + "/" + name)
			if matchName(name, keyword, caseSensitive) {
				res.Matches = append(res.Matches, searchMatchOf(childPath, name, e))
				if limit > 0 && uint64(len(res.Matches)) >= limit {
					res.Truncated = true
					return true
				}
			}
			// 只下钻真实目录：symlink 的 Typ 不是 TypeDirectory，因此不会被跟随，
			// 环与越界都进不来。
			if e.Attr.Typ == meta.TypeDirectory {
				queue = append(queue, pending{inode: e.Inode, path: childPath})
			}
		}
	}
	return false
}

// matchName 判断条目名是否含关键词（子串，默认大小写不敏感）。
// 关键词里的 "*"、"?" 一律是普通字符——这是关键词检索，不是 glob。
func matchName(name, keyword string, caseSensitive bool) bool {
	if caseSensitive {
		return strings.Contains(name, keyword)
	}
	return strings.Contains(strings.ToLower(name), strings.ToLower(keyword))
}

func searchMatchOf(p, name string, e *meta.Entry) searchMatch {
	return searchMatch{
		Path:      p,
		Name:      name,
		Type:      statTypeString(e.Attr.Typ),
		Size:      e.Attr.Length,
		Mtime:     e.Attr.Mtime,
		Mtimensec: e.Attr.Mtimensec,
	}
}
