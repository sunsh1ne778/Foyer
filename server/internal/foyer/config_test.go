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
