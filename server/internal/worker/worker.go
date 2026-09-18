package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
	"go.uber.org/zap"

	"filestore/internal/vfs"
)

func Handler(fs *vfs.FS, log *zap.Logger) asynq.Handler {
	return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
		var job vfs.Job
		if err := json.Unmarshal(t.Payload(), &job); err != nil {
			return err
		}
		log.Info("job", zap.String("id", job.ID), zap.String("type", job.Type), zap.String("task", t.Type()))
		return fs.RunJob(ctx, job)
	})
}

func Mux(fs *vfs.FS, log *zap.Logger) *asynq.ServeMux {
	mux := asynq.NewServeMux()
	h := Handler(fs, log)
	mux.Handle(vfs.TaskCopy, h)
	mux.Handle(vfs.TaskMove, h)
	mux.Handle(vfs.TaskReconcile, h)
	return mux
}

func RedisOptFromURL(url string) (asynq.RedisConnOpt, error) {
	if url == "" {
		return nil, fmt.Errorf("redis url empty")
	}
	return asynq.ParseRedisURI(url)
}
