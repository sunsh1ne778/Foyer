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
