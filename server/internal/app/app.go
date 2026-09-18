package app

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"filestore/internal/auth"
	"filestore/internal/config"
	s3gw "filestore/internal/gateway/s3"
	"filestore/internal/httpapi"
	"filestore/internal/index"
	"filestore/internal/mount"
	"filestore/internal/obs"
	"filestore/internal/overlay"
	"filestore/internal/vfs"

	_ "filestore/internal/driver/fastdfs"
	_ "filestore/internal/driver/local"
	_ "filestore/internal/driver/oss"
	_ "filestore/internal/driver/s3"
)

type Runtime struct {
	Cfg    *config.Config
	Log    *zap.Logger
	Pool   *pgxpool.Pool
	RDB    *redis.Client
	Asynq  *asynq.Client
	Mounts *mount.Table
	FS     *vfs.FS
	HTTP   *httpapi.Server
	cancel context.CancelFunc
}

func Build() (*Runtime, func(), error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	log, err := obs.NewLogger()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, otelStop, err := obs.NewTracer(ctx, cfg)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	pool, err := pgxpool.New(ctx, cfg.PostgresDSN)
	if err != nil {
		cancel()
		otelStop()
		return nil, nil, fmt.Errorf("postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		cancel()
		otelStop()
		return nil, nil, fmt.Errorf("postgres ping: %w", err)
	}
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		pool.Close()
		cancel()
		otelStop()
		return nil, nil, fmt.Errorf("redis url: %w", err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		pool.Close()
		cancel()
		otelStop()
		return nil, nil, fmt.Errorf("redis ping: %w", err)
	}
	ac := asynq.NewClient(asynq.RedisClientOpt{Addr: opt.Addr, Password: opt.Password, DB: opt.DB, Username: opt.Username})
	mounts := mount.NewTable(pool, log)
	if err := mounts.Start(ctx); err != nil {
		_ = ac.Close()
		_ = rdb.Close()
		pool.Close()
		cancel()
		otelStop()
		return nil, nil, err
	}
	idx := index.New(pool)
	ov := overlay.New(pool)
	fs := vfs.New(mounts, idx, ov, rdb, ac, log)
	httpSrv := httpapi.New(fs, mounts, auth.New(cfg), pool, rdb, log)
	rt := &Runtime{Cfg: cfg, Log: log, Pool: pool, RDB: rdb, Asynq: ac, Mounts: mounts, FS: fs, HTTP: httpSrv, cancel: cancel}
	cleanup := func() {
		cancel()
		mounts.Close()
		_ = ac.Close()
		_ = rdb.Close()
		pool.Close()
		otelStop()
		_ = log.Sync()
	}
	return rt, cleanup, nil
}

func (rt *Runtime) Serve() error {
	srv := &http.Server{Addr: rt.Cfg.Listen, Handler: rt.HTTP.Handler()}
	s3srv := &http.Server{Addr: rt.Cfg.S3Listen, Handler: s3gw.New(rt.FS, rt.Log)}
	errCh := make(chan error, 2)
	go func() {
		rt.Log.Info("listen", zap.String("addr", rt.Cfg.Listen), zap.String("node", obs.NodeID()))
		errCh <- srv.ListenAndServe()
	}()
	go func() {
		rt.Log.Info("s3-listen", zap.String("addr", rt.Cfg.S3Listen), zap.String("node", obs.NodeID()))
		errCh <- s3srv.ListenAndServe()
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		return err
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = s3srv.Shutdown(ctx)
		return nil
	}
}
