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
