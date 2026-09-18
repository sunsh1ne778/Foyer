# JuiceFS Distro (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin official JuiceFS as a submodule, ship a `foyer` process that formats (idempotent) then serves S3 Gateway plus `/foyer/health`, and prove put/get against RustFS via compose.

**Architecture:** Do not import JuiceFS into module `filestore` (MinIO/FUSE would explode `server/go.mod`). Build the official CLI from `third_party/juicefs`. `server/cmd/foyer` is a small supervisor: HTTP admin in-process, `juicefs format`/`status`/`gateway` via `exec`. FastDFS is an overlay file copied onto `pkg/object` at build time so the upstream submodule commit stays stock.

**Tech Stack:** JuiceFS v1.3.0 (git submodule), Go 1.23 in the foyer image, Redis DB 1 for JuiceFS meta, RustFS as MinIO-compatible object store, Gin not required (stdlib `net/http` for admin).

## Global Constraints

- Git submodule only: `third_party/juicefs` → `https://github.com/juicedata/juicefs.git` pinned to tag `v1.3.0`. No vendored full-tree copy of JuiceFS in the parent repo.
- Do not modify JuiceFS chunking, POSIX, `pkg/meta`, or `pkg/vfs` semantics.
- Do not delete or rewrite `server/internal/vfs` or `/v1`; compose `api`/`worker` stay on `profiles: ["app"]`.
- Do not change `scripts/run-api.ps1` behavior.
- Do not implement quota, directory stats, lifecycle, audit, multi-tenant console, or Windows FUSE.
- Do not enable FastDFS in compose; overlay Register only.
- Redis JuiceFS meta URL in compose: `redis://redis:6379/1` (DB 0 remains for the old stack).
- Object bucket for JuiceFS chunks: `jfs` (do not reuse `filestore` used by the old VFS).
- Host ports: Gateway `19002`, admin `8092`. Container: Gateway `:9002`, admin `:8092`.
- Gateway credentials (MinIO convention, ≥8 char secret): `MINIO_ROOT_USER=foyerak`, `MINIO_ROOT_PASSWORD=foyersecret`.
- Env names: `FOYER_META_URL`, `FOYER_STORAGE`, `FOYER_BUCKET`, `FOYER_ACCESS_KEY`, `FOYER_SECRET_KEY`, `FOYER_GATEWAY_LISTEN`, `FOYER_ADMIN_LISTEN`, `FOYER_VOLUME`, `FOYER_JUICEFS_BIN`.
- Skip `juicefs format` when `juicefs status $FOYER_META_URL` exits 0.
- `/foyer/health` is unauthenticated. Strip passwords from any meta URL in JSON.
- Overlay path: `overlays/juicefs/` copied onto `third_party/juicefs/` before compiling JuiceFS.
- Commits: follow the operator's git rules; the commit steps below are optional if the user forbade committing.

## File map

| Path | Role |
|------|------|
| `.gitmodules` | Submodule pin |
| `third_party/juicefs/` | Upstream at v1.3.0 |
| `overlays/juicefs/pkg/object/fastdfs.go` | `Register("fastdfs", …)` skeleton |
| `server/internal/foyer/health.go` | Health JSON + URL redaction |
| `server/internal/foyer/health_test.go` | Tests |
| `server/internal/foyer/exec.go` | `JuiceFS` runner (`Status`/`Format`/`Gateway`) |
| `server/internal/foyer/exec_test.go` | Fake-binary tests |
| `server/internal/foyer/config.go` | Load env into `Config` |
| `server/internal/foyer/config_test.go` | Tests |
| `server/cmd/foyer/main.go` | Admin goroutine then format/gateway |
| `deploy/foyer/Dockerfile` | Build juicefs (with overlay) + foyer supervisor |
| `deploy/compose.yml` | `jfs` bucket + `foyer` service on profile `juicefs` |
| `scripts/apply-juicefs-overlay.ps1` | Copy overlay for local juicefs builds |
| `scripts/run-foyer.ps1` | `compose --profile juicefs up` |
| `README.md` | Verify with aws/mc |

---

### Task 1: JuiceFS submodule at v1.3.0

**Files:**
- Create: `.gitmodules`
- Create: `third_party/juicefs/` (submodule checkout)
- Modify: `.gitignore` only if it currently ignores `third_party/`

