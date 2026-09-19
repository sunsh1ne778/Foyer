package foyer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactMetaURL(t *testing.T) {
	in := "redis://:s3cret@redis:6379/1"
	out := RedactMetaURL(in)
	if strings.Contains(out, "s3cret") {
		t.Fatalf("leaked: %s", out)
	}
	if !strings.Contains(out, "***") {
		t.Fatalf("expected redact: %s", out)
	}
	plain := "redis://redis:6379/1"
	if RedactMetaURL(plain) != plain {
		t.Fatalf("plain changed")
	}
}

func TestHealthJSONAndRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://:s3cret@redis:6379/1"}
	var m map[string]any
	if err := json.Unmarshal(HealthJSON(cfg), &m); err != nil {
		t.Fatal(err)
	}
	if m["ok"] != true || m["volume"] != "foyer" {
		t.Fatalf("%v", m)
	}
	if strings.Contains(m["meta"].(string), "s3cret") {
		t.Fatal("password in health")
	}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/health", nil))
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("ct %s", ct)
	}
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/import", strings.NewReader(`{}`)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("import empty src status %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/import", strings.NewReader(`{"src":"/host","mode":"copy"}`)))
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("copy mode status %d body %s", rr.Code, rr.Body.String())
	}
}

func TestImportDryRunRouteSkipsMountRecord(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{
		Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://127.0.0.1:6379/1",
		MountsFile: filepath.Join(dir, "mounts.json"), JuiceFSBin: writeFakeJuice(t, true),
	}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/import",
		strings.NewReader(`{"src":"/mnt/e/photos","dest":"/photos","name":"photos","dry_run":true}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body struct {
		OK     bool         `json:"ok"`
		Result ImportResult `json:"result"`
		Mount  *MountRecord `json:"mount"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Result.Scanned != 2 || body.Mount != nil {
		t.Fatalf("%+v", body)
	}
	if _, err := os.Stat(cfg.MountsFile); !os.IsNotExist(err) {
		t.Fatalf("dry-run must not write mounts file, err=%v", err)
	}
}

func seedMounts(t *testing.T, cfg Config) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(cfg.MountsFile), 0755); err != nil {
		t.Fatal(err)
	}
	seed := `[{"id":"photos","name":"photos","type":"local","status":"mounted",` +
		`"spec":{"root":"E:\\photos","dest":"/photos","mode":"metadata"}}]`
	if err := os.WriteFile(cfg.MountsFile, []byte(seed), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMountPatchRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json")}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/photos",
		strings.NewReader(`{"status":"unmounted"}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "unmounted") {
		t.Fatalf("body %s", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/photos",
		strings.NewReader(`{"status":"weird"}`)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad status accepted: %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/ghost",
		strings.NewReader(`{"status":"unmounted"}`)))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestMountDeleteRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json")}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/foyer/mounts/photos", nil))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/foyer/mounts/photos", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("second delete should 404, got %d", rr.Code)
	}
}

func TestMountResyncRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json"), JuiceFSBin: writeFakeJuice(t, true)}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/mounts/photos/resync", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"skipped":1`) {
		t.Fatalf("expected import summary in body, got %s", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/mounts/ghost/resync", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}
