package foyer

import (
	"os"
	"strconv"
	"strings"
)

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
	HostMountBase   string
	MountsFile      string
	// DataDisk 是物理数据盘的挂载路径，用于读真实容量（容器里通常是 "/"）。
	DataDisk string
	// VolumeCapacityGB 非 0 时覆盖自动推导的容量配额（GiB）。
	VolumeCapacityGB uint64
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envUint64 解析非负整型环境变量；非法或负数一律回退默认值，不让配置错误
// 变成启动期 panic。
func envUint64(key string, def uint64) uint64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
	if err != nil {
		return def
	}
	return n
}

func LoadConfig() Config {
	return Config{
		MetaURL:          envOr("FOYER_META_URL", "redis://127.0.0.1:6379/1"),
		Storage:          envOr("FOYER_STORAGE", "minio"),
		Bucket:           envOr("FOYER_BUCKET", "http://127.0.0.1:9000/jfs"),
		AccessKey:        envOr("FOYER_ACCESS_KEY", "rustfsadmin"),
		SecretKey:        envOr("FOYER_SECRET_KEY", "rustfsadmin"),
		GatewayListen:    envOr("FOYER_GATEWAY_LISTEN", ":9002"),
		AdminListen:      envOr("FOYER_ADMIN_LISTEN", ":8092"),
		Volume:           envOr("FOYER_VOLUME", "foyer"),
		JuiceFSBin:       envOr("FOYER_JUICEFS_BIN", "juicefs"),
		GatewayRootUser:  envOr("MINIO_ROOT_USER", "foyerak"),
		GatewayRootPass:  envOr("MINIO_ROOT_PASSWORD", "foyersecret"),
		HostData:         envOr("FOYER_HOST_DATA", ""),
		HostMount:        envOr("FOYER_HOST_MOUNT", "/host"),
		HostMountBase:    envOr("FOYER_HOST_MOUNT_BASE", "/mnt"),
		MountsFile:       envOr("FOYER_MOUNTS_FILE", "/var/lib/foyer/mounts.json"),
		DataDisk:         envOr("FOYER_DATA_DISK_PATH", "/"),
		VolumeCapacityGB: envUint64("FOYER_VOLUME_CAPACITY_GB", 0),
	}
}