**Interfaces:**
- Consumes: nothing
- Produces: directory `third_party/juicefs` with `go.mod` module `github.com/juicedata/juicefs` and tag `v1.3.0`

- [ ] **Step 1: Confirm third_party is not gitignored**

Run from repo root (PowerShell):

```powershell
Select-String -Path .gitignore -Pattern "third_party" -ErrorAction SilentlyContinue
```

Expected: no rule that ignores `third_party/`. If there is, delete that line.

- [ ] **Step 2: Add submodule pinned to v1.3.0**

```powershell
git submodule add -b v1.3.0 https://github.com/juicedata/juicefs.git third_party/juicefs
cd third_party/juicefs
git checkout v1.3.0
cd ../..
```

If `add` fails because the folder exists, remove the empty folder first. Expected: `.gitmodules` contains `path = third_party/juicefs` and `url = https://github.com/juicedata/juicefs.git`.

- [ ] **Step 3: Verify the pin**

```powershell
git -C third_party/juicefs describe --tags
```

Expected: `v1.3.0` (or `v1.3.0-0-g…` equivalent).

- [ ] **Step 4: Commit (optional)**

```powershell
git add .gitmodules third_party/juicefs
git commit -m "chore: vendor JuiceFS v1.3.0 as submodule"
```

---

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

### Task 3: JuiceFS exec runner (format skip + gateway argv)

**Files:**
- Create: `server/internal/foyer/exec.go`
- Create: `server/internal/foyer/exec_test.go`

**Interfaces:**
- Consumes: `Config`, `FOYER_JUICEFS_BIN`
- Produces:

```go
type Runner struct {
	Bin string
	Env []string // extra env for child; if nil, use os.Environ
}

func (r Runner) Status(metaURL string) error
func (r Runner) Format(cfg Config) error
func (r Runner) Gateway(cfg Config) error
func (r Runner) EnsureVolume(cfg Config) error // Status OK → nil; else Format
func FormatArgs(cfg Config) []string
func GatewayArgs(cfg Config) []string
```

`FormatArgs` must be:

```text
format
--storage {Storage}
--bucket {Bucket}
--access-key {AccessKey}
--secret-key {SecretKey}
{MetaURL}
{Volume}
```

`GatewayArgs` must be:

```text
gateway
{MetaURL}
{GatewayListen}
```

`Status` runs `{Bin} status {MetaURL}`. Non-zero exit → error.

`EnsureVolume`: if `Status` == nil, return nil; else `Format`.

`Gateway` runs `{Bin} gateway …` and **blocks** (inherits stdout/stderr). Tests must not call `Gateway`; they only test argv and `EnsureVolume` with a fake executable.

- [ ] **Step 1: Write failing tests**

`server/internal/foyer/exec_test.go`:

