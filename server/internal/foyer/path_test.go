package foyer

import (
	"net/url"
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
