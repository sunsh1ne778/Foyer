# 跨文件夹深度关键词检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户输入一个关键词，跨**所有挂载**、递归地按名称找出文件与目录，并在文件列表区域展示可跳转的结果。

**Architecture:** 复用既有 overlay → Runner → HTTP → 前端四层，不引入第二真源。`overlays/juicefs/cmd/find.go` 新增 `juicefs find`，用 `meta.Meta.Readdir`（`wantattr=1`）广度优先遍历元数据树，按 entry 名子串匹配，输出单行 JSON。`server/internal/foyer` 包成 `Runner.Search` 与 `GET /foyer/search`。`web/src` 新增 `foyerSearch` 取数、`api/search.ts` 纯函数（卷内路径 → 挂载归属、分页），并把 `FileExplorer` 的列表区域切换为结果视图。

**Tech Stack:** Go 1.25（server）、Go 1.23（juicefs overlay，CGO）、React 19 + TypeScript + vitest（web）、Docker Compose。

## Global Constraints

- 只做**文件名/目录名**检索（子串），**不读文件内容**、不做全文索引。
- 不建 PostgreSQL 索引、不对账：JuiceFS 元数据是唯一真源（沿用 `docs/superpowers/plans/2026-09-18-juicefs-distro.md` 的约束）。
- 不重写 VFS、不改 FUSE、不改 juicefs 内核行为。
- **平台隔离**：`server` 与 `web` 的测试在本机（Windows）跑；overlay 测试只能在 Linux 容器里跑——`third_party/juicefs` 的 `cmd` 包在 Windows 编译不了（`CGO_ENABLED=0` 时 sqlite3/lz4/zstd 的 build constraints 排除全部文件）。统一用 Docker `golang:1.23-bookworm` + `gcc` + `libfuse3-dev` + `CGO_ENABLED=1`，并挂 `foyer-gomodcache`/`foyer-gocache` 两个卷复用缓存。
- 本机 `bash` 指向未配置的 WSL，`sh` 不可用。overlay 用 `scripts/apply-juicefs-overlay.ps1` 落地，`.sh` 版本同步维护（`deploy/foyer/Dockerfile` 构建期用的是 `.sh`）。
- `third_party/juicefs` 是 **git submodule**：其中的改动不被父仓库跟踪，`overlays/juicefs` 才是真源。**绝不**手工编辑 `third_party/juicefs` 下的文件。
- `meta.Meta.Readdir` 会把 `.` 与 `..` **合成进结果**（`third_party/juicefs/pkg/meta/base.go:1776-1785`）。遍历时必须按名字跳过：否则 `..` 会让遍历在父子之间来回打转。
- 回收站条目（`.trash` 及其 subTrash）的 inode `>= meta.TrashInode`（`pkg/meta/interface.go:118`），必须跳过：已删除但留档的内容不该出现在检索结果里。
- 只跟随真实目录（`Attr.Typ == meta.TypeDirectory`）；symlink 不跟随（防环、防越界）。
- 结果**默认完整返回**，不做常规截断。`FOYER_SEARCH_MAX_RESULTS`（默认 `0` = 不限）只是安全阀，不是分页机制。
- 前端 query 一律用 `URLSearchParams` 构造，禁止手工拼串——路径里的 `#` 会被下游读成 fragment 并截断。
- 前端依赖**不新增**：仓库没有虚拟滚动库，分页用纯函数切片实现。
- 前端 vitest 为 node 环境且只 include `src/**/*.test.ts`（`web/vite.config.ts` 的 `test.include`），组件无 DOM 测试；能测的只有纯函数。这是既定约束，**不要**试图引入 jsdom 或 `*.test.tsx`。
- 控制面 8092 端口当前无鉴权，与既有 `/foyer/stat`、`/foyer/usage` 一致；本计划不新增鉴权。
- 新配置项一律走环境变量，不硬编码。

---

### Task 1: overlay 新增 `juicefs find` 命令

**Files:**
- Create: `overlays/juicefs/cmd/find.go`
- Create: `overlays/juicefs/cmd/find_test.go`
- Modify: `scripts/apply-juicefs-overlay.ps1`（拷贝 + 注册进 `main.go` 的 `Commands`）
- Modify: `scripts/apply-juicefs-overlay.sh`（同上，Dockerfile 构建期用）

**Interfaces:**
- Consumes: `overlays/juicefs/cmd/stat.go` 里已有的 `lookupPathAttr(m, ctx, p) (meta.Ino, meta.Attr, error)`、`normalizeVolumePath(p string) string`、`statTypeString(typ uint8) string`；`third_party/juicefs/cmd/main.go` 的 `setup0(c, min, max int)` 与 `removePassword(uris ...string)`。
- Produces: 命令 `juicefs find META-URL [PATH...] --name KW [--case-sensitive] [--limit N]`，stdout 一行 JSON，形状见下方 `searchResult`。字段名即接口，server 侧按名解析。

- [ ] **Step 1: 写失败测试**

创建 `overlays/juicefs/cmd/find_test.go`：

