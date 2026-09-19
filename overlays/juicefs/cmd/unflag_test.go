package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"syscall"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

// fakeNode 是假元数据树上的一层节点。nilAttr / *Err 用来构造边界分支。
type fakeNode struct {
	name       string
	inode      meta.Ino
	typ        uint8
	flags      uint8
	children   []*fakeNode
	nilAttr    bool
	readdirErr syscall.Errno
	setAttrErr syscall.Errno
}

// fakeFlagSetter 是 flagSetter 的内存实现，记录被写了标志位的 inode 与写进去的值。
type fakeFlagSetter struct {
	nodes   map[meta.Ino]*fakeNode
	setOn   []meta.Ino
	setMask []uint16
	setVal  []uint8
}

func newFakeSetter(t *testing.T, roots ...*fakeNode) *fakeFlagSetter {
	t.Helper()
	f := &fakeFlagSetter{nodes: make(map[meta.Ino]*fakeNode)}
	var index func(*fakeNode)
	index = func(n *fakeNode) {
		if _, dup := f.nodes[n.inode]; dup {
			t.Fatalf("inode %d 重复", n.inode)
		}
		f.nodes[n.inode] = n
		for _, c := range n.children {
			index(c)
		}
	}
	for _, r := range roots {
		index(r)
	}
	return f
}

func (f *fakeFlagSetter) Readdir(_ meta.Context, inode meta.Ino, _ uint8, entries *[]*meta.Entry) syscall.Errno {
	n, ok := f.nodes[inode]
	if !ok {
		return syscall.ENOENT
	}
	if n.readdirErr != 0 {
		return n.readdirErr
	}
	list := make([]*meta.Entry, 0, len(n.children))
	for _, c := range n.children {
		e := &meta.Entry{Inode: c.inode, Name: []byte(c.name)}
		if !c.nilAttr {
			e.Attr = &meta.Attr{Typ: c.typ, Flags: c.flags}
		}
		list = append(list, e)
	}
	*entries = list
	return 0
}

func (f *fakeFlagSetter) SetAttr(_ meta.Context, inode meta.Ino, set uint16, _ uint8, attr *meta.Attr) syscall.Errno {
	if n := f.nodes[inode]; n != nil && n.setAttrErr != 0 {
		return n.setAttrErr
	}
	f.setOn = append(f.setOn, inode)
	f.setMask = append(f.setMask, set)
	f.setVal = append(f.setVal, attr.Flags)
	return 0
}

func TestHasLockingFlag(t *testing.T) {
	cases := []struct {
		name  string
		flags uint8
		want  bool
	}{
		{"none", 0, false},
		{"immutable", meta.FlagImmutable, true},
		{"append", meta.FlagAppend, true},
		{"both", meta.FlagImmutable | meta.FlagAppend, true},
	}
	for _, c := range cases {
		if got := hasLockingFlag(c.flags); got != c.want {
			t.Fatalf("%s: hasLockingFlag(%d) = %v, want %v", c.name, c.flags, got, c.want)
		}
	}
}

// 树：root(无标志) ├─ a.mp4(immutable) ├─ b.mp4(无) └─ sub(immutable) └─ d.mp4(append)
// 另挂两个干扰项："." 子树（不该被访问）与 attr 缺失的条目（该跳过）。
func newTestTree() (root *fakeNode, hidden *fakeNode) {
	a := &fakeNode{name: "a.mp4", inode: 2, typ: meta.TypeFile, flags: meta.FlagImmutable}
	b := &fakeNode{name: "b.mp4", inode: 3, typ: meta.TypeFile}
	d := &fakeNode{name: "d.mp4", inode: 5, typ: meta.TypeFile, flags: meta.FlagAppend}
	sub := &fakeNode{name: "sub", inode: 4, typ: meta.TypeDirectory, flags: meta.FlagImmutable, children: []*fakeNode{d}}
	hiddenDeep := &fakeNode{name: "deep.mp4", inode: 8, typ: meta.TypeFile, flags: meta.FlagImmutable}
	hiddenDir := &fakeNode{name: ".", inode: 7, typ: meta.TypeDirectory, children: []*fakeNode{hiddenDeep}}
	noAttr := &fakeNode{name: "ghost", inode: 6, typ: meta.TypeFile, flags: meta.FlagImmutable, nilAttr: true}
	root = &fakeNode{name: "", inode: 1, typ: meta.TypeDirectory, children: []*fakeNode{a, b, sub, hiddenDir, noAttr}}
	return root, hiddenDeep
}

