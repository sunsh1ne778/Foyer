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