```go
package cmd

import (
	"encoding/json"
	"syscall"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

// ent 造一个带属性的条目：Attr 必须非 nil，遍历靠 Attr.Typ 判断能否下钻。
func ent(inode meta.Ino, name string, typ uint8, size uint64, mtime int64) *meta.Entry {
	return &meta.Entry{
		Inode: inode,
		Name:  []byte(name),
		Attr:  &meta.Attr{Typ: typ, Length: size, Mtime: mtime},
	}
}

// fakeReader 用一张 inode -> 子条目 的表假冒元数据引擎。
//
// visits 记录每个 inode 被读了几次：同一目录被读第二次说明遍历没跳过合成的
// ".."（它会指回父目录），此时直接返回 EIO —— 把「死循环」变成一次明确的失败，
// 而不是让测试挂住。
type fakeReader struct {
	kids   map[meta.Ino][]*meta.Entry
	errs   map[meta.Ino]syscall.Errno
	visits map[meta.Ino]int
}

func newFakeReader() *fakeReader {
	return &fakeReader{
		kids:   map[meta.Ino][]*meta.Entry{},
		errs:   map[meta.Ino]syscall.Errno{},
		visits: map[meta.Ino]int{},
	}
}

func (f *fakeReader) set(inode meta.Ino, entries ...*meta.Entry) {
	f.kids[inode] = entries
}

func (f *fakeReader) Readdir(_ meta.Context, inode meta.Ino, _ uint8, entries *[]*meta.Entry) syscall.Errno {
	f.visits[inode]++
	if f.visits[inode] > 1 {
		return syscall.EIO
	}
	if st, ok := f.errs[inode]; ok {
		return st
	}
	kids, ok := f.kids[inode]
	if !ok {
		return syscall.ENOENT
	}
	// 真实现总会把 "." 和 ".." 合成进结果，假实现必须照做，
	// 否则测不到「按名字跳过」这条关键规则。
	*entries = append(*entries, ent(inode, ".", meta.TypeDirectory, 4096, 0))
	var parent meta.Ino = meta.RootInode
	*entries = append(*entries, ent(parent, "..", meta.TypeDirectory, 4096, 0))
	*entries = append(*entries, kids...)
	return 0
}

func runFind(f *fakeReader, root meta.Ino, rootPath, keyword string, caseSensitive bool, limit uint64) searchResult {
	res := searchResult{Keyword: keyword, Matches: make([]searchMatch, 0)}
	walkFind(f, meta.Background(), root, rootPath, keyword, caseSensitive, limit, &res)
	return res
}

func TestMatchNameIsCaseInsensitiveByDefault(t *testing.T) {
	if !matchName("Raw", "raw", false) {
		t.Fatal("默认应大小写不敏感")
	}
	if matchName("Raw", "raw", true) {
		t.Fatal("开了 --case-sensitive 就该区分大小写")
	}
	if !matchName("和raw和", "raw", false) {
		t.Fatal("应做子串匹配，不要求整名相等")
	}
	if !matchName(".dng", ".dng", true) {
		t.Fatal("后缀关键词应命中")
	}
	// 这是关键词检索，不是 glob：* 与 ? 是普通字符。
	if matchName("abc", "a*", false) {
		t.Fatal("* 必须是普通字符")
	}
	if !matchName("a*c", "a*", false) {
		t.Fatal("字面 * 应能被匹配到")
	}
	if !matchName("中文目录名-2026", "2026", false) {
		t.Fatal("CJK 与数字混排应命中")
	}
}

// "." 与 ".." 是 Readdir 合成的，不是真实条目：既不能进结果，也不能进队列
// （".." 会指回父目录）。fakeReader 的重复访问守卫把漏跳变成 EIO 错误。
func TestWalkFindSkipsDotAndDotDot(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "raw", meta.TypeDirectory, 4096, 100),
	)
	// 子条目名刻意不含 "."，否则关键词 "." 会命中它，让下面的 len==0 断言不成立。
	f.set(10, ent(11, "notes", meta.TypeFile, 24576, 101))

	res := runFind(f, meta.RootInode, "/", ".", false, 0)
	if len(res.Matches) != 0 {
		t.Fatalf("关键词 \".\" 不应命中合成的 . / ..: %+v", res.Matches)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("不应有错误（EIO 表示遍历在父子之间打转）: %+v", res.Errors)
	}
	// raw 与 notes 两个真实条目；"." 和 ".." 各出现两次不计。
	if res.Scanned != 2 {
		t.Fatalf("scanned = %d, want 2（只数真实条目）", res.Scanned)
	}
}

func TestWalkFindRecursesAndReportsPathsAndTypes(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "av_20260619", meta.TypeDirectory, 4096, 100),
		ent(20, "unrelated", meta.TypeFile, 1, 101),
	)
	f.set(10,
		ent(11, "raw", meta.TypeDirectory, 4096, 200),
		ent(12, "raw-notes.txt", meta.TypeFile, 512, 201),
	)
	f.set(11, ent(13, "a.RAW", meta.TypeFile, 24576, 300))

	res := runFind(f, meta.RootInode, "/", "raw", false, 0)
	if res.Truncated {
		t.Fatal("未设 limit 时不应截断")
	}
	if len(res.Errors) != 0 {
		t.Fatalf("不应有错误: %+v", res.Errors)
	}
	got := map[string]searchMatch{}
	for _, m := range res.Matches {
		got[m.Path] = m
	}
	if len(got) != 3 {
		t.Fatalf("want 3 matches, got %d: %+v", len(got), res.Matches)
	}
	dir, ok := got["/av_20260619/raw"]
	if !ok || dir.Type != "directory" || dir.Name != "raw" {
		t.Fatalf("目录命中缺形状: %+v", got)
	}
	txt, ok := got["/av_20260619/raw-notes.txt"]
	if !ok || txt.Type != "file" || txt.Size != 512 || txt.Mtime != 201 {
		t.Fatalf("文件命中缺形状: %+v", got)
	}
	if _, ok := got["/av_20260619/raw/a.RAW"]; !ok {
		t.Fatalf("深层命中缺失（大小写不敏感）: %+v", got)
	}
}

// 只跟随真实目录：symlink 本身能被命中，但它的目标子树不能进来（防环/防越界）。
func TestWalkFindReportsSymlinkButDoesNotFollowIt(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "link-raw", meta.TypeSymlink, 4096, 100),
	)
	// inode 10 底下放一个**也含关键词**的子条目：若遍历跟随了 symlink，
	// 它会被读到并多出一条命中。只断言「命中数 == 1」是不够的——
	// 那个子条目必须能匹配，断言才有鉴别力。
	f.set(10, ent(11, "raw-inside-loop", meta.TypeFile, 1, 1))

	res := runFind(f, meta.RootInode, "/", "raw", false, 0)
	if len(res.Matches) != 1 {
		t.Fatalf("只应命中 symlink 自身；多出命中说明下钻了 symlink: %+v", res.Matches)
	}
	if res.Matches[0].Name != "link-raw" || res.Matches[0].Type != "symlink" {
		t.Fatalf("symlink 本身应被命中且类型为 symlink: %+v", res.Matches[0])
	}
	// 不下钻也意味着不会把它当目录去 Readdir。
	if res.Scanned != 1 {
		t.Fatalf("scanned = %d, want 1（只看到 link-raw 一个条目）", res.Scanned)
	}
}

func TestWalkFindSkipsTrashSubtree(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(meta.TrashInode, ".trash", meta.TypeDirectory, 4096, 0),
		ent(10, "raw", meta.TypeDirectory, 4096, 100),
	)
	// 回收站里的同名目录绝不能进结果，也不该被下钻。
	f.set(meta.TrashInode, ent(11, "raw", meta.TypeDirectory, 4096, 0))
	f.set(10, ent(12, "keep-raw.txt", meta.TypeFile, 1, 0))

	res := runFind(f, meta.RootInode, "/", "raw", false, 0)
	if len(res.Matches) != 2 {
		t.Fatalf("want 2（/raw 与 /raw/keep-raw.txt）, got %+v", res.Matches)
	}
	for _, m := range res.Matches {
		if m.Path == "/.trash/raw" || m.Path == "/.trash" {
			t.Fatalf("回收站内容不得出现在结果里: %+v", m)
		}
	}
}

func TestWalkFindRecordsReaddirErrorAndContinues(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "bad", meta.TypeDirectory, 4096, 0),
		ent(20, "raw-ok.txt", meta.TypeFile, 1, 0),
	)
	f.errs[10] = syscall.EIO

	res := runFind(f, meta.RootInode, "/", "raw", false, 0)
	if len(res.Matches) != 1 || res.Matches[0].Path != "/raw-ok.txt" {
		t.Fatalf("一棵子树失败不应中断检索: %+v", res.Matches)
	}
	if len(res.Errors) != 1 || res.Errors[0].Path != "/bad" {
		t.Fatalf("失败必须记账到出错的那层路径: %+v", res.Errors)
	}
}

func TestWalkFindTruncatesAtLimit(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "raw1", meta.TypeFile, 1, 0),
		ent(11, "raw2", meta.TypeFile, 1, 0),
		ent(12, "raw3", meta.TypeFile, 1, 0),
	)

	res := runFind(f, meta.RootInode, "/", "raw", false, 2)
	if !res.Truncated {
		t.Fatal("达到 limit 必须置 truncated")
	}
	if len(res.Matches) != 2 {
		t.Fatalf("want 2 matches, got %d: %+v", len(res.Matches), res.Matches)
	}
}

// scanned 必须只数真实条目：把合成的 . / .. 也算进去会让「已扫描 N 项」虚高一倍。
func TestWalkFindScannedCountsRealEntriesOnly(t *testing.T) {
	f := newFakeReader()
	f.set(meta.RootInode,
		ent(10, "d", meta.TypeDirectory, 4096, 0),
		ent(11, "f", meta.TypeFile, 1, 0),
	)
	f.set(10, ent(12, "g", meta.TypeFile, 1, 0))

	res := runFind(f, meta.RootInode, "/", "zzz-no-match", false, 0)
	if res.Scanned != 3 {
		t.Fatalf("scanned = %d, want 3", res.Scanned)
	}
}

func TestSearchResultJSONKeysAreStable(t *testing.T) {
	b, err := json.Marshal(searchResult{
		Keyword: "raw",
		Matches: []searchMatch{searchMatchOf("/photos/raw", "raw", ent(1, "raw", meta.TypeDirectory, 4096, 100))},
		Scanned: 42,
		Errors:  []searchError{{Path: "/broken", Error: "readdir: EIO"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	// 键名是跨任务解析契约，拼错也能编译通过，必须逐个钉住。
	for _, k := range []string{"keyword", "matches", "scanned", "truncated", "errors"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %s", k, b)
		}
	}
	var matches []map[string]json.RawMessage
	if err := json.Unmarshal(m["matches"], &matches); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"path", "name", "type", "size", "mtime", "mtimensec"} {
		if _, ok := matches[0][k]; !ok {
			t.Fatalf("missing matches key %q in %s", k, b)
		}
	}
	var errs []map[string]json.RawMessage
	if err := json.Unmarshal(m["errors"], &errs); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"path", "error"} {
		if _, ok := errs[0][k]; !ok {
			t.Fatalf("missing errors key %q in %s", k, b)
		}
	}
	// errors 是 omitempty：无错误时该键整体缺席，消费方据此区分「干净」与「有失败」。
	clean, err := json.Marshal(searchResult{Keyword: "x", Matches: []searchMatch{}, Scanned: 1})
	if err != nil {
		t.Fatal(err)
	}
	var cleanMap map[string]json.RawMessage
	if err := json.Unmarshal(clean, &cleanMap); err != nil {
		t.Fatal(err)
	}
	if _, ok := cleanMap["errors"]; ok {
		t.Fatalf("无错误时不应带 errors 键: %s", clean)
	}
}
```

- [ ] **Step 2: 运行测试确认失败（RED）**

overlay 目录不是独立 module，只能先把它当补丁打进 `third_party/juicefs` 做一次红：**只拷测试文件，不拷实现**。

本机 `sh` 指向未配置的 WSL，用 PowerShell 直接拷；`third_party/juicefs` 的 cmd 包在 Windows 编译不了，所以测试一律在 Linux 容器里跑：

```powershell
Copy-Item overlays/juicefs/cmd/find_test.go third_party/juicefs/cmd/find_test.go -Force
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go test ./cmd/ -run 'TestMatchName|TestWalkFind|TestSearchResultJSONKeys' -count=1"
```

Expected: 编译失败 —— `undefined: matchName`、`undefined: walkFind`、`undefined: searchResult`。这就是实现缺失的证据（不是笔误造成的失败）。

> 首次运行 apt-get + 依赖下载约 1–3 分钟；`foyer-gomodcache`/`foyer-gocache` 两个卷会让后续运行快很多。

- [ ] **Step 3: 写最小实现**

创建 `overlays/juicefs/cmd/find.go`：

```go
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
```

- [ ] **Step 4: 在两个 apply 脚本里注册命令**

先改脚本再应用：apply 脚本负责拷贝 `find.go` 并把 `cmdFind()` 注册进 `main.go`，不先改脚本就应用，命令不会被注册。

修改 `scripts/apply-juicefs-overlay.ps1`（本机实际使用的是这个），在 `cmd\unflag_test.go` 那两行之后追加：

```powershell
Copy-Item -Path (Join-Path $src "cmd\find.go") -Destination (Join-Path $dst "cmd\find.go") -Force
Copy-Item -Path (Join-Path $src "cmd\find_test.go") -Destination (Join-Path $dst "cmd\find_test.go") -Force
```