func TestClearFlagsClearsOnlyFlaggedEntries(t *testing.T) {
	root, hidden := newTestTree()
	f := newFakeSetter(t, root)
	var summary unflagSummary

	clearFlags(f, meta.Background(), root.inode, meta.Attr{Typ: meta.TypeDirectory}, false, &summary)

	// root / a / b / sub / d 共 5 个真实条目；"." 子树与 attr 缺失项都不进计数。
	if summary.Scanned != 5 || summary.Cleared != 3 || summary.Untouched != 2 {
		t.Fatalf("summary = %+v, want scanned=5 cleared=3 untouched=2", summary)
	}
	if len(summary.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", summary.Errors)
	}
	wantSet := []meta.Ino{2, 4, 5}
	if len(f.setOn) != len(wantSet) {
		t.Fatalf("SetAttr called on %v, want %v", f.setOn, wantSet)
	}
	for i, ino := range wantSet {
		if f.setOn[i] != ino {
			t.Fatalf("SetAttr order = %v, want %v", f.setOn, wantSet)
		}
		if f.setMask[i] != meta.SetAttrFlag {
			t.Fatalf("inode %d: set mask = %d, want SetAttrFlag", ino, f.setMask[i])
		}
		if f.setVal[i] != 0 {
			t.Fatalf("inode %d: flags written = %d, want 0", ino, f.setVal[i])
		}
	}
	for _, ino := range f.setOn {
		if ino == hidden.inode {
			t.Fatalf("不可达的 \".\" 子树被访问了 (inode %d)", ino)
		}
	}
}

func TestClearFlagsDryRunReportsWithoutWriting(t *testing.T) {
	root, _ := newTestTree()
	f := newFakeSetter(t, root)
	summary := unflagSummary{DryRun: true}

	clearFlags(f, meta.Background(), root.inode, meta.Attr{Typ: meta.TypeDirectory}, true, &summary)

	if summary.Cleared != 3 {
		t.Fatalf("cleared = %d, want 3 (dry-run 也要如实统计)", summary.Cleared)
	}
	if len(f.setOn) != 0 {
		t.Fatalf("dry-run 不该写元数据，却调用了 SetAttr: %v", f.setOn)
	}
}

func TestClearFlagsRecordsSetAttrFailure(t *testing.T) {
	root, _ := newTestTree()
	root.children[0].setAttrErr = syscall.EPERM // a.mp4
	f := newFakeSetter(t, root)
	var summary unflagSummary

	clearFlags(f, meta.Background(), root.inode, meta.Attr{Typ: meta.TypeDirectory}, false, &summary)

	if summary.Cleared != 2 {
		t.Fatalf("cleared = %d, want 2 (失败的条目不该计入)", summary.Cleared)
	}
	if len(summary.Errors) != 1 || !strings.Contains(summary.Errors[0], "inode 2") {
		t.Fatalf("errors = %v, want one entry mentioning inode 2", summary.Errors)
	}
}

func TestClearFlagsSurvivesReaddirFailure(t *testing.T) {
	root, _ := newTestTree()
	root.children[2].readdirErr = syscall.EIO // sub
	f := newFakeSetter(t, root)
	var summary unflagSummary

	clearFlags(f, meta.Background(), root.inode, meta.Attr{Typ: meta.TypeDirectory}, false, &summary)

	if len(summary.Errors) != 1 || !strings.Contains(summary.Errors[0], "readdir inode 4") {
		t.Fatalf("errors = %v, want one readdir failure for inode 4", summary.Errors)
	}
	// 已经清掉的 a.mp4 与 sub 自身仍要计入，兄弟条目不受影响。
	if summary.Cleared != 2 {
		t.Fatalf("cleared = %d, want 2", summary.Cleared)
	}
}

func TestReportUnflagFormats(t *testing.T) {
	var buf bytes.Buffer
	reportUnflag(&buf, unflagSummary{DryRun: true, Scanned: 5, Cleared: 3, Untouched: 2}, false)
	if got := buf.String(); got != "would clear 3 of 5 entries (2 untouched)\n" {
		t.Fatalf("text output = %q", got)
	}

	buf.Reset()
	reportUnflag(&buf, unflagSummary{Scanned: 5, Cleared: 3, Untouched: 2}, false)
	if got := buf.String(); got != "cleared 3 of 5 entries (2 untouched)\n" {
		t.Fatalf("text output = %q", got)
	}

	buf.Reset()
	reportUnflag(&buf, unflagSummary{Scanned: 5, Cleared: 3, Untouched: 2}, true)
	var decoded unflagSummary
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("json output not parseable: %v (%q)", err, buf.String())
	}
	if decoded.Cleared != 3 || decoded.Scanned != 5 || decoded.Untouched != 2 {
		t.Fatalf("decoded = %+v", decoded)
	}
}
