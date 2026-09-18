package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

type AuthConfig struct {
	Username string `mapstructure:"username"`
	Password string `mapstructure:"password"`
	Secret   string `mapstructure:"secret"`
}

type OTelConfig struct {
	Endpoint string `mapstructure:"endpoint"`
}

type Config struct {
	Listen      string     `mapstructure:"listen"`
	S3Listen    string     `mapstructure:"s3_listen"`
	PostgresDSN string     `mapstructure:"postgres_dsn"`
	RedisURL    string     `mapstructure:"redis_url"`
	Node        string     `mapstructure:"node"`
	Auth        AuthConfig `mapstructure:"auth"`
	OTel        OTelConfig `mapstructure:"otel"`
}

func Load() (*Config, error) {
	path, err := resolveConfigPath()
	if err != nil {
		return nil, err
	}
	loadDotEnv(filepath.Join(filepath.Dir(path), ".env"))

	v := viper.New()
	v.SetConfigType("yaml")
	v.SetDefault("listen", ":8090")
	v.SetDefault("s3_listen", ":8091")
	v.SetDefault("auth.username", "admin")

	v.SetConfigFile(path)
	if err := v.ReadInConfig(); err != nil && !os.IsNotExist(err) {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("read config: %w", err)
		}
	}

	cfg := &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}
	expand(cfg)
	if cfg.PostgresDSN == "" {
		return nil, fmt.Errorf("postgres_dsn is empty: copy configs/env.example to configs/.env (or set FILESTORE_PG_DSN)")
	}
	if cfg.RedisURL == "" {
		return nil, fmt.Errorf("redis_url is empty: set FILESTORE_REDIS_URL in configs/.env")
	}
	if cfg.Auth.Password == "" {
		cfg.Auth.Password = os.Getenv("FILESTORE_ADMIN_PASSWORD")
	}
	if cfg.Auth.Secret == "" {
		cfg.Auth.Secret = os.Getenv("FILESTORE_SESSION_SECRET")
	}
	if cfg.Node == "" {
		cfg.Node = os.Getenv("FILESTORE_NODE")
	}
	if cfg.Node == "" {
		h, _ := os.Hostname()
		cfg.Node = h
	}
	if listen := os.Getenv("FILESTORE_LISTEN"); listen != "" {
		cfg.Listen = listen
	}
	if s3 := os.Getenv("FILESTORE_S3_LISTEN"); s3 != "" {
		cfg.S3Listen = s3
	}
	return cfg, nil
}

func resolveConfigPath() (string, error) {
	if path := strings.TrimSpace(os.Getenv("FILESTORE_CONFIG")); path != "" {
		return path, nil
	}
	for _, c := range []string{"configs/server.yml", "../configs/server.yml"} {
		if _, err := os.Stat(c); err == nil {
			abs, err := filepath.Abs(c)
			if err != nil {
				return c, nil
			}
			return abs, nil
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("locate config: %w", err)
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "configs", "server.yml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	return "", fmt.Errorf("configs/server.yml not found (run from repo root or server/, or set FILESTORE_CONFIG)")
}

// loadDotEnv sets variables from a .env file only when not already in the environment.
func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if key == "" {
			continue
		}
		if existing, exists := os.LookupEnv(key); exists && strings.TrimSpace(existing) != "" {
			continue
		}
		_ = os.Setenv(key, val)
	}
}

func expand(cfg *Config) {
	cfg.Listen = os.ExpandEnv(cfg.Listen)
	cfg.S3Listen = os.ExpandEnv(cfg.S3Listen)
	cfg.PostgresDSN = os.ExpandEnv(strings.TrimSpace(cfg.PostgresDSN))
	cfg.RedisURL = os.ExpandEnv(strings.TrimSpace(cfg.RedisURL))
	cfg.OTel.Endpoint = os.ExpandEnv(strings.TrimSpace(cfg.OTel.Endpoint))
	cfg.Auth.Username = os.ExpandEnv(cfg.Auth.Username)
}
