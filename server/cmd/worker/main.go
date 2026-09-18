package main

import (
	"log"

	"github.com/hibiken/asynq"
	"go.uber.org/zap"

	"filestore/internal/app"
	"filestore/internal/worker"
)

func main() {
	rt, cleanup, err := app.Build()
	if err != nil {
		log.Fatal(err)
	}
	defer cleanup()
	opt, err := worker.RedisOptFromURL(rt.Cfg.RedisURL)
	if err != nil {
		log.Fatal(err)
	}
	srv := asynq.NewServer(opt, asynq.Config{
		Concurrency: 8,
		Queues:      map[string]int{"copy": 6, "reconcile": 2, "default": 1},
	})
	rt.Log.Info("worker listen", zap.String("redis", rt.Cfg.RedisURL))
	if err := srv.Run(worker.Mux(rt.FS, rt.Log)); err != nil {
		log.Fatal(err)
	}
}
