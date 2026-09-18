package foyer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
}