```go
package foyer

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFormatAndGatewayArgs(t *testing.T) {
	cfg := Config{
		Storage: "minio", Bucket: "http://rustfs:9000/jfs",
		AccessKey: "ak", SecretKey: "sk",
		MetaURL: "redis://redis:6379/1", Volume: "foyer",
		GatewayListen: "0.0.0.0:9002",
	}
	fa := strings.Join(FormatArgs(cfg), " ")
	if !strings.Contains(fa, "--storage minio") || !strings.Contains(fa, "foyer") {
		t.Fatal(fa)
	}
	ga := GatewayArgs(cfg)
	if len(ga) != 3 || ga[0] != "gateway" || ga[2] != "0.0.0.0:9002" {
		t.Fatalf("%v", ga)
	}
}

func writeFakeJuice(t *testing.T, statusOK bool) string {
	t.Helper()
	dir := t.TempDir()
	var path string
	if runtime.GOOS == "windows" {
		path = filepath.Join(dir, "juicefs.cmd")
		body := "@echo off\r\n"
		if statusOK {
			body += "if \"%~1\"==\"status\" exit /b 0\r\n"
		} else {
			body += "if \"%~1\"==\"status\" exit /b 1\r\n"
		}
		body += "if \"%~1\"==\"format\" echo FORMAT %* > \"%~dp0out.txt\" & exit /b 0\r\n"
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	path = filepath.Join(dir, "juicefs")
	script := "#!/bin/sh\n"
	if statusOK {
		script += "if [ \"$1\" = status ]; then exit 0; fi\n"
	} else {
		script += "if [ \"$1\" = status ]; then exit 1; fi\n"
	}
	script += "if [ \"$1\" = format ]; then echo FORMAT \"$@\" > \"$(dirname \"$0\")/out.txt\"; exit 0; fi\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEnsureVolumeSkipsFormatWhenStatusOK(t *testing.T) {
	bin := writeFakeJuice(t, true)
	r := Runner{Bin: bin}
	cfg := Config{MetaURL: "redis://x", Volume: "foyer", Storage: "minio", Bucket: "b", AccessKey: "a", SecretKey: "s"}
	if err := r.EnsureVolume(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(bin), "out.txt")); err == nil {
		t.Fatal("format should not run")
	}
}

func TestEnsureVolumeFormatsWhenStatusFails(t *testing.T) {
	bin := writeFakeJuice(t, false)
	r := Runner{Bin: bin}
	cfg := Config{MetaURL: "redis://x", Volume: "foyer", Storage: "minio", Bucket: "b", AccessKey: "a", SecretKey: "s"}
	if err := r.EnsureVolume(cfg); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		// cmd.exe fake may not write out.txt depending on quoting; still require EnsureVolume success
		return
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(bin), "out.txt"))
	if err != nil || !strings.Contains(string(b), "FORMAT") {
		t.Fatalf("format output: %s %v", b, err)
	}
}

func TestRunnerUsesConfiguredBin(t *testing.T) {
	if _, err := exec.LookPath("this-bin-does-not-exist-foyer"); err == nil {
		t.Skip("unexpected")
	}
	r := Runner{Bin: "this-bin-does-not-exist-foyer"}
	if err := r.Status("redis://x"); err == nil {
		t.Fatal("expected error")
	}
}
```

On Windows, if `.cmd` status/format detection is flaky, implement `writeFakeJuice` as a tiny Go program built with `go build -o juicefs.exe` in TempDir (still in this test file) that switches on `os.Args[1]`. Prefer that if the `.cmd` approach fails in Step 4.

- [ ] **Step 2: Run tests (expect fail)**

```powershell
cd server
go test ./internal/foyer -count=1
```

Expected: FAIL (`FormatArgs` undefined).

- [ ] **Step 3: Implement**

`server/internal/foyer/exec.go`:

```go
package foyer

import (
	"fmt"
	"os"
	"os/exec"
)

type Runner struct {
	Bin string
	Env []string
}

func FormatArgs(cfg Config) []string {
	return []string{
		"format",
		"--storage", cfg.Storage,
		"--bucket", cfg.Bucket,
		"--access-key", cfg.AccessKey,
		"--secret-key", cfg.SecretKey,
		cfg.MetaURL,
		cfg.Volume,
	}
}

func GatewayArgs(cfg Config) []string {
	return []string{"gateway", cfg.MetaURL, cfg.GatewayListen}
}

func (r Runner) cmd(args ...string) *exec.Cmd {
	c := exec.Command(r.Bin, args...)
	if r.Env != nil {
		c.Env = r.Env
	} else {
		c.Env = os.Environ()
	}
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c
}

func (r Runner) Status(metaURL string) error {
	return r.cmd("status", metaURL).Run()
}

func (r Runner) Format(cfg Config) error {
	if err := r.cmd(FormatArgs(cfg)...).Run(); err != nil {
		return fmt.Errorf("juicefs format: %w", err)
	}
	return nil
}

func (r Runner) Gateway(cfg Config) error {
	if err := r.cmd(GatewayArgs(cfg)...).Run(); err != nil {
		return fmt.Errorf("juicefs gateway: %w", err)
	}
	return nil
}

func (r Runner) EnsureVolume(cfg Config) error {
	if err := r.Status(cfg.MetaURL); err == nil {
		return nil
	}
	return r.Format(cfg)
}
```

- [ ] **Step 4: Run tests (expect pass)**

```powershell
cd server
go test ./internal/foyer -count=1
```

Expected: `PASS`. If Windows fake juicefs fails, replace `writeFakeJuice` with `go build` of a 15-line `package main` in `t.TempDir()` as described in Step 1.

- [ ] **Step 5: Commit (optional)**