并在 `[IO.File]::WriteAllText($main, $m, $utf8)` **之前**追加（`$m` 是累积变量，顺序不能颠倒；锚点选 `cmdUnflag()` 因为它是既有脚本里最后插入的一项，位置确定）：

```powershell
if ($m -notmatch 'cmdFind\(\),') {
  $m2 = [regex]::Replace($m, '\t\t\tcmdUnflag\(\),\r?\n', "`t`t`tcmdUnflag(),`n`t`t`tcmdFind(),`n", 1)
  if ($m2 -eq $m) { throw "main.go cmdUnflag() hook site not found" }
  $m = $m2
}
```

同步修改 `scripts/apply-juicefs-overlay.sh`（Dockerfile 构建期用的是这个）。在文件拷贝段追加两行：

```sh
cp "$SRC/cmd/find.go" "$DST/cmd/find.go"
cp "$SRC/cmd/find_test.go" "$DST/cmd/find_test.go"
```

在 heredoc 的 python 段，`cmdUsage()` 注册之后追加：

```python
if "cmdFind()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdUnflag\(\),\r?\n", "\t\t\tcmdUnflag(),\n\t\t\tcmdFind(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdUnflag() hook site not found")
    changed = True
```

- [ ] **Step 5: 应用 overlay 并在容器里跑测试（GREEN）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-juicefs-overlay.ps1
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go test ./cmd/ -run 'TestMatchName|TestWalkFind|TestSearchResultJSONKeys' -count=1 -v"
```

Expected: PASS（9 个测试）。同时确认注册生效：

```powershell
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go build -o /tmp/juicefs-find . && /tmp/juicefs-find find --help"
```

Expected: 输出 `find` 的 NAME/USAGE/ARGS 段并列出 `--name`、`--case-sensitive`、`--limit`，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add overlays/juicefs/cmd/find.go overlays/juicefs/cmd/find_test.go scripts/apply-juicefs-overlay.sh scripts/apply-juicefs-overlay.ps1
git commit -m "feat(juicefs): add find command walking metadata by name"
```

---

### Task 2: server 侧 `Runner.Search`

**Files:**
- Create: `server/internal/foyer/search.go`
- Create: `server/internal/foyer/search_test.go`
- Modify: `server/internal/foyer/exec_test.go`（给 `writeFakeJuice` 增加 `find` 分支）

**Interfaces:**
- Consumes: Task 1 的 `juicefs find` JSON；`server/internal/foyer/import.go` 的 `parseJSONLine[T](text string) (T, error)`、`truncate(s string, n int) string`；`server/internal/foyer/exec.go` 的 `Runner.cmd`、`lastLine`。
- Produces: `SearchArgs(cfg Config, root, keyword string, caseSensitive bool, limit uint64) []string`、`(Runner) Search(cfg Config, root, keyword string, caseSensitive bool, limit uint64) (SearchResult, error)`、`parseSearch(text string) (SearchResult, error)`、`BuildSearchResponse(res SearchResult) SearchResponse`、类型 `SearchResult`/`SearchMatch`/`SearchFailure`/`SearchResponse`。

- [ ] **Step 1: 写失败测试**

创建 `server/internal/foyer/search_test.go`：

```go
package foyer

import (
	"strings"
	"testing"
)

func TestSearchArgsDefaultsRootAndOmitsZeroLimit(t *testing.T) {
	got := strings.Join(SearchArgs(Config{MetaURL: "redis://redis:6379/1"}, "", "raw", false, 0), " ")
	if got != "find redis://redis:6379/1 / --name raw" {
		t.Fatalf("got %q", got)
	}
	// 显式 root、大小写敏感、非零 limit 都要原样下发。
	got = strings.Join(SearchArgs(Config{MetaURL: "redis://x"}, "/photos", "整理", true, 100), " ")
	want := "find redis://x /photos --name 整理 --case-sensitive --limit 100"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	// 空白 root 视同缺省，不能下发成空参数（那会让 juicefs 把下一个参数当 root）。
	got = strings.Join(SearchArgs(Config{MetaURL: "redis://x"}, "   ", "raw", false, 0), " ")
	if got != "find redis://x / --name raw" {
		t.Fatalf("got %q", got)
	}
}

func TestParseSearchSkipsLogLines(t *testing.T) {
	text := "2026/09/19 08:33:31 juicefs[656] <INFO>: Ping redis latency: 51.779µs\n" +
		`{"keyword":"raw","matches":[{"path":"/photos/raw","name":"raw","type":"directory","size":4096,"mtime":1777690800,"mtimensec":7}],` +
		`"scanned":42,"truncated":false}` + "\n"
	got, err := parseSearch(text)
	if err != nil {
		t.Fatal(err)
	}
	if got.Keyword != "raw" || got.Scanned != 42 || got.Truncated {
		t.Fatalf("%+v", got)
	}
	if len(got.Matches) != 1 {
		t.Fatalf("%+v", got.Matches)
	}
	m := got.Matches[0]
	if m.Path != "/photos/raw" || m.Name != "raw" || m.Type != "directory" || m.Mtimensec != 7 {
		t.Fatalf("%+v", m)
	}
	if got.Errors != nil {
		t.Fatalf("无错误时应保持 nil: %+v", got.Errors)
	}
}

func TestParseSearchFailsWithoutJSON(t *testing.T) {
	if _, err := parseSearch("lookup nope: no such file or directory"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunnerSearchParsesFakeBin(t *testing.T) {
	r := Runner{Bin: writeFakeJuice(t, true)}
	res, err := r.Search(Config{MetaURL: "redis://x"}, "/", "raw", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Keyword != "raw" || res.Scanned != 42 {
		t.Fatalf("%+v", res)
	}
	if len(res.Matches) != 2 || res.Matches[0].Path != "/photos/raw" || res.Matches[1].Name != "a.dng" {
		t.Fatalf("%+v", res.Matches)
	}
}

func TestRunnerSearchReportsNonZeroExit(t *testing.T) {
	bin := writeFakeImport(t, "FATAL: cannot connect to redis", 1)
	r := Runner{Bin: bin}
	_, err := r.Search(Config{MetaURL: "redis://x"}, "/", "raw", false, 0)
	if err == nil || !strings.Contains(err.Error(), "cannot connect to redis") {
		t.Fatalf("got %v", err)
	}
}

func TestRunnerSearchFailsWithoutJSON(t *testing.T) {
	bin := writeFakeImport(t, "searched 0 entries", 0)
	r := Runner{Bin: bin}
	_, err := r.Search(Config{MetaURL: "redis://x"}, "/", "raw", false, 0)
	if err == nil || !strings.Contains(err.Error(), "no JSON search") {
		t.Fatalf("got %v", err)
	}
}

// matches 为空时 API 载荷必须给空数组而不是 null：前端按数组消费。
func TestBuildSearchResponseNeverEmitsNullMatches(t *testing.T) {
	got := BuildSearchResponse(SearchResult{Keyword: "raw"})
	if !got.OK {
		t.Fatal("ok 必须为真")
	}
	if got.Matches == nil {
		t.Fatal("matches 不得为 nil")
	}
	if len(got.Matches) != 0 {
		t.Fatalf("%+v", got.Matches)
	}
	// errors 刻意透传（含 nil）：它是 omitempty，让「干净」与「有失败」可区分。
	if got.Errors != nil {
		t.Fatalf("errors 应保持 nil: %+v", got.Errors)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestSearchArgs|TestParseSearch|TestRunnerSearch|TestBuildSearchResponse' -v`
Expected: 编译失败 —— `undefined: SearchArgs`、`undefined: parseSearch`、`undefined: SearchResult`、`undefined: BuildSearchResponse`。

- [ ] **Step 3: 写最小实现**

创建 `server/internal/foyer/search.go`：

