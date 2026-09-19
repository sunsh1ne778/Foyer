package cmd

import (
	"os"
	"testing"
	"time"

	"github.com/juicedata/juicefs/pkg/object"
)

// fakeFile 同时实现 object.Object 与 object.File，模拟本地文件源。
type fakeFile struct {
	key   string
	size  int64
	mtime time.Time
	mode  os.FileMode
	owner string
	group string
}

func (f fakeFile) Key() string          { return f.key }
func (f fakeFile) Size() int64          { return f.size }
func (f fakeFile) Mtime() time.Time     { return f.mtime }
func (f fakeFile) IsDir() bool          { return false }
func (f fakeFile) IsSymlink() bool      { return false }
func (f fakeFile) StorageClass() string { return "" }
func (f fakeFile) Owner() string        { return f.owner }
func (f fakeFile) Group() string        { return f.group }
func (f fakeFile) Mode() os.FileMode    { return f.mode }

// fakeObj 只实现 object.Object，模拟 S3 这类拿不到 mode/属主的源。
type fakeObj struct {
	key   string
	size  int64
	mtime time.Time
}

func (o fakeObj) Key() string          { return o.key }
func (o fakeObj) Size() int64          { return o.size }
func (o fakeObj) Mtime() time.Time     { return o.mtime }
func (o fakeObj) IsDir() bool          { return false }
func (o fakeObj) IsSymlink() bool      { return false }
func (o fakeObj) StorageClass() string { return "" }

// 断言假对象确实满足被测代码依赖的接口；写错方法签名时会在编译期暴露。
var (
	_ object.Object = fakeFile{}
	_ object.File   = fakeFile{}
	_ object.Object = fakeObj{}
)

var (
	uidOfRoot  = func(string) int { return 0 }
	gidOfRoot  = func(string) int { return 0 }
	uidUnknown = func(string) int { return -1 }
	gidUnknown = func(string) int { return -1 }
)

func TestMetadataForKeepsMtimeModeAndOwner(t *testing.T) {
	mt := time.Date(2026, 9, 1, 10, 20, 30, 123456789, time.UTC)
	o := fakeFile{key: "a.jpg", size: 3, mtime: mt, mode: 0644, owner: "root", group: "root"}

	got := metadataFor(o, uidOfRoot, gidOfRoot)
	if !got.Mtime.Equal(mt) {
		t.Fatalf("mtime = %s, want %s", got.Mtime, mt)
	}
	if got.Mode != 0444 {
		t.Fatalf("mode = %04o, want 0444 (源 0644 去掉写位)", got.Mode)
	}
	if !got.HasUid || got.Uid != 0 || !got.HasGid || got.Gid != 0 {
		t.Fatalf("owner = %+v, want uid/gid 0 marked present", got)
	}
}

func TestMetadataForZeroMtimeIsAbsent(t *testing.T) {
	got := metadataFor(fakeObj{key: "a.jpg", size: 3}, nil, nil)
	if !got.Mtime.IsZero() {
		t.Fatalf("mtime = %s, want zero", got.Mtime)
	}
	if got.Mode != 0 || got.HasUid || got.HasGid {
		t.Fatalf("unexpected metadata for plain object: %+v", got)
	}
}

func TestHasSourceMtimeRejectsZeroAndEpoch(t *testing.T) {
	cases := []struct {
		name string
		mt   time.Time
		want bool
	}{
		{"zero value", time.Time{}, false},
		// 多个后端的 CommonPrefixes 用 time.Unix(0,0) 表示"没有时间"。
		{"epoch", time.Unix(0, 0), false},
		{"epoch with nanos", time.Unix(0, 1), false},
		{"real time", time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC), true},
	}
	for _, c := range cases {
		if got := hasSourceMtime(c.mt); got != c.want {
			t.Fatalf("%s: hasSourceMtime(%s) = %v, want %v", c.name, c.mt, got, c.want)
		}
	}
}

func TestMetadataForTreatsEpochAsMissing(t *testing.T) {
	o := fakeFile{key: "a.jpg", mtime: time.Unix(0, 0), mode: 0644}

	if got := metadataFor(o, nil, nil); !got.Mtime.IsZero() {
		t.Fatalf("mtime = %s, want zero (epoch 视为缺失)", got.Mtime)
	}
}

func TestMetadataForUnresolvableOwnerSkipsChown(t *testing.T) {
	o := fakeFile{key: "a.jpg", mtime: time.Unix(100, 0), mode: 0600, owner: "nobody", group: "nogroup"}

	got := metadataFor(o, uidUnknown, gidUnknown)
	if got.HasUid || got.HasGid {
		t.Fatalf("owner should be absent when lookup fails: %+v", got)
	}
	if got.Mode != 0400 {
		t.Fatalf("mode = %04o, want 0400 (源 0600 去掉写位)", got.Mode)
	}
}

func TestMetadataForStripsWriteAndSpecialBits(t *testing.T) {
	o := fakeFile{key: "run.sh", mode: os.ModeDir | os.ModeSetuid | 0777}

	// 0777 -> 0555：写位（0222）剥掉，setuid/sticky 等特殊位与 ModeDir 不参与 Perm()。
	if got := metadataFor(o, nil, nil); got.Mode != 0555 {
		t.Fatalf("mode = %04o, want 0555", got.Mode)
	}
}

func TestImportDirPathTrimsTrailingSlash(t *testing.T) {
	cases := []struct{ dest, key, want string }{
		{"/photos", "a/b/", "/photos/a/b"},
		{"/", "a/", "/a"},
		{"/photos", "a", "/photos/a"},
	}
	for _, c := range cases {
		if got := ImportDirPath(c.dest, c.key); got != c.want {
			t.Fatalf("ImportDirPath(%q, %q) = %q, want %q", c.dest, c.key, got, c.want)
		}
	}
}

func TestDirKeyFromObject(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		volume  string
		wantKey string
		wantOK  bool
	}{
		// 源根目录 → "" ，它映射到 dest 本身；这是此前被漏掉、最显眼的那一层。
		{"source root", "", "", "", true},
		{"nested dir", "sub/deep/", "", "sub/deep", true},
		{"top level dir", "empty/", "", "empty", true},
		// 卷自身的目录不能回写。
		{"volume prefix", "foyer/", "foyer", "", false},
		{"volume chunks", "foyer/chunks/0/", "foyer", "", false},
		{"own chunks", "chunks/0/1/", "", "", false},
	}
	for _, c := range cases {
		gotKey, gotOK := dirKeyFromObject(c.key, c.volume)
		if gotOK != c.wantOK || (gotOK && gotKey != c.wantKey) {
			t.Fatalf("%s: dirKeyFromObject(%q, %q) = (%q, %v), want (%q, %v)",
				c.name, c.key, c.volume, gotKey, gotOK, c.wantKey, c.wantOK)
		}
	}
}
