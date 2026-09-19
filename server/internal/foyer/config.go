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
	HostData        string
	HostMount       string
	MountsFile      string
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
		HostData:        envOr("FOYER_HOST_DATA", ""),
		HostMount:       envOr("FOYER_HOST_MOUNT", "/host"),
		MountsFile:      envOr("FOYER_MOUNTS_FILE", "/var/lib/foyer/mounts.json"),
	}
}