```powershell
git add server/internal/foyer/exec.go server/internal/foyer/exec_test.go
git commit -m "feat: add juicefs format/status/gateway supervisor helpers"
```

---

### Task 4: `foyer` supervisor binary

**Files:**
- Create: `server/cmd/foyer/main.go`

**Interfaces:**
- Consumes: `LoadConfig`, `NewHealthMux`, `Runner.EnsureVolume`, `Runner.Gateway`
- Produces: command `go build -o foyer ./cmd/foyer` from `server/`

Before `Gateway`, set (if unset in the process env, still set from Config so the child sees them):

- `MINIO_ROOT_USER` = `cfg.GatewayRootUser`
- `MINIO_ROOT_PASSWORD` = `cfg.GatewayRootPass`

Start `http.ListenAndServe(cfg.AdminListen, NewHealthMux(cfg))` in a goroutine. Then `EnsureVolume` then `Gateway`. If `EnsureVolume` fails, `os.Exit(1)`. `Gateway` returning is fatal (`os.Exit(1)`).

- [ ] **Step 1: Write main**

`server/cmd/foyer/main.go`:

```go
package main

import (
	"log"
	"net/http"
	"os"

	"filestore/internal/foyer"
)

func main() {
	cfg := foyer.LoadConfig()
	go func() {
		log.Printf("foyer admin on %s", cfg.AdminListen)
		if err := http.ListenAndServe(cfg.AdminListen, foyer.NewHealthMux(cfg)); err != nil {
			log.Printf("admin server: %v", err)
		}
	}()
	_ = os.Setenv("MINIO_ROOT_USER", cfg.GatewayRootUser)
	_ = os.Setenv("MINIO_ROOT_PASSWORD", cfg.GatewayRootPass)
	r := foyer.Runner{Bin: cfg.JuiceFSBin}
	if err := r.EnsureVolume(cfg); err != nil {
		log.Fatal(err)
	}
	log.Printf("foyer gateway %s volume=%s", cfg.GatewayListen, cfg.Volume)
	if err := r.Gateway(cfg); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 2: Compile supervisor (juicefs binary may be missing; that is OK)**

```powershell
cd server
go build -o foyer.exe ./cmd/foyer
```

Expected: exit 0, `foyer.exe` created. Do not run it yet without juicefs.

- [ ] **Step 3: Commit (optional)**

```powershell
git add server/cmd/foyer/main.go
git commit -m "feat: add foyer supervisor command"
```

---

### Task 5: FastDFS overlay (compiled into juicefs, not used in compose)

**Files:**
- Create: `overlays/juicefs/pkg/object/fastdfs.go`
- Create: `scripts/apply-juicefs-overlay.ps1`

**Interfaces:**
- Consumes: JuiceFS v1.3.0 `pkg/object.Register` and `Creator` (`func(bucket, accessKey, secretKey, token string) (ObjectStorage, error)`)
- Produces: storage name `fastdfs`. Constructor returns `(nil, fmt.Errorf("fastdfs storage is not implemented"))`.

- [ ] **Step 1: Overlay source**

`overlays/juicefs/pkg/object/fastdfs.go`:

```go
package object

import "fmt"

func init() {
	Register("fastdfs", newFastDFS)
}

func newFastDFS(endpoint, accessKey, secretKey, token string) (ObjectStorage, error) {
	return nil, fmt.Errorf("fastdfs storage is not implemented")
}
```

- [ ] **Step 2: Apply script**

`scripts/apply-juicefs-overlay.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "overlays\juicefs"
$dst = Join-Path $root "third_party\juicefs"
if (-not (Test-Path $dst)) { throw "missing submodule $dst" }
Copy-Item -Path (Join-Path $src "pkg\object\fastdfs.go") -Destination (Join-Path $dst "pkg\object\fastdfs.go") -Force
Write-Host "overlay applied"
```

- [ ] **Step 3: Apply and test Register inside JuiceFS module**

```powershell
.\scripts\apply-juicefs-overlay.ps1
cd third_party\juicefs
go test ./pkg/object -count=1 -run DoesNotExist
```

Expected: `no tests to run` or `PASS` (package still compiles). Then:

```powershell
go test ./pkg/object -count=1 -c -o NUL
```

If `-c -o NUL` is awkward on Windows:

```powershell
go test ./pkg/object -count=1
```

Expected: existing JuiceFS object tests pass **or** fail only for missing cloud credentials; they must **compile**. If `fastdfs.go` breaks build, fix types to match v1.3.0 `Creator`.

Add a tiny test in overlay copied as `overlays/juicefs/pkg/object/fastdfs_test.go`:

```go
package object

