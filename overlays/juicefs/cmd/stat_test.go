package cmd

import (
	"encoding/json"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

func TestNormalizeVolumePath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/photos/sub", "/photos/sub"},
		{"/photos/sub/", "/photos/sub"},
		{"photos/sub", "/photos/sub"},
		{"/", "/"},
		{"", "/"},
		{"  /photos  ", "/photos"},
		{"/photos//sub/./deep", "/photos/sub/deep"},
	}
	for _, c := range cases {
		if got := normalizeVolumePath(c.in); got != c.want {
			t.Fatalf("normalizeVolumePath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStatTypeString(t *testing.T) {
	cases := []struct {
		typ  uint8
		want string
	}{
		{meta.TypeDirectory, "directory"},
		{meta.TypeFile, "file"},
		{meta.TypeSymlink, "symlink"},
		{meta.TypeSocket, "other"},
	}
	for _, c := range cases {
		if got := statTypeString(c.typ); got != c.want {
			t.Fatalf("statTypeString(%d) = %q, want %q", c.typ, got, c.want)
		}
	}
}

// 目录时间是整个命令存在的理由，必须原样带出来（含纳秒）。
func TestStatResultOfCarriesDirectoryMtime(t *testing.T) {
	attr := meta.Attr{
		Typ:       meta.TypeDirectory,
		Mode:      0755,
		Length:    4096,
		Nlink:     3,
		Mtime:     1777690800,
		Mtimensec: 123456789,
	}
	got := statResultOf("/photos/sub/", 42, attr)

	if got.Path != "/photos/sub" {
		t.Fatalf("path = %q, want /photos/sub", got.Path)
	}
	if got.Type != "directory" || got.Mode != 0755 || got.Inode != 42 {
		t.Fatalf("type/mode/inode = %q/%04o/%d", got.Type, got.Mode, got.Inode)
	}
	if got.Mtime != 1777690800 || got.Mtimensec != 123456789 {
		t.Fatalf("mtime = %d.%09d, want 1777690800.123456789", got.Mtime, got.Mtimensec)
	}
}

func TestStatResultJSONKeysAreStable(t *testing.T) {
	// 控制面按字段名解析，改名等于破坏接口。
	b, err := json.Marshal(statResultOf("/a", 7, meta.Attr{Typ: meta.TypeFile, Mtime: 1}))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"path", "inode", "type", "mode", "uid", "gid", "size", "nlink", "mtime", "mtimensec"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing json key %q in %s", k, b)
		}
	}
	if _, ok := m["error"]; ok {
		t.Fatalf("success result should omit error: %s", b)
	}
}

// 批量解析时失败的路径要能和成功的区分开：只有 error 没有属性。
func TestStatResultErrorShape(t *testing.T) {
	b, err := json.Marshal(statResult{Path: "/photos/ghost", Error: "lookup ghost: no such file or directory"})
	if err != nil {
		t.Fatal(err)
	}
	var got statResult
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Error == "" || got.Path != "/photos/ghost" {
		t.Fatalf("%+v", got)
	}
	if got.Type != "" {
		t.Fatalf("failed result must not carry a type: %+v", got)
	}
}
