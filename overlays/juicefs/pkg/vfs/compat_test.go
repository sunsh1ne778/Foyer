package vfs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

func TestSkipInternalKey(t *testing.T) {
	if !SkipInternalKey("foyer/chunks/0/1/2", "foyer") {
		t.Fatal("volume prefix")
	}
	if !SkipInternalKey("chunks/0/1/2", "") {
		t.Fatal("chunks")
	}
	if SkipInternalKey("photos/a.jpg", "foyer") {
		t.Fatal("user object")
	}
}

// isInternalKey 与 SkipInternalKey 的区别是它不把「目录」本身当成内部键，
// 因此目录 mtime 回写时可以用它判断用户目录。这条断言必须放在 vfs 包内，
// 因为 isInternalKey 是未导出函数。
func TestIsInternalKeyDoesNotSkipUserDirs(t *testing.T) {
	cases := []struct {
		key, volume string
		want        bool
	}{
		{"chunks/0/1/", "", true},
		{"foyer/", "foyer", true},
		{"foyer/chunks/0/", "foyer", true},
		{"photos/", "foyer", false},
		{"photos/a.jpg", "foyer", false},
	}
	for _, c := range cases {
		if got := isInternalKey(c.key, c.volume); got != c.want {
			t.Fatalf("isInternalKey(%q, %q) = %v, want %v", c.key, c.volume, got, c.want)
		}
	}
}

func TestJoinImportPath(t *testing.T) {
	if g := JoinImportPath("/imported", "a/b.txt"); g != "/imported/a/b.txt" {
		t.Fatal(g)
	}
	if g := JoinImportPath("/", "a.txt"); g != "/a.txt" {
		t.Fatal(g)
	}
}

// SkipInternalDirKey 供 cmd 包判断「这个目录是否属于卷自身」，因此必须导出。
// 它与 isInternalKey 同语义，但不套用 SkipInternalKey 的「尾斜杠即内部键」规则。
func TestSkipInternalDirKey(t *testing.T) {
	cases := []struct {
		key, volume string
		want        bool
	}{
		{"chunks/0/1", "", true},
		{"foyer", "foyer", true},
		{"foyer/chunks/0", "foyer", true},
		{"photos", "foyer", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := SkipInternalDirKey(c.key, c.volume); got != c.want {
			t.Fatalf("SkipInternalDirKey(%q, %q) = %v, want %v", c.key, c.volume, got, c.want)
		}
	}
}

func TestObjectFileReader(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello-compat"), 0644); err != nil {
		t.Fatal(err)
	}
	// 走生产同款路径：OpenStorageURI 会为 file:// 端点补上结尾斜杠，
	// 而 object.CreateStorage("file", ...) 不会，直接用它拼出的 key 路径会缺分隔符。
	store, err := OpenStorageURI(dir)
	if err != nil {
		t.Fatal(err)
	}
	f := &objectFileReader{key: "hello.txt", blob: store, length: 12}
	buf := make([]byte, 7)
	n, eno := f.Read(meta.Background(), 0, buf)
	if eno != 0 || n != 7 || string(buf) != "hello-c" {
		t.Fatalf("n=%d eno=%v %q", n, eno, buf)
	}
	buf = make([]byte, 20)
	n, eno = f.Read(meta.Background(), 6, buf)
	if eno != 0 || string(buf[:n]) != "compat" {
		t.Fatalf("n=%d eno=%v %q", n, eno, buf[:n])
	}
	n, eno = f.Read(meta.Background(), 12, buf)
	if eno != 0 || n != 0 {
		t.Fatalf("eof n=%d eno=%v", n, eno)
	}
}

func TestOpenStorageURIFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x.bin"), []byte("abc"), 0644); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStorageURI(dir)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := store.Get("x.bin", 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b := make([]byte, 3)
	if _, err := rc.Read(b); err != nil && string(b) != "abc" {
		t.Fatalf("%q %v", b, err)
	}
}
