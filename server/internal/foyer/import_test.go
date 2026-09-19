package foyer

import (
	"strings"
	"testing"
)

func TestImportArgsJSONAndDryRun(t *testing.T) {
	cfg := Config{MetaURL: "redis://redis:6379/1"}
	got := strings.Join(ImportArgs(cfg, "file:///mnt/e/photos/", "/photos", false), " ")
	want := "import --json redis://redis:6379/1 file:///mnt/e/photos/ /photos"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	got = strings.Join(ImportArgs(cfg, "file:///mnt/e/photos/", "/photos", true), " ")
	want = "import --json --dry-run redis://redis:6379/1 file:///mnt/e/photos/ /photos"
	if got != want {
		t.Fatalf("dry-run got %q want %q", got, want)
	}
}

func TestParseImportSummaryPicksJSONLine(t *testing.T) {
	text := "2026/09/18 23:00:00.000000 juicefs[1] <INFO>: scanning\n" +
		`{"dry_run":true,"dest":"/photos","scanned":3,"imported":0,"skipped":0,"objects":["a.jpg","b.jpg"]}` + "\n"
	res, err := parseImportSummary(text)
	if err != nil {
		t.Fatal(err)
	}
	if !res.DryRun || res.Scanned != 3 || res.Dest != "/photos" {
		t.Fatalf("%+v", res)
	}
	if len(res.Objects) != 2 || res.Objects[0] != "a.jpg" {
		t.Fatalf("objects %v", res.Objects)
	}
}

func TestParseImportSummaryIgnoresBracesInLogs(t *testing.T) {
	text := "<WARNING>: cannot parse {not json}\n" +
		`{"dry_run":false,"dest":"/photos","scanned":2,"imported":1,"skipped":1}` + "\n"
	res, err := parseImportSummary(text)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || res.Skipped != 1 || res.Scanned != 2 {
		t.Fatalf("%+v", res)
	}
}

func TestParseImportSummaryCarriesFidelityCounters(t *testing.T) {
	input := `{"dry_run":false,"dest":"/photos","scanned":3,"imported":2,"skipped":1,` +
		`"mtime_kept":2,"mtime_missing":0,"mode_kept":2,"owner_kept":1,"dir_mtime_kept":1}`
	got, err := parseImportSummary(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.MtimeKept != 2 || got.MtimeMissing != 0 || got.ModeKept != 2 || got.OwnerKept != 1 || got.DirMtimeKept != 1 {
		t.Fatalf("fidelity = %+v, want mtime 2/0 mode 2 owner 1 dir 1", got)
	}
}

func TestParseImportSummaryFailsWithoutJSON(t *testing.T) {
	if _, err := parseImportSummary("imported 0, skipped 0, scanned 0 -> /photos"); err == nil {
		t.Fatal("expected error")
	}
}