import "testing"

func TestFastDFSRegisteredNotImplemented(t *testing.T) {
	_, err := CreateStorage("fastdfs", "http://x", "", "", "")
	if err == nil || err.Error() != "fastdfs storage is not implemented" {
		t.Fatalf("err=%v", err)
	}
}
```

Copy it in `apply-juicefs-overlay.ps1` as well. Re-run:

```powershell
cd third_party\juicefs
go test ./pkg/object -count=1 -run TestFastDFSRegisteredNotImplemented
```

Expected: `PASS`.

Do not `git add` files under `third_party/juicefs` except the submodule gitlink from Task 1. Overlay files live only in `overlays/` and scripts.

- [ ] **Step 4: Commit overlay (optional)**

```powershell
git add overlays/juicefs/pkg/object/fastdfs.go overlays/juicefs/pkg/object/fastdfs_test.go scripts/apply-juicefs-overlay.ps1
git commit -m "feat: add FastDFS JuiceFS storage stub overlay"
```

---

### Task 6: Docker image + compose profile `juicefs`

**Files:**
- Create: `deploy/foyer/Dockerfile`
- Create: `scripts/run-foyer.ps1`
- Modify: `deploy/compose.yml` (`rustfs-init` create `jfs` bucket; add `foyer` service)

**Interfaces:**
- Consumes: Task 4 binary, Task 5 overlay, Task 1 submodule
- Produces: `docker compose --profile juicefs up` with Gateway on host `19002` and health on host `8092`

Dockerfile (build context = **repository root**):

```dockerfile
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY third_party/juicefs /src/juicefs
COPY overlays/juicefs/pkg/object/fastdfs.go /src/juicefs/pkg/object/fastdfs.go
WORKDIR /src/juicefs
ENV CGO_ENABLED=0
RUN go build -o /out/juicefs .

WORKDIR /src/foyer
COPY server /src/foyer
WORKDIR /src/foyer
RUN go build -o /out/foyer ./cmd/foyer

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/juicefs /usr/local/bin/juicefs
COPY --from=build /out/foyer /usr/local/bin/foyer
ENV FOYER_JUICEFS_BIN=/usr/local/bin/juicefs
ENTRYPOINT ["/usr/local/bin/foyer"]
```

If `go build` of juicefs fails with CGO/fuse: set `CGO_ENABLED=1`, `apt-get install gcc libfuse3-dev` in the build stage, and keep gateway (do not pass `-tags nogateway`).

`rustfs-init` command becomes:

```yaml
        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
          aws --endpoint-url http://rustfs:9000 s3 mb s3://filestore && break
          sleep 3
        done
        aws --endpoint-url http://rustfs:9000 s3 mb s3://jfs || true
        true
```

Add service (same file, after `rustfs-init`):

```yaml
  foyer:
    profiles: ["juicefs"]
    build:
      context: ..
      dockerfile: deploy/foyer/Dockerfile
    ports:
      - "19002:9002"
      - "8092:8092"
    environment:
      FOYER_META_URL: redis://redis:6379/1
      FOYER_STORAGE: minio
      FOYER_BUCKET: http://rustfs:9000/jfs
      FOYER_ACCESS_KEY: rustfsadmin
      FOYER_SECRET_KEY: rustfsadmin
      FOYER_GATEWAY_LISTEN: "0.0.0.0:9002"
      FOYER_ADMIN_LISTEN: ":8092"
      FOYER_VOLUME: foyer
      FOYER_JUICEFS_BIN: /usr/local/bin/juicefs
      MINIO_ROOT_USER: foyerak
      MINIO_ROOT_PASSWORD: foyersecret
    depends_on:
      redis:
        condition: service_healthy
      rustfs:
        condition: service_started
      rustfs-init:
        condition: service_completed_successfully
