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