```go
package foyer

import (
	"fmt"
	"strconv"
	"strings"
)

// SearchResult mirrors the JSON printed by `juicefs find` (overlays/juicefs/cmd/find.go).
type SearchResult struct {
	Keyword   string          `json:"keyword"`
	Matches   []SearchMatch   `json:"matches"`
	Scanned   uint64          `json:"scanned"`
	Truncated bool            `json:"truncated"`
	Errors    []SearchFailure `json:"errors,omitempty"`
}

// SearchMatch 是一条命中；Path 是卷内绝对路径，Name 是最后一段。
// Size 对目录是元数据长度（通常 4096），与 `juicefs stat` 同口径。
type SearchMatch struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Size      uint64 `json:"size"`
	Mtime     int64  `json:"mtime"`
	Mtimensec uint32 `json:"mtimensec"`
}

// SearchFailure 记一棵读失败的子树；整体检索仍然是成功的。
type SearchFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// SearchResponse 是 GET /foyer/search 的载荷：CLI 结果外加 ok 标记。
type SearchResponse struct {
	OK        bool            `json:"ok"`
	Keyword   string          `json:"keyword"`
	Matches   []SearchMatch   `json:"matches"`
	Scanned   uint64          `json:"scanned"`
	Truncated bool            `json:"truncated"`
	Errors    []SearchFailure `json:"errors,omitempty"`
}

// SearchArgs builds `juicefs find META PATH --name KW [--case-sensitive] [--limit N]`.
// root 为空时用 "/"；limit 为 0 时不下发 --limit（=`juicefs find` 的不限语义）。
//
// juicefs 的 main.go 会用 reorderOptions 把命令级 flag 提到位置参数之前，
// 所以这里的参数顺序（先把 META 与 PATH 放前面）是安全的。
func SearchArgs(cfg Config, root, keyword string, caseSensitive bool, limit uint64) []string {
	root = strings.TrimSpace(root)
	if root == "" {
		root = "/"
	}
	args := []string{"find", cfg.MetaURL, root, "--name", keyword}
	if caseSensitive {
		args = append(args, "--case-sensitive")
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.FormatUint(limit, 10))
	}
	return args
}

func (r Runner) Search(cfg Config, root, keyword string, caseSensitive bool, limit uint64) (SearchResult, error) {
	c := r.cmd(SearchArgs(cfg, root, keyword, caseSensitive, limit)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return SearchResult{}, fmt.Errorf("juicefs find: %s", lastLine(msg))
		}
		return SearchResult{}, fmt.Errorf("juicefs find: %w", err)
	}
	res, perr := parseSearch(text)
	if perr != nil {
		return SearchResult{}, fmt.Errorf("juicefs find: %w", perr)
	}
	return res, nil
}

func parseSearch(text string) (SearchResult, error) {
	res, err := parseJSONLine[SearchResult](text)
	if err != nil {
		return SearchResult{}, fmt.Errorf("no JSON search in juicefs output: %s", truncate(text, 200))
	}
	return res, nil
}

// BuildSearchResponse 把 CLI 结果包成 API 载荷。纯函数：唯一的加工是确保
// matches 不为 null（前端按数组消费）。Errors 刻意原样透传——它是 omitempty，
// 「缺席」表示这次检索没有子树失败，消费方据此区分干净与有失败。
func BuildSearchResponse(res SearchResult) SearchResponse {
	out := SearchResponse{
		OK:        true,
		Keyword:   res.Keyword,
		Matches:   res.Matches,
		Scanned:   res.Scanned,
		Truncated: res.Truncated,
		Errors:    res.Errors,
	}
	if out.Matches == nil {
		out.Matches = []SearchMatch{}
	}
	return out
}
```

- [ ] **Step 4: 给 fake juicefs 增加 `find` 分支**

修改 `server/internal/foyer/exec_test.go` 的 `writeFakeJuice`。`find` 回一份固定的 JSON（2 条命中、`scanned=42`），让 `TestRunnerSearchParsesFakeBin` 的断言稳定。

POSIX 分支在 `usage` 那行之后插入：

```go
	script += "if [ \"$1\" = find ]; then printf '%s\\n' '{\"keyword\":\"raw\",\"matches\":[{\"path\":\"/photos/raw\",\"name\":\"raw\",\"type\":\"directory\",\"size\":4096,\"mtime\":1777690800,\"mtimensec\":0},{\"path\":\"/photos/raw/a.dng\",\"name\":\"a.dng\",\"type\":\"file\",\"size\":24576,\"mtime\":1777690801,\"mtimensec\":0}],\"scanned\":42,\"truncated\":false}'; exit 0; fi\n"
```

Windows 分支在 `case "usage":` 之后插入。**必须用转义的双引号字符串，不能用反引号 raw string**：这段代码是内联进 `writeFakeJuiceGo` 的 `src := \`package main...\`` 里的，嵌套反引号会提前终止外层 raw string 并让整个文件编译不过。既有 `import`/`stat`/`usage` 三个 case 也都是转义双引号写法，照它们来：

```go
	case "find":
		fmt.Println("{\"keyword\":\"raw\",\"matches\":[{\"path\":\"/photos/raw\",\"name\":\"raw\",\"type\":\"directory\",\"size\":4096,\"mtime\":1777690800,\"mtimensec\":0},{\"path\":\"/photos/raw/a.dng\",\"name\":\"a.dng\",\"type\":\"file\",\"size\":24576,\"mtime\":1777690801,\"mtimensec\":0}],\"scanned\":42,\"truncated\":false}")
		os.Exit(0)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && go test ./internal/foyer/ -run 'TestSearchArgs|TestParseSearch|TestRunnerSearch|TestBuildSearchResponse' -v`
Expected: PASS（7 个测试）。再跑全包确认没回归：

Run: `cd server && go test ./internal/foyer/`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add server/internal/foyer/search.go server/internal/foyer/search_test.go server/internal/foyer/exec_test.go
git commit -m "feat(foyer): parse juicefs find into Runner.Search"
```

---

### Task 3: `GET /foyer/search` 端点与上限配置

**Files:**
- Modify: `server/internal/foyer/health.go`（注册 `/foyer/search`）
- Modify: `server/internal/foyer/config.go`（`SearchMaxResults` + `envUint64`）
- Modify: `server/internal/foyer/search_test.go`（新增 handler 测试）
- Modify: `deploy/compose.yml`

**Interfaces:**
- Consumes: Task 2 的 `Runner.Search`、`BuildSearchResponse`、`SearchResponse`。
- Produces: `GET /foyer/search?q=<kw>[&path=/][&case=1]` → Task 2 的 `SearchResponse` JSON；`Config.SearchMaxResults`（`FOYER_SEARCH_MAX_RESULTS`，默认 0）。

- [ ] **Step 1: 写失败测试**

在 `server/internal/foyer/search_test.go` 里，先把文件顶部的 import 段整体替换为（`strings`/`testing` 已在，新增三个）：

```go
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)
```

然后在文件末尾追加这四条 handler 测试：

```go
func TestSearchRouteRejectsMissingQuery(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)
	for _, target := range []string{"/foyer/search", "/foyer/search?q=", "/foyer/search?q=%20%20"} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, target, nil))
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d: %s", target, rr.Code, rr.Body.String())
		}
	}
}

func TestSearchRouteRejectsNonGet(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/search?q=raw", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rr.Code)
	}
	if allow := rr.Header().Get("Allow"); allow != "GET" {
		t.Fatalf("Allow = %q, want GET", allow)
	}
}

func TestSearchRouteReturnsMatches(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/search?q=raw&path=/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got SearchResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Keyword != "raw" || got.Scanned != 42 || got.Truncated {
		t.Fatalf("%+v", got)
	}
	if len(got.Matches) != 2 || got.Matches[0].Path != "/photos/raw" || got.Matches[1].Name != "a.dng" {
		t.Fatalf("matches: %+v", got.Matches)
	}
	// 空 errors 必须序列化成「键缺席」，不是 null：前端据此区分干净与有失败。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["errors"]; ok {
		t.Fatalf("无错误时不应带 errors 键: %s", rr.Body.String())
	}
}

