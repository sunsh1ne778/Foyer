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
