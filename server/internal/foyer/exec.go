package foyer

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
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
		return fmt.Errorf("juicefs format: %w (if Redis was reset, empty object bucket %s then retry)", err, cfg.Bucket)
	}
	return nil
}

func (r Runner) Gateway(cfg Config) error {
	if err := r.cmd(GatewayArgs(cfg)...).Run(); err != nil {
		return fmt.Errorf("juicefs gateway: %w", err)
	}
	return nil
}

func (r Runner) Import(cfg Config, src, dest string, dryRun bool) (ImportResult, error) {
	c := r.cmd(ImportArgs(cfg, src, dest, dryRun)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return ImportResult{}, fmt.Errorf("juicefs import: %s", lastLine(msg))
		}
		return ImportResult{}, fmt.Errorf("juicefs import: %w", err)
	}
	res, perr := parseImportSummary(text)
	if perr != nil {
		return ImportResult{}, fmt.Errorf("juicefs import: %w", perr)
	}
	return res, nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// Stat reads metadata for one or more paths in a single juicefs invocation.
// Read-only.
func (r Runner) Stat(cfg Config, paths []string) ([]StatResult, error) {
	c := r.cmd(StatArgs(cfg, paths)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return nil, fmt.Errorf("juicefs stat: %s", lastLine(msg))
		}
		return nil, fmt.Errorf("juicefs stat: %w", err)
	}
	res, perr := parseStatResults(text)
	if perr != nil {
		return nil, fmt.Errorf("juicefs stat: %w", perr)
	}
	return res, nil
}

func (r Runner) EnsureVolume(cfg Config) error {
	if err := r.Status(cfg.MetaURL); err == nil {
		return nil
	}
	return r.Format(cfg)
}

// ConfigArgs builds `juicefs config META --capacity <GiB> --yes`.
// --capacity 的单位是 GiB（实测 `--capacity 4096` 得到 4 TiB）。
func ConfigArgs(cfg Config, gb uint64) []string {
	return []string{"config", cfg.MetaURL, "--capacity", strconv.FormatUint(gb, 10), "--yes"}
}

func (r Runner) Config(cfg Config, gb uint64) error {
	if err := r.cmd(ConfigArgs(cfg, gb)...).Run(); err != nil {
		return fmt.Errorf("juicefs config: %w", err)
	}
	return nil
}
