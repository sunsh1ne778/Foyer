### Task 2: Admin health JSON (no JuiceFS import)

**Files:**
- Create: `server/internal/foyer/config.go`
- Create: `server/internal/foyer/config_test.go`
- Create: `server/internal/foyer/health.go`
- Create: `server/internal/foyer/health_test.go`

**Interfaces:**
- Consumes: process environment
- Produces:

```go
package foyer

type Config struct {
	MetaURL        string
	Storage        string
	Bucket         string
	AccessKey      string
	SecretKey      string
	GatewayListen  string
	AdminListen    string
	Volume         string
	JuiceFSBin     string
	GatewayRootUser string
	GatewayRootPass string
}

func LoadConfig() Config
func RedactMetaURL(raw string) string
func HealthJSON(cfg Config) []byte
func NewHealthMux(cfg Config) http.Handler
```

`LoadConfig` mapping:

| Field | Env | Default |
|-------|-----|---------|
| MetaURL | `FOYER_META_URL` | `redis://127.0.0.1:6379/1` |
| Storage | `FOYER_STORAGE` | `minio` |
| Bucket | `FOYER_BUCKET` | `http://127.0.0.1:9000/jfs` |
| AccessKey | `FOYER_ACCESS_KEY` | `rustfsadmin` |
| SecretKey | `FOYER_SECRET_KEY` | `rustfsadmin` |
| GatewayListen | `FOYER_GATEWAY_LISTEN` | `:9002` |
| AdminListen | `FOYER_ADMIN_LISTEN` | `:8092` |
| Volume | `FOYER_VOLUME` | `foyer` |
| JuiceFSBin | `FOYER_JUICEFS_BIN` | `juicefs` |
| GatewayRootUser | `MINIO_ROOT_USER` | `foyerak` |
| GatewayRootPass | `MINIO_ROOT_PASSWORD` | `foyersecret` |

`HealthJSON` body (compact JSON):

```json
{"ok":true,"volume":"foyer","gateway":":9002","meta":"redis://127.0.0.1:6379/1"}
```

`RedactMetaURL`: if the URL has `user:pass@`, replace `pass` with `***`. Example: `redis://:secret@redis:6379/1` → `redis://:***@redis:6379/1`. URLs without password unchanged.

- [ ] **Step 1: Write failing tests**

`server/internal/foyer/config_test.go`:

```go
package foyer

import (
	"os"
	"testing"
)

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("FOYER_META_URL", "")
	os.Unsetenv("FOYER_META_URL")
	os.Unsetenv("FOYER_STORAGE")
	os.Unsetenv("FOYER_BUCKET")
	os.Unsetenv("FOYER_ACCESS_KEY")
	os.Unsetenv("FOYER_SECRET_KEY")
	os.Unsetenv("FOYER_GATEWAY_LISTEN")
	os.Unsetenv("FOYER_ADMIN_LISTEN")
	os.Unsetenv("FOYER_VOLUME")
	os.Unsetenv("FOYER_JUICEFS_BIN")
	os.Unsetenv("MINIO_ROOT_USER")
	os.Unsetenv("MINIO_ROOT_PASSWORD")
	cfg := LoadConfig()
	if cfg.Volume != "foyer" || cfg.GatewayListen != ":9002" || cfg.AdminListen != ":8092" {
		t.Fatalf("defaults: %+v", cfg)
	}
	if cfg.JuiceFSBin != "juicefs" || cfg.Storage != "minio" {
		t.Fatalf("defaults bin/storage: %+v", cfg)
	}
}

func TestLoadConfigEnv(t *testing.T) {
	t.Setenv("FOYER_VOLUME", "vol1")
	t.Setenv("FOYER_GATEWAY_LISTEN", ":1")
	cfg := LoadConfig()
	if cfg.Volume != "vol1" || cfg.GatewayListen != ":1" {
		t.Fatalf("%+v", cfg)
	}
}
```

`server/internal/foyer/health_test.go`:

```go
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
```

- [ ] **Step 2: Run tests (expect fail)**

```powershell
cd server
go test ./internal/foyer -count=1
```

Expected: FAIL compiling (`LoadConfig` undefined).

- [ ] **Step 3: Implement**

`server/internal/foyer/config.go`:

```go
package foyer

import "os"

type Config struct {
	MetaURL         string
	Storage         string
	Bucket          string
	AccessKey       string
	SecretKey       string
	GatewayListen   string
	AdminListen     string
	Volume          string
	JuiceFSBin      string
	GatewayRootUser string
	GatewayRootPass string
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func LoadConfig() Config {
	return Config{
		MetaURL:         envOr("FOYER_META_URL", "redis://127.0.0.1:6379/1"),
		Storage:         envOr("FOYER_STORAGE", "minio"),
		Bucket:          envOr("FOYER_BUCKET", "http://127.0.0.1:9000/jfs"),
		AccessKey:       envOr("FOYER_ACCESS_KEY", "rustfsadmin"),
		SecretKey:       envOr("FOYER_SECRET_KEY", "rustfsadmin"),
		GatewayListen:   envOr("FOYER_GATEWAY_LISTEN", ":9002"),
		AdminListen:     envOr("FOYER_ADMIN_LISTEN", ":8092"),
		Volume:          envOr("FOYER_VOLUME", "foyer"),
		JuiceFSBin:      envOr("FOYER_JUICEFS_BIN", "juicefs"),
		GatewayRootUser: envOr("MINIO_ROOT_USER", "foyerak"),
		GatewayRootPass: envOr("MINIO_ROOT_PASSWORD", "foyersecret"),
	}
}
```

`server/internal/foyer/health.go`:

```go
package foyer

import (
	"encoding/json"
	"net/http"
	"net/url"
)

func RedactMetaURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); !has {
		return raw
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	return u.String()
}

func HealthJSON(cfg Config) []byte {
	b, _ := json.Marshal(map[string]any{
		"ok":      true,
		"volume":  cfg.Volume,
		"gateway": cfg.GatewayListen,
		"meta":    RedactMetaURL(cfg.MetaURL),
	})
	return b
}

func NewHealthMux(cfg Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/foyer/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(HealthJSON(cfg))
	})
	return mux
}
```

- [ ] **Step 4: Run tests (expect pass)**

```powershell
cd server
go test ./internal/foyer -count=1
```

Expected: `PASS` for config + health. `exec_test.go` does not exist yet; if `go test` picks nothing else, OK.

- [ ] **Step 5: Commit (optional)**

```powershell
git add server/internal/foyer/config.go server/internal/foyer/config_test.go server/internal/foyer/health.go server/internal/foyer/health_test.go
git commit -m "feat: add foyer admin health JSON"
```

---