```

If `rustfs-init` has no `service_completed_successfully` (no `restart: on-failure` and it exits 0), keep that condition. If compose version complains, use `depends_on: [redis, rustfs, rustfs-init]` without condition on init.

`scripts/run-foyer.ps1`:

```powershell
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
git submodule update --init --recursive
docker compose -f deploy/compose.yml --profile juicefs up --build
```

- [ ] **Step 1: Add Dockerfile, compose edits, run-foyer.ps1** as specified.

- [ ] **Step 2: Build image (network required)**

```powershell
git submodule update --init --recursive
docker compose -f deploy/compose.yml --profile juicefs build foyer
```

Expected: image build success. If JuiceFS compile fails, apply the CGO/fuse fallback in the Dockerfile and rebuild.

- [ ] **Step 3: Up and health**

```powershell
docker compose -f deploy/compose.yml --profile juicefs up -d foyer
curl.exe http://127.0.0.1:8092/foyer/health
```

Expected: JSON with `"ok":true`. Gateway logs should not fatal on format (first start formats; second start skips).

- [ ] **Step 4: Commit (optional)**

```powershell
git add deploy/foyer/Dockerfile deploy/compose.yml scripts/run-foyer.ps1
git commit -m "feat: compose JuiceFS S3 gateway behind foyer supervisor"
```

---

### Task 7: README verification (aws/mc)

**Files:**
- Modify: `README.md` (new section after 本地开发, do not remove existing API/Web instructions)

**Interfaces:**
- Consumes: ports `19002` / `8092`, keys `foyerak` / `foyersecret`
- Produces: documented put/get that matches the success criterion

- [ ] **Step 1: Append this section verbatim (adjust only if a port in compose differs)**

```markdown
## JuiceFS 发行版（第一期）

源码：`third_party/juicefs`（submodule，v1.3.0）。进程：`foyer` 监督官方 `juicefs gateway`。旧 `/v1` API 不变。

```powershell
git submodule update --init --recursive
.\scripts\run-foyer.ps1
```

或：`docker compose -f deploy/compose.yml --profile juicefs up --build`

| 用途 | 地址 |
|------|------|
| S3 Gateway | http://127.0.0.1:19002 |
| 管理健康检查 | http://127.0.0.1:8092/foyer/health |
| Gateway AK/SK | foyerak / foyersecret |

验证（AWS CLI）：

```powershell
$env:AWS_ACCESS_KEY_ID = "foyerak"
$env:AWS_SECRET_ACCESS_KEY = "foyersecret"
$env:AWS_DEFAULT_REGION = "us-east-1"
echo hello | Out-File -Encoding ascii hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 mb s3://foyer
aws --endpoint-url http://127.0.0.1:19002 s3 cp hello.txt s3://foyer/hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 cp s3://foyer/hello.txt hello-back.txt
Get-Content hello-back.txt
```

成功：读回内容含 `hello`。JuiceFS 默认桶名与 `FOYER_VOLUME`（`foyer`）一致；若 `mb` 报已存在，直接 `cp`。

`mc` 等价：`mc alias set foyer http://127.0.0.1:19002 foyerak foyersecret` 然后 `mc cp hello.txt foyer/foyer/hello.txt`。
```

Note: JuiceFS gateway `--bucket-name` defaults to volume name `foyer`. The `s3 mb s3://foyer` may be unnecessary if the gateway already exposes that bucket; if `mb` fails with “already exists” or “invalid”, document `cp` to `s3://foyer/hello.txt` only. Implementer: run once and keep the README matching actual gateway behavior.

- [ ] **Step 2: Run the aws commands against a live stack; paste the working variant into README if `mb` differs.**

- [ ] **Step 3: Commit (optional)**

```powershell
git add README.md
git commit -m "docs: JuiceFS gateway local verify steps"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| submodule pin | 1 |
| `foyer` starts gateway + `/foyer/health` | 2, 4 |
| compose Redis meta + RustFS | 6 |
| idempotent format | 3 |
| FastDFS Register skeleton, not in compose | 5, 6 |
| README aws/mc | 7 |
| ports 19002 / 8092 | 6 |
| env names | 2, 6 |
| old API profile unchanged | 6 (foyer on `juicefs` profile only) |
| no vfs rewrite / no FUSE / no quota | Global Constraints |

## Handoff

Plan saved to `docs/superpowers/plans/2026-09-18-juicefs-distro.md`.
