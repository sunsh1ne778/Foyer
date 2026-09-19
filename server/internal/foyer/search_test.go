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
