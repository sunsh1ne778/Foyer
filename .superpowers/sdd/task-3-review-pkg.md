## files


===== exec.go =====

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


===== exec_test.go =====

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
	if runtime.GOOS == "windows" {
		return writeFakeJuiceGo(t, dir, statusOK)
	}
	path := filepath.Join(dir, "juicefs")
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

func writeFakeJuiceGo(t *testing.T, dir string, statusOK bool) string {
	t.Helper()
	statusExit := "1"
	if statusOK {
		statusExit = "0"
	}
	src := `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "status":
		os.Exit(` + statusExit + `)
	case "format":
		out := filepath.Join(filepath.Dir(os.Args[0]), "out.txt")
		_ = os.WriteFile(out, []byte("FORMAT "+strings.Join(os.Args[1:], " ")), 0644)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown: %s\n", os.Args[1])
		os.Exit(2)
	}
}
`
	srcPath := filepath.Join(dir, "fakejuice.go")
	if err := os.WriteFile(srcPath, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "juicefs.exe")
	cmd := exec.Command("go", "build", "-o", out, srcPath)
	cmd.Dir = dir
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake juicefs: %v\n%s", err, outBytes)
	}
	return out
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

