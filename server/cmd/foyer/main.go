package main

import (
	"log"
	"net/http"
	"os"

	"filestore/internal/foyer"
)

func main() {
	cfg := foyer.LoadConfig()
	_ = os.Setenv("MINIO_ROOT_USER", cfg.GatewayRootUser)
	_ = os.Setenv("MINIO_ROOT_PASSWORD", cfg.GatewayRootPass)
	r := foyer.Runner{Bin: cfg.JuiceFSBin}
	if err := r.EnsureVolume(cfg); err != nil {
		log.Fatal(err)
	}
	// 音量配额只是让 df/StatFS 反映真实磁盘；失败只告警，不挡网关。
	foyer.EnsureVolumeCapacity(cfg, r)
	go func() {
		log.Printf("foyer admin on %s", cfg.AdminListen)
		if err := http.ListenAndServe(cfg.AdminListen, foyer.NewHealthMux(cfg)); err != nil {
			log.Fatal(err)
		}
	}()
	log.Printf("foyer gateway %s volume=%s", cfg.GatewayListen, cfg.Volume)
	if err := r.Gateway(cfg); err != nil {
		log.Fatal(err)
	}
}
