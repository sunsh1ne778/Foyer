package foyer

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatArgsPassesEveryPathInOneInvocation(t *testing.T) {
	got := strings.Join(StatArgs(Config{MetaURL: "redis://redis:6379/1"}, []string{"/photos/a", "/photos/b"}), " ")
	want := "stat redis://redis:6379/1 /photos/a /photos/b"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestParseStatResultsSkipsLogLines(t *testing.T) {
	text := "2026/09/19 03:36:01 juicefs[315] <INFO>: close session 0: <nil>\n" +
		`{"path":"/photos/sub","inode":42,"type":"directory","mode":493,"uid":0,"gid":0,"size":4096,"nlink":3,"mtime":1777690800,"mtimensec":123456789}` + "\n" +
		`{"path":"/photos/ghost","error":"lookup ghost: no such file or directory"}` + "\n"
	got, err := parseStatResults(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d results: %+v", len(got), got)
	}
	// 目录时间是这个端点存在的唯一理由，别在解析路上丢掉。
	if got[0].Mtime != 1777690800 || got[0].Mtimensec != 123456789 {
		t.Fatalf("mtime = %d.%09d", got[0].Mtime, got[0].Mtimensec)
	}
	// 失败的路径要能和成功的区分开。
	if got[1].Error == "" || got[1].Type != "" {
		t.Fatalf("failed entry should carry error only: %+v", got[1])
	}
}

func TestParseStatResultsFailsWithoutJSON(t *testing.T) {
	if _, err := parseStatResults("lookup nope: no such file or directory"); err == nil {
		t.Fatal("expected error")
	}
}

func TestStatParsesAttributesForEachPath(t *testing.T) {
	r := Runner{Bin: writeFakeJuice(t, true)}
	got, err := r.Stat(Config{MetaURL: "redis://x"}, []string{"/photos/a", "/photos/b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Path != "/photos/a" || got[1].Path != "/photos/b" {
		t.Fatalf("%+v", got)
	}
	if got[1].Type != "directory" || got[1].Mtime != 1777690800 {
		t.Fatalf("%+v", got[1])
	}
}

func TestStatRouteReturnsAttributes(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json"), JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/stat?path=/photos/sub", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	for _, want := range []string{`"type":"directory"`, `"mtime":1777690800`, `"ok":true`, `"stats"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body %s missing %s", body, want)
		}
	}
}

func TestStatRouteAcceptsRepeatedPathParams(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json"), JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/stat?path=/photos/a&path=/photos/b", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if n := strings.Count(rr.Body.String(), `"inode":42`); n != 2 {
		t.Fatalf("expected 2 stats, got %d: %s", n, rr.Body.String())
	}
}

func TestStatRouteRequiresPath(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json"), JuiceFSBin: writeFakeJuice(t, true)}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/stat", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/stat?path=/a", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rr.Code)
	}
}