// path 缺省必须能正常工作：前端固定从卷根遍历，一次覆盖所有挂载。
func TestSearchRouteWorksWithoutPath(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/search?q=raw", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got SearchResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Keyword != "raw" || len(got.Matches) != 2 {
		t.Fatalf("%+v", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestSearchRoute' -v`
Expected: FAIL —— `/foyer/search` 尚未注册，三条路由测试都拿到 `404`，断言 `400`/`405`/`200` 均不成立。这就是端点缺失的证据。

- [ ] **Step 3: 注册 `/foyer/search`**

修改 `server/internal/foyer/health.go`，在 `/foyer/usage` handler 的收尾 `})` 之后、`mux.HandleFunc("/foyer/browse"` 之前插入。`run` 与 `cfg` 都是 `NewHealthMux` 里已有的局部/参数，直接可用：

```go
	mux.HandleFunc("/foyer/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		keyword := strings.TrimSpace(r.URL.Query().Get("q"))
		if keyword == "" {
			http.Error(w, "q required", http.StatusBadRequest)
			return
		}
		// path 缺省由 SearchArgs 收敛成 "/"：从卷根遍历一次即覆盖所有挂载，
		// 天然避免嵌套挂载被重复遍历。
		res, err := run.Search(cfg, r.URL.Query().Get("path"), keyword,
			r.URL.Query().Get("case") == "1", cfg.SearchMaxResults)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, BuildSearchResponse(res))
	})
```

- [ ] **Step 4: 加配置项**

修改 `server/internal/foyer/config.go`：`Config` 结构体加一个字段。

```go
	MountsFile      string
	// DataDisk 是物理数据盘的挂载路径，用于读真实容量（容器里通常是 "/"）。
	DataDisk string
	// SearchMaxResults 是深度检索的命中上限（GiB 无关，就是个条数）；0 = 不限。
	// 默认完整返回：这只是防病态树打爆内存的安全阀，不是分页机制。
	SearchMaxResults uint64
```

在 `LoadConfig` 里加：

```go
		SearchMaxResults: envUint64("FOYER_SEARCH_MAX_RESULTS", 0),
```

并追加 helper：

```go
// envUint64 解析非负整型环境变量；非法或负数一律回退默认值，不让配置错误
// 变成启动期 panic。
func envUint64(key string, def uint64) uint64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
	if err != nil {
		return def
	}
	return n
}
```

> `config.go` 需要把 import 从 `import "os"` 改为 `import ("os"; "strconv"; "strings")`。

- [ ] **Step 5: compose 接线**

修改 `deploy/compose.yml` 的 `foyer.environment`，在 `FOYER_DATA_DISK_PATH: /` 之后加：

```yaml
      # 深度检索的命中上限。留空/0 = 不限（默认完整返回）；设成小值是安全阀。
      FOYER_SEARCH_MAX_RESULTS: ${FOYER_SEARCH_MAX_RESULTS:-0}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd server && go test ./internal/foyer/ -v`
Expected: 全 PASS（含 Task 3 新增的 4 条路由测试）。再跑整仓：

Run: `cd server && go test ./...`
Expected: 全 PASS。

- [ ] **Step 7: 提交**

```bash
git add server/internal/foyer/health.go server/internal/foyer/config.go server/internal/foyer/search_test.go deploy/compose.yml
git commit -m "feat(foyer): serve GET /foyer/search with an optional result cap"
```

---

### Task 4: 前端取数 —— `jfs.foyerSearch` 与 client 包装

**Files:**
- Modify: `web/src/api/jfs.ts`
- Modify: `web/src/api/client.ts`
- Create: `web/src/api/search.fetch.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `GET /foyer/search` JSON。
- Produces: `jfs.foyerSearch(keyword: string, path?: string, opts?: { caseSensitive?: boolean }): Promise<FoyerSearchResult>`；类型 `FoyerSearchMatch`/`FoyerSearchFailure`/`FoyerSearchResult`；`client.searchFiles(keyword: string, path?: string): Promise<FoyerSearchResult>`；`client.FoyerSearchResult`。

- [ ] **Step 1: 写失败测试**

创建 `web/src/api/search.fetch.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foyerSearch } from './jfs';

/** 记下 fetch 收到的 URL，并回一份最小可用的检索载荷。 */
function stubFetch(body: unknown = { keyword: 'raw', matches: [], scanned: 0, truncated: false }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('foyerSearch', () => {
  it('encodes #, spaces and CJK so the server can read them back', () => {
    const calls = stubFetch();
    return foyerSearch('#整理 完成').then(() => {
      // 手工拼串会把 # 变成 fragment；URLSearchParams 必须把它编成 %23。
      expect(calls[0]).toBe('/foyer/search?q=%23%E6%95%B4%E7%90%86+%E5%AE%8C%E6%88%90');
    });
  });

  it('omits path when blank and adds it when given', async () => {
    const calls = stubFetch();
    await foyerSearch('raw');
    expect(calls[0]).toBe('/foyer/search?q=raw');

    await foyerSearch('raw', '/av_20260619');
    expect(calls[1]).toBe('/foyer/search?q=raw&path=%2Fav_20260619');

    await foyerSearch('raw', '   ');
    expect(calls[2]).toBe('/foyer/search?q=raw');
  });

  it('sends case=1 only when case sensitivity is requested', async () => {
    const calls = stubFetch();
    await foyerSearch('raw', undefined, { caseSensitive: true });
    expect(calls[0]).toContain('case=1');
    await foyerSearch('raw');
    expect(calls[1]).not.toContain('case=');
  });

  it('defaults missing collections instead of returning undefined', async () => {
    stubFetch({ keyword: '', scanned: 3 });
    const res = await foyerSearch('raw');
    expect(res.matches).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.scanned).toBe(3);
    // 关键词以服务端回显为准，缺失时退回请求值。
    expect(res.keyword).toBe('raw');
  });

  it('throws ApiError with the server text on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'q required' }) as unknown as Response)
    );
    await expect(foyerSearch('')).rejects.toThrow(/q required/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/api/search.fetch.test.ts`
Expected: FAIL —— `foyerSearch is not a function` / `does not provide an export named 'foyerSearch'`。

- [ ] **Step 3: 实现 `foyerSearch`**

在 `web/src/api/jfs.ts` 追加（放在 `foyerUsage` 之后）：

```ts
export type FoyerSearchMatch = {
  /** 卷内绝对路径，由 overlay 归一（前导 /、无尾斜杠）。 */
  path: string;
  name: string;
  /** "file" | "directory" | "symlink" | "other" */
  type: string;
  /** 对目录是元数据长度（通常 4096），与 `juicefs stat` 同口径。 */
  size: number;
  mtime: number;
  mtimensec: number;
};

export type FoyerSearchFailure = {
  path: string;
  error: string;
};

export type FoyerSearchResult = {
  keyword: string;
  matches: FoyerSearchMatch[];
  /** 访问过的真实条目数（不含合成的 . / ..）。 */
  scanned: number;
  /** 命中数撞上了 `FOYER_SEARCH_MAX_RESULTS`；false 表示结果是完整的。 */
  truncated: boolean;
  /** 缺席表示这次检索没有子树读取失败（不是「没有错误」的零值）。 */
  errors?: FoyerSearchFailure[];
};

/**
 * 按名称递归检索卷内路径，一次覆盖所有挂载。
 *
 * 用 URLSearchParams 拼 query：关键词可能含 `#`/空格/CJK（如 `#整理完成`），
 * 手工拼串会被下游读成 fragment 并截断。
 *
 * 刻意不做防抖、不做并发控制：调用方（context）负责何时发起。
 */
export async function foyerSearch(
  keyword: string,
  path?: string,
  opts?: { caseSensitive?: boolean }
): Promise<FoyerSearchResult> {
  const qs = new URLSearchParams();
  qs.set('q', keyword);
  const p = (path || '').trim();
  if (p) qs.set('path', p);
  if (opts?.caseSensitive) qs.set('case', '1');
  const res = await fetch(`/foyer/search?${qs.toString()}`);
  if (!res.ok) throw new ApiError((await res.text()) || '检索失败', res.status);
  const data = (await res.json()) as Partial<FoyerSearchResult>;
  return {
    keyword: data.keyword || keyword,
    matches: data.matches || [],
    scanned: data.scanned || 0,
    truncated: Boolean(data.truncated),
    errors: data.errors,
  };
}
```

- [ ] **Step 4: 在 `client.ts` 包一层**

修改 `web/src/api/client.ts`，在 `previewLocalImport` 附近追加：

```ts
export type FoyerSearchResult = jfs.FoyerSearchResult;

/** 深度检索。与其它控制面调用一样，组件/context 只经 client 触达 jfs。 */
export async function searchFiles(keyword: string, path = '/'): Promise<FoyerSearchResult> {
  return jfs.foyerSearch(keyword, path);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npx vitest run src/api/search.fetch.test.ts`
Expected: PASS（5 个测试）。

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS，tsc 无错。

- [ ] **Step 6: 提交**

```bash
git add web/src/api/jfs.ts web/src/api/client.ts web/src/api/search.fetch.test.ts
git commit -m "feat(web): fetch deep search results from /foyer/search"
```

---

### Task 5: 纯函数 `web/src/api/search.ts`

**Files:**
- Create: `web/src/api/search.ts`
- Create: `web/src/api/search.test.ts`
- Modify: `web/src/types.ts`（新增 `SearchHit` 与 `DeepSearchState`）

**Interfaces:**
- Consumes: `web/src/api/mounts.ts` 的 `mountVolumePath`；`web/src/api/jfs.ts` 的 `mtimeISO`、`JFS_MOUNT`、`FoyerSearchMatch`；`web/src/api/client.ts` 的 `ApiMount`；`web/src/types.ts` 的 `SearchHit`。
- Produces: `SEARCH_PAGE_SIZE`、`mountRoot(m)`、`matchesDest(volumePath, dest)`、`attributeMatches(mounts, matches): SearchHit[]`、`parentKey(key): string`、`pageSlice(items, page, pageSize?): { items, page, totalPages }`。

- [ ] **Step 1: 写失败测试**

创建 `web/src/api/search.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SEARCH_PAGE_SIZE, attributeMatches, matchesDest, mountRoot, pageSlice, parentKey } from './search';
import type { ApiMount } from './client';
import type { FoyerSearchMatch } from './jfs';

const volume: ApiMount = { id: 'foyer', name: 'foyer', type: 's3' };
const photos: ApiMount = {
  id: 'photos',
  name: 'photos',
  type: 'local',
  spec: { dest: '/av_20260619', mode: 'metadata' },
};
const probe: ApiMount = {
  id: 'probe',
  name: 'probe',
  type: 'local',
  spec: { dest: '/av', mode: 'metadata' },
};

function hit(path: string, name = path.split('/').pop() || '', type = 'file'): FoyerSearchMatch {
  return { path, name, type, size: 1, mtime: 0, mtimensec: 0 };
}

describe('mountRoot', () => {
  it('treats the gateway volume as the volume root, not /foyer', () => {
    // 卷挂载的 spec 里没有 dest，直接套 mountVolumePath 会得到 /foyer（错误）。
    expect(mountRoot(volume)).toBe('/');
    expect(mountRoot(photos)).toBe('/av_20260619');
  });

  it('falls back to /name for a mount without dest', () => {
    // 必须绑成 ApiMount 再传：直接写对象字面量会触发多余属性检查（TS2353），
    // 因为 mountRoot 的形参只声明了 name/spec。以下常量在前面已定义。
    const noDest: ApiMount = { id: 'x', name: 'x', type: 'local' };
    expect(mountRoot(noDest)).toBe('/x');
  });
});

describe('matchesDest', () => {
  it('aligns on segment boundaries so /av never matches /av_20260619', () => {
    expect(matchesDest('/av', '/av')).toBe(true);
    expect(matchesDest('/av/2026', '/av')).toBe(true);
    expect(matchesDest('/av_20260619', '/av')).toBe(false);
    expect(matchesDest('/av_20260619/x', '/av')).toBe(false);
  });

  it('matches everything for the volume root', () => {
    expect(matchesDest('/anything', '/')).toBe(true);
    expect(matchesDest('/', '/')).toBe(true);
  });
});

describe('attributeMatches', () => {
  it('prefers the longest dest so a nested mount wins over the volume', () => {
    const got = attributeMatches([volume, photos], [hit('/av_20260619/raw/a.dng', 'a.dng')]);
    expect(got).toHaveLength(1);
    expect(got[0].mount).toBe('photos');
    expect(got[0].key).toBe('/raw/a.dng');
  });

  it('picks the deeper of two overlapping mounts regardless of list order', () => {
    const nested = attributeMatches([probe, photos], [hit('/av_20260619/raw/a.dng', 'a.dng')]);
    expect(nested[0].mount).toBe('photos');
    expect(nested[0].key).toBe('/raw/a.dng');
  });

  it('attributes the mount root itself to that mount with key /', () => {
    const got = attributeMatches([volume, photos], [hit('/av_20260619', 'av_20260619', 'directory')]);
    expect(got[0].mount).toBe('photos');
    expect(got[0].key).toBe('/');
    expect(got[0].isDir).toBe(true);
  });

  it('falls back to the volume mount for paths outside every dest', () => {
    const got = attributeMatches([volume, photos], [hit('/capacity-gate-probe.txt')]);
    expect(got[0].mount).toBe('foyer');
    expect(got[0].key).toBe('/capacity-gate-probe.txt');
  });

  it('converts mtime seconds plus nanoseconds to ISO', () => {
    const got = attributeMatches([volume], [{ ...hit('/a.txt'), mtime: 1777690800, mtimensec: 500000000 }]);
    expect(got[0].mtime).toBe(new Date(1777690800 * 1000 + 500).toISOString());
  });

  it('skips malformed entries instead of emitting a bogus hit', () => {
    const got = attributeMatches([volume], [
      { path: '', name: 'x', type: 'file', size: 0, mtime: 0, mtimensec: 0 },
      hit('/ok.txt'),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].key).toBe('/ok.txt');
  });
});

describe('parentKey', () => {
  it('walks up one level and clamps at the mount root', () => {
    expect(parentKey('/a/b/c')).toBe('/a/b');
    expect(parentKey('/a')).toBe('/');
    expect(parentKey('/')).toBe('/');
    expect(parentKey('a/b')).toBe('/a');
  });
});

describe('pageSlice', () => {
  const items = Array.from({ length: 250 }, (_, i) => i);

  it('slices pages of the default size', () => {
    const first = pageSlice(items, 1);
    expect(first.items).toHaveLength(SEARCH_PAGE_SIZE);
    expect(first.items[0]).toBe(0);
    expect(first.totalPages).toBe(3);
  });

  it('returns the tail on the last page', () => {
    const last = pageSlice(items, 3);
    expect(last.page).toBe(3);
    expect(last.items).toHaveLength(50);
    expect(last.items[49]).toBe(249);
  });

  it('clamps out-of-range pages instead of returning nothing', () => {
    expect(pageSlice(items, 99).page).toBe(3);
    expect(pageSlice(items, 0).page).toBe(1);
    expect(pageSlice(items, -5).page).toBe(1);
    expect(pageSlice(items, Number.NaN).page).toBe(1);
  });

  it('always reports at least one page so the UI has a sane counter', () => {
    expect(pageSlice([], 1)).toEqual({ items: [], page: 1, totalPages: 1 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/api/search.test.ts`
Expected: FAIL —— `Failed to resolve import "./search"`。

- [ ] **Step 3: 在 `types.ts` 加类型**

在 `web/src/types.ts` 追加：

```ts
/** 一条深度检索命中，已归到某个挂载上。 */
export interface SearchHit {
  mount: string;
  /** 挂载内绝对路径，可直接交给 navigateTo(mount, parentKey(key))。 */
  key: string;
  name: string;
  isDir: boolean;
  size: number;
  /** ISO-8601 UTC。 */
  mtime: string;
  /** 卷内绝对路径，仅供展示与排查。 */
  volumePath: string;
}

/** 深度检索视图状态。active 为假时结果视图不渲染。 */
export interface DeepSearchState {
  active: boolean;
  keyword: string;
  loading: boolean;
  /** 访问过的真实条目数，用于「已扫描 N 项」。 */
  scanned: number;
  /** 命中数撞上了服务端上限，结果不完整。 */
  truncated: boolean;
  error: string;
  hits: SearchHit[];
  page: number;
}
```

- [ ] **Step 4: 写最小实现**

创建 `web/src/api/search.ts`：

```ts
import type { ApiMount } from './client';
import type { FoyerSearchMatch } from './jfs';
import { JFS_MOUNT, mtimeISO } from './jfs';
import { mountVolumePath } from './mounts';
import type { SearchHit } from '../types';

/** 每页条数。仓库没有虚拟滚动依赖，分页是纯函数切片，可单测。 */
export const SEARCH_PAGE_SIZE = 100;

/**
 * 挂载在卷内的根路径。
 *
 * 卷挂载（foyer）的 spec 里没有 dest，直接套 mountVolumePath 会得到 `/foyer`——
 * 那是桶名不是卷内路径，会让卷挂载永远匹配不上任何命中。必须显式视作 `/`。
 */
export function mountRoot(m: { name: string; spec?: Record<string, string> }): string {
  if (m.name === JFS_MOUNT) return '/';
  return mountVolumePath(m);
}

/**
 * 段边界对齐的前缀判断。
 *
 * 不能用裸 startsWith：`/av` 会匹配 `/av_20260619`，把命中错划给另一个挂载。
 * 只有相等、或以 `dest + '/'` 开头才算同一条路径下。
 */
export function matchesDest(volumePath: string, dest: string): boolean {
  if (dest === '/') return true;
  return volumePath === dest || volumePath.startsWith(`${dest}/`);
}

/**
 * 把卷内绝对路径的命中归到挂载上。纯函数：路径→挂载的对应关系只在这一处。
 *
 * 取**最长**的 dest 胜出，所以嵌套挂载（`/av` 与 `/av_20260619`）里更具体的那条
 * 赢，与 mounts 列表顺序无关。不在任何 dest 下的路径落到卷挂载。
 */
export function attributeMatches(mounts: ApiMount[], matches: FoyerSearchMatch[]): SearchHit[] {
  const roots = mounts.map(m => ({ name: m.name, root: mountRoot(m) }));
  const out: SearchHit[] = [];
  for (const m of matches) {
    if (!m || !m.path) continue;
    let best: { name: string; root: string } | undefined;
    for (const r of roots) {
      if (!matchesDest(m.path, r.root)) continue;
      if (!best || r.root.length > best.root.length) best = r;
    }
    if (!best) continue; // 不在任何挂载下：宁可丢弃，也不冒充归属
    const key = best.root === '/' ? m.path : m.path.slice(best.root.length) || '/';
    out.push({
      mount: best.name,
      key,
      name: m.name,
      isDir: m.type === 'directory',
      size: m.size,
      mtime: mtimeISO(m.mtime, m.mtimensec),
      volumePath: m.path,
    });
  }
  return out;
}

/** 挂载内路径的父目录；在挂载根上返回 `/` 而不是空串。 */
export function parentKey(key: string): string {
  const clean = key.startsWith('/') ? key : `/${key}`;
  const i = clean.lastIndexOf('/');
  if (i <= 0) return '/';
  return clean.slice(0, i);
}

/**
 * 取第 page 页。越界页夹紧到有效范围（而不是返回空），这样翻页按钮的
 * disabled 判定与显示的总页数不会互相矛盾。空列表也报 1 页。
 */
export function pageSlice<T>(
  items: T[],
  page: number,
  pageSize = SEARCH_PAGE_SIZE
): { items: T[]; page: number; totalPages: number } {
  const size = pageSize > 0 ? pageSize : SEARCH_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  const p = Math.min(Math.max(1, wanted || 1), totalPages);
  return { items: items.slice((p - 1) * size, p * size), page: p, totalPages };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npx vitest run src/api/search.test.ts`
Expected: PASS（15 个测试）。

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS，tsc 无错。

- [ ] **Step 6: 提交**

```bash
git add web/src/api/search.ts web/src/api/search.test.ts web/src/types.ts
git commit -m "feat(web): attribute search hits to mounts and paginate them"
```

---

### Task 6: Context 接线 —— 检索状态与跳转选中

**Files:**
- Modify: `web/src/context/FileStoreContext.tsx`

**Interfaces:**
- Consumes: Task 4 的 `api.searchFiles`；Task 5 的 `attributeMatches`、`parentKey`、`SearchHit`、`DeepSearchState`。
- Produces: context 上的 `deepSearch: DeepSearchState`、`runDeepSearch(keyword: string): Promise<void>`、`exitDeepSearch(): void`、`setDeepSearchPage(page: number): void`、`revealHit(hit: SearchHit): void`。

- [ ] **Step 1: 加状态类型与初始值**

修改 `web/src/context/FileStoreContext.tsx`。

import 段加：

```ts
import { attributeMatches, parentKey } from '../api/search';
```

类型 import 段把 `types` 的 import 列表补上 `DeepSearchState`、`SearchHit`。

在 `interface FileStoreContextType` 里，`clearSelection: () => void;` 之后加：

```ts
  deepSearch: DeepSearchState;
  runDeepSearch: (keyword: string) => Promise<void>;
  exitDeepSearch: () => void;
  setDeepSearchPage: (page: number) => void;
  revealHit: (hit: SearchHit) => void;
```

在 `FileStoreContext` 定义之前加初始值常量：

```ts
const EMPTY_DEEP_SEARCH: DeepSearchState = {
  active: false,
  keyword: '',
  loading: false,
  scanned: 0,
  truncated: false,
  error: '',
  hits: [],
  page: 1,
};
```

- [ ] **Step 2: 加实现**

在 `const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());` 之后加：

```ts
  const [deepSearch, setDeepSearch] = useState<DeepSearchState>(EMPTY_DEEP_SEARCH);
  // 待揭示的目标：置上后由下一次「匹配到那个目录」的目录加载消费并选中该行。
  // 必须带 mount/parent 一起记：否则在途的旧目录请求会把关键词提前吃掉。
  const pendingReveal = useRef<{ mount: string; parent: string; key: string } | null>(null);
```

在 `clearSelection` 之后加：

```ts
  const runDeepSearch = useCallback(async (keyword: string) => {
    const kw = keyword.trim();
    if (!kw) return;
    setDeepSearch({ ...EMPTY_DEEP_SEARCH, active: true, keyword: kw, loading: true });
    try {
      // 固定从卷根遍历：所有挂载都是卷内子树，一次请求即全覆盖。
      const res = await api.searchFiles(kw, '/');
      setDeepSearch({
        active: true,
        keyword: res.keyword || kw,
        loading: false,
        scanned: res.scanned,
        truncated: res.truncated,
        error: '',
        hits: attributeMatches(mountsRef.current, res.matches),
        page: 1,
      });
    } catch (err) {
      // 检索失败只落在结果视图里，不弹全局错误：它不阻塞其它任何操作。
      setDeepSearch({
        ...EMPTY_DEEP_SEARCH,
        active: true,
        keyword: kw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const exitDeepSearch = useCallback(() => {
    pendingReveal.current = null;
    setDeepSearch(EMPTY_DEEP_SEARCH);
  }, []);

  const setDeepSearchPage = useCallback((page: number) => {
    setDeepSearch(prev => ({ ...prev, page }));
  }, []);

  const revealHit = useCallback(
    (hit: SearchHit) => {
      pendingReveal.current = { mount: hit.mount, parent: parentKey(hit.key), key: hit.key };
      setDeepSearch(EMPTY_DEEP_SEARCH);
      navigateTo(hit.mount, parentKey(hit.key));
    },
    [navigateTo]
  );
```

> `navigateTo` 是普通函数（非 `useCallback`），所以 `revealHit` 的依赖数组写 `[navigateTo]` 会在每轮渲染变化——这不影响正确性（只是 `useCallback` 不生效），保持与文件里其它 `useCallback` 一致的写法即可。

- [ ] **Step 3: 在目录加载完成后消费 pendingReveal**

修改 `refreshDirectory`（约 194-199 行）。把

```
      setNodes(entries);
      setSelectedNode(prev => {
        if (!prev) return null;
        const hit = entries.find(n => n.key === prev.key);
        return hit || null;
      });
```

替换为（既有的「保留仍然存在的选中」remap 必须原样保留，reveal 在其后覆盖）：

```
      setNodes(entries);
      setSelectedNode(prev => {
        if (!prev) return null;
        const hit = entries.find(n => n.key === prev.key);
        return hit || null;
      });
      // 揭示（revealHit）只应在「目标所在的那一层」生效：在途的旧目录请求
      // 也会走到这里，不带 mount/parent 校验就会把待揭示状态提前吃掉。
      const reveal = pendingReveal.current;
      if (reveal && reveal.mount === mountName && reveal.parent === currentPath) {
        pendingReveal.current = null;
        const hit = entries.find(n => n.key === reveal.key);
        if (hit) setSelectedNode(hit);
      }
```

> 不需要给 `refreshDirectory` 加依赖：`pendingReveal` 是 ref，`setSelectedNode` 稳定，`mountName`/`currentPath` 已在 `useCallback` 的依赖数组里。

- [ ] **Step 4: 挂进 provider value**

在 `value={{` 对象里，把

```
        selectedKeys,
        toggleSelectKey,
        selectAllKeys,
        clearSelection,
        isUploadOpen,
```

替换为

```
        selectedKeys,
        toggleSelectKey,
        selectAllKeys,
        clearSelection,
        deepSearch,
        runDeepSearch,
        exitDeepSearch,
        setDeepSearchPage,
        revealHit,
        isUploadOpen,
```

并在 `logout()` 里清掉检索状态。把

```
    setSelectedNode(null);
    pollTimers.current.forEach(t => clearInterval(t));
    pollTimers.current.clear();
  };
```

替换为（锚点必须带上 `setSelectedNode(null);` 那一行：`pollTimers.current.clear();` 在卸载清理的 `useEffect` 里也出现一次，只锚 `clear()` 会改错地方）：

```
    setSelectedNode(null);
    pendingReveal.current = null;
    setDeepSearch(EMPTY_DEEP_SEARCH);
    pollTimers.current.forEach(t => clearInterval(t));
    pollTimers.current.clear();
  };
```

- [ ] **Step 5: 运行类型检查与全量测试**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc 无错，全量测试 PASS。

> 本任务**无法执行验证**：仓库 vitest 为 node 环境且只 include `*.test.ts`，没有 DOM 测试设施，context 是组件层。结论仅由 `tsc --noEmit`（provider value 的键与接口逐字段对齐）+ 阅读代码得出。这是既定约束，不要为它引入 jsdom。

- [ ] **Step 6: 提交**

```bash
git add web/src/context/FileStoreContext.tsx
git commit -m "feat(web): wire deep search state and hit reveal into the store"
```

---

### Task 7: 结果视图与 `FileExplorer` 接入

**Files:**
- Create: `web/src/components/SearchResults.tsx`
- Modify: `web/src/components/FileExplorer.tsx`

**Interfaces:**
- Consumes: Task 6 的 `deepSearch`/`setDeepSearchPage`/`exitDeepSearch`/`revealHit`、`runDeepSearch`；Task 5 的 `pageSlice`、`SEARCH_PAGE_SIZE`。
- Produces: `SearchResults` 组件（无 props，从 context 取数）。

- [ ] **Step 1: 写结果视图**

创建 `web/src/components/SearchResults.tsx`：

```tsx
import React from 'react';
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Crosshair, File, Folder } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { pageSlice } from '../api/search';
import { formatBytes, formatDate } from '../utils/formatters';

/**
 * 深度检索结果视图。复用 FileExplorer 的列表区域，不接管工具栏。
 *
 * 结果在服务端一次性完整返回，这里只做客户端分页切片——仓库没有虚拟滚动依赖，
 * 分页是纯函数且可单测。
 */
export const SearchResults: React.FC = () => {
  const { deepSearch, setDeepSearchPage, exitDeepSearch, revealHit } = useFileStore();
  const { items, page, totalPages } = pageSlice(deepSearch.hits, deepSearch.page);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-slate-600">
            深度检索 <span className="font-mono text-slate-900">“{deepSearch.keyword}”</span>
          </span>
          {deepSearch.loading ? (
            <span className="text-indigo-600">检索中…</span>
          ) : (
            <span className="text-slate-500">
              命中 <strong className="font-mono text-slate-800">{deepSearch.hits.length}</strong> 项 · 已扫描{' '}
              <strong className="font-mono text-slate-800">{deepSearch.scanned}</strong> 项
            </span>
          )}
          {deepSearch.truncated && (
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5" />
              结果被服务端上限截断，不完整
            </span>
          )}
        </div>
        <button
          onClick={exitDeepSearch}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回目录
        </button>
      </div>

      {deepSearch.error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
          检索失败：{deepSearch.error}
        </div>
      )}

      {!deepSearch.loading && !deepSearch.error && deepSearch.hits.length === 0 && (
        <div className="h-40 flex items-center justify-center text-xs text-slate-400">
          没有名称里含「{deepSearch.keyword}」的文件或目录
        </div>
      )}

      {items.length > 0 && (
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500 font-medium">
              <th className="px-3 py-2.5 font-medium">名称</th>
              <th className="w-28 px-3 py-2.5 font-medium">挂载</th>
              <th className="px-3 py-2.5 font-medium">挂载内路径</th>
              <th className="w-24 px-3 py-2.5 font-medium">大小</th>
              <th className="w-40 px-3 py-2.5 font-medium hidden sm:table-cell">修改时间</th>
              <th className="w-16 px-3 py-2.5 text-right font-medium">跳转</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map(hit => (
              <tr key={`${hit.mount}:${hit.key}`} className="hover:bg-slate-50/80 text-slate-700">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {hit.isDir ? (
                      <Folder className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                    ) : (
                      <File className="w-4 h-4 text-slate-400" />
                    )}
                    <span className="font-medium text-slate-900">{hit.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 font-mono">
                    {hit.mount}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-slate-500 font-mono break-all">{hit.key}</td>
                <td className="px-3 py-2.5 text-slate-500 font-mono">
                  {hit.isDir ? <span className="text-slate-300">-</span> : formatBytes(hit.size)}
                </td>
                <td className="px-3 py-2.5 text-slate-500 text-[11px] font-mono hidden sm:table-cell">
                  {formatDate(hit.mtime)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => revealHit(hit)}
                    title="跳到所在目录并选中"
                    className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-indigo-600"
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-3 text-xs text-slate-600">
          <button
            onClick={() => setDeepSearchPage(page - 1)}
            disabled={page <= 1}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            上一页
          </button>
          <span className="font-mono">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setDeepSearchPage(page + 1)}
            disabled={page >= totalPages}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            下一页
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 接进 `FileExplorer`**

修改 `web/src/components/FileExplorer.tsx`。

(a) import 段加：

```tsx
import { SearchResults } from './SearchResults';
```

(b) 从 context 解构里补三项 —— 把

```
    downloadNode,
    isLoadingDirectory,
  } = useFileStore();
```

替换为

```
    downloadNode,
    isLoadingDirectory,
    deepSearch,
    runDeepSearch,
    exitDeepSearch,
  } = useFileStore();
```

(c) 拖拽上传在结果视图下必须停用（否则会把文件传到「当前目录」，而用户看到的是结果列表）：

```
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
```

替换为

```
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // 结果视图下当前目录并不在屏幕上，拖放目标不可见，不能悄悄上传。
    if (deepSearch.active) return;
```

(d) 工具栏左簇在结果视图下让位给命中计数 —— 把

```
        <div className="flex items-center gap-3 text-xs">
          {hasSelection ? (
```

替换为

```
        <div className="flex items-center gap-3 text-xs">
          {deepSearch.active ? (
            <span className="text-slate-500 font-medium">
              深度检索命中 <strong className="text-slate-800 font-mono">{deepSearch.hits.length}</strong> 项
            </span>
          ) : hasSelection ? (
```

(e) 搜索框改成可提交的表单，并加「深度检索」按钮 —— 把

```
        <div className="flex-1 max-w-sm">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索文件名或标签..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all font-sans"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            )}
          </div>
        </div>
```

替换为

```
        <div className="flex-1 max-w-md">
          <div className="flex items-center gap-2">
            <form
              className="relative flex-1"
              onSubmit={e => {
                e.preventDefault();
                void runDeepSearch(searchQuery);
              }}
            >
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索本层，回车深度检索全部挂载…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all font-sans"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    exitDeepSearch();
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-700"
                >
                  ✕
                </button>
              )}
            </form>
            <button
              type="button"
              onClick={() => void runDeepSearch(searchQuery)}
              disabled={!searchQuery.trim()}
              title="跨所有挂载、递归按名称检索（在输入框回车同效）"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium disabled:opacity-40 shrink-0"
            >
              <Search className="w-3.5 h-3.5 text-indigo-600" />
              深度检索
            </button>
          </div>
        </div>
```

(f) 列表区域切成结果视图 —— 把

```
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        {sortedNodes.length === 0 ? (
```

替换为

```
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        {deepSearch.active ? (
          <SearchResults />
        ) : sortedNodes.length === 0 ? (
```

- [ ] **Step 3: 类型检查与全量测试**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc 无错，全量测试 PASS。

- [ ] **Step 4: 确认旧假数据没有被顺手加回来**

Run:

```powershell
rg -n "2 \* 1024 \* 1024 \* 1024 \* 1024|Math\.max\(pct, 4\)" web/src
```

Expected: 无输出（`2TB simulated capacity` 与 `Math.max(pct, 4)` 在既有的用量任务里已被删除，本次不得引入同类假数据）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/SearchResults.tsx web/src/components/FileExplorer.tsx
git commit -m "feat(web): render deep search results in the file list area"
```

---

### Task 8: 端到端验证（真实环境）

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-deep-search.md`（把实测值记进本文件末尾的 `## Verification Notes`）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 一份可复现的验证记录。

- [ ] **Step 1: 重建并起容器**

Run:

```powershell
.\scripts\run-foyer.ps1
```

Expected: 镜像重建成功。**必须确认镜像真的重建了**——上一轮用量任务踩过的坑：用户在提交前后跑构建，`COPY server` 发生在源码落盘前，结果容器里跑的是旧二进制。用这条命令验证 `find` 与新端点都在镜像里：

```powershell
docker exec deploy-foyer-1 juicefs find --help
```

Expected: 打印 `find` 的 NAME/USAGE/ARGS 段（若报 `No help topic for 'find'`，说明 overlay 没进镜像，回去查 Task 1 Step 4 的两个脚本）。

- [ ] **Step 2: 命令行核对 `juicefs find` 本身（含 flag 重排）**

Run:

```powershell
docker exec deploy-foyer-1 juicefs find redis://redis:6379/1 / --name host
docker exec deploy-foyer-1 juicefs find redis://redis:6379/1 / --name host --limit 1
docker exec deploy-foyer-1 juicefs find redis://redis:6379/1 / --name HOST --case-sensitive
```

Expected: 第 1 条返回 `{"keyword":"host","matches":[...],"scanned":N,"truncated":false}` —— 位置参数在前、flag 在后仍被正确解析（`main.go` 的 `reorderOptions` 生效）；第 2 条 `truncated:true` 且只有 1 条命中；第 3 条命中数明显更少（大小写敏感）。

- [ ] **Step 3: 核对控制面端点**

Run:

```powershell
curl.exe -s "http://127.0.0.1:8092/foyer/search?q=host"
curl.exe -s "http://127.0.0.1:8092/foyer/search?q=%23"
curl.exe -s -o NUL -w "%{http_code}\n" "http://127.0.0.1:8092/foyer/search"
```

Expected: 第 1 条 HTTP 200 且形状为 `{"ok":true,"keyword":"host","matches":[...],"scanned":N,"truncated":false}`；第 2 条证明 `#` 经 URL 编码后能被正确读出（不报 400、否则说明 query 被截断）；第 3 条 `400`。

- [ ] **Step 4: 交叉核对 `scanned` 的量级**

Run:

```powershell
curl.exe -s "http://127.0.0.1:8092/foyer/usage"
```

Expected: `scanned` 与 `/foyer/usage` 里卷级 `used_inodes` 同量级（同一棵元数据树；`scanned` 少一些是正常的——回收站与根自身不计，且 `limit` 会提前停止）。若 `scanned` 只有两位数而 `used_inodes` 是四位数，说明遍历没有真正递归。

- [ ] **Step 5: 浏览器核对 UI**

打开 Web，进入「文件」页，确认：

- 输入一个**当前目录里没有**的关键词（例如 `host`），回车后列表区域换成结果视图，顶部显示「命中 N 项 · 已扫描 M 项」。
- 命中很多时底部出现 `1 / N` 分页，翻页只切数组（不重新发请求，Network 面板可证）。
- 点某行的「跳转」按钮：进入该文件所在目录，且该行被选中（右侧属性抽屉/高亮生效）。
- 用 `#` 或中文关键词再搜一次，确认按预期出结果而不是报错。
- 结果视图下拖文件进窗口**不会**触发上传。
- 「返回目录」回到原来的目录视图。

若某条命中归属挂载明显不对（例如落在 `foyer` 而不是它的导入挂载），检查该挂载的 `spec.dest` 是否与 `/foyer/usage` 里的 `summaries[].path` 一致——`attributeMatches` 是精确前缀匹配，`dest` 写错就会落到卷挂载，属服务端如实回报而非前端 bug。

- [ ] **Step 6: 记录实测值**

把 Step 2/3/4 的真实输出贴进本文件末尾的 `## Verification Notes` 段落（含日期与容器版本），供后续回归对照。

- [ ] **Step 7: 提交**

```bash
git add docs/superpowers/plans/2026-09-19-deep-search.md
git commit -m "docs: record end-to-end verification for deep search"
```

---

## Verification Notes

（Task 8 填写：日期、分支、HEAD、镜像与 juicefs 版本、`juicefs find` 原始输出、`/foyer/search` 原始响应、`scanned` 与 `used_inodes` 的对照、UI 实际渲染确认项与未验证项。）

## 已知取舍

- **只覆盖 JuiceFS 卷内的挂载**。当前所有挂载（含隐式卷挂载 `foyer`）都是卷内子树，从卷根 `/` 一次遍历即全覆盖；将来若挂载落到对象存储三方的原生 key（不经卷），需要各驱动自己的列举，不在本次范围。
- **只搜名字，不搜内容**。不读字节、不做全文索引。
- **`Readdir` 一次把整个目录读进内存**（`pkg/meta/redis.go:2128`），没有流式接口。宽目录（百万级条目）会占用可观内存；本卷实测是数千 inode 量级，且这是 `unflag.go` 已在用的同一接口。将来若需要，可换 `NewDirHandler` 流式读，但那要改 overlay 的遍历结构。
- **默认完整返回**，`FOYER_SEARCH_MAX_RESULTS` 是安全阀而非分页：`Runner` 用 `CombinedOutput` 整体缓冲，命中极多时载荷与内存都会涨。运维可设值截断，UI 会显示「结果被服务端上限截断」。
- **非快照遍历**：遍历期间并发写入可能让结果对不上某一瞬间；只读检索，可接受。
- **子路径 vs 挂载根**：`attributeMatches` 的前缀匹配是按 `spec.dest` 段边界对齐的，所以请求卷内子路径同样能正确归属（比 `poolPathFor` 的精确匹配更宽）；但**同一块盘上的两个挂载**仍各自独立归属，不合并统计。
- **不做权限过滤**：以控制面身份读元数据，与 `stat`/`usage` 同口径。
- **控制面 8092 仍无鉴权**：与新端点的既有约定保持一致，未在本计划中收紧。
- **组件层改动无自动化覆盖**：仓库 vitest 为 node 环境且只 include `*.test.ts`，`SearchResults.tsx`/`FileExplorer.tsx`/`FileStoreContext.tsx` 只能靠 `tsc --noEmit` + 代码审阅 + Task 8 的浏览器实测。这是既定约束。
