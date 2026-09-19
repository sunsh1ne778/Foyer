package foyer

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMapHostPathAnyDrive(t *testing.T) {
	cfg := Config{}
	got, err := MapHostPath(cfg, `D:\photos\raw`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "/mnt/d/photos/raw" {
		t.Fatalf("got %s", got)
	}
	root, err := MapHostPath(cfg, `E:\`)
	if err != nil || root != "/mnt/e" {
		t.Fatalf("%s %v", root, err)
	}
}

func TestMapHostPathUnderHostData(t *testing.T) {
	cfg := Config{HostData: `E:\photos`, HostMount: "/host"}
	got, err := MapHostPath(cfg, `E:\photos\raw\a.jpg`)
	if err != nil {
		t.Fatal(err)
	}
	if got != "/mnt/e/photos/raw/a.jpg" {
		t.Fatalf("got %s", got)
	}
}

func TestMapHostPathAlreadyContainer(t *testing.T) {
	cfg := Config{}
	got, err := MapHostPath(cfg, "/mnt/e/raw")
	if err != nil || got != "/mnt/e/raw" {
		t.Fatalf("%s %v", got, err)
	}
}

func TestFileURI(t *testing.T) {
	if g := FileURI("/mnt/e/raw"); g != "file:///mnt/e/raw/" {
		t.Fatal(g)
	}
}

// 文件名里的 # 不能被下游 url.Parse 当成 fragment 吃掉，否则导入路径会被
// 截断到父目录（G:\20260619\#整理完成 变成 G:\20260619）。
func TestFileURIEncodesReservedChars(t *testing.T) {
	got := FileURI("/mnt/g/20260619/#整理完成")
	if strings.Contains(got, "#") {
		t.Fatalf("raw # must be escaped: %s", got)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if u.Fragment != "" {
		t.Fatalf("unexpected fragment %q in %s", u.Fragment, got)
	}
	if want := "/mnt/g/20260619/#整理完成/"; u.Path != want {
		t.Fatalf("round-trip: got %q want %q (uri %s)", u.Path, want, got)
	}
}

func TestDetectHostDrivesUsesConfiguredBase(t *testing.T) {
	mnt := t.TempDir()
	for _, name := range []string{"g", "toolong"} {
		if err := os.MkdirAll(filepath.Join(mnt, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	got := DetectHostDrives(mnt)
	if len(got) != 1 || got[0] != `G:\` {
		t.Fatalf("got %v", got)
	}
	if DetectHostDrives(filepath.Join(mnt, "missing")) != nil {
		t.Fatal("missing base must yield nil")
	}
}

func TestMapHostPathUsesConfiguredBase(t *testing.T) {
	cfg := Config{HostMountBase: t.TempDir()}
	got, err := MapHostPath(cfg, `G:\20260619`)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.ToSlash(cfg.HostMountBase) + "/g/20260619"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestHostPathFromContainer(t *testing.T) {
	cfg := Config{}
	cases := []struct{ in, want string }{
		{"/mnt/g", `G:\`},
		{"/mnt/g/20260619", `G:\20260619`},
		{"/mnt/g/20260619/#整理完成", `G:\20260619\#整理完成`},
		{"/mnt/d/photos/raw", `D:\photos\raw`},
		{"/mnt/c/Program Files/a", `C:\Program Files\a`},
	}
	for _, c := range cases {
		got, err := HostPathFromContainer(cfg, c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("%s: got %q want %q", c.in, got, c.want)
		}
	}
	// 绑定根自身不是某个盘符目录；非盘符路径一律拒绝。
	for _, bad := range []string{"/mnt", "/etc", "/host", "/mnt/gg/x", ""} {
		if got, err := HostPathFromContainer(cfg, bad); err == nil {
			t.Fatalf("%q should fail, got %q", bad, got)
		}
	}
}

// HostMountBase 没有前导斜杠时（Windows 上 env 配成 C:/mnt 这类），
// 反向映射必须仍能工作——Browse 的测试夹具正是这种形状。
func TestHostPathFromContainerWithoutLeadingSlashBase(t *testing.T) {
	cfg := Config{HostMountBase: "C:/data/mnt"}
	got, err := HostPathFromContainer(cfg, "C:/data/mnt/g/20260619")
	if err != nil {
		t.Fatal(err)
	}
	if got != `G:\20260619` {
		t.Fatalf("got %q", got)
	}
	// 绑定根自身仍必须被拒。
	if got, err := HostPathFromContainer(cfg, "C:/data/mnt"); err == nil {
		t.Fatalf("bind root should fail, got %q", got)
	}
}

// 回填给前端的路径必须能被 MapHostPath 原样还原，否则 resync 会落到别的目录。
func TestHostPathRoundTrip(t *testing.T) {
	cfg := Config{}
	for _, host := range []string{`G:\`, `G:\20260619`, `G:\20260619\#整理完成`, `D:\photos\raw`, `E:\a b\中 文`} {
		container, err := MapHostPath(cfg, host)
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		back, err := HostPathFromContainer(cfg, container)
		if err != nil {
			t.Fatalf("%s -> %s: %v", host, container, err)
		}
		if back != host {
			t.Fatalf("round trip %q -> %q -> %q", host, container, back)
		}
	}
}
