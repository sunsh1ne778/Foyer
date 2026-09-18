package obs

import (
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func NewLogger() (*zap.Logger, error) {
	cfg := zap.NewProductionConfig()
	cfg.EncoderConfig.TimeKey = "ts"
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	if os.Getenv("FILESTORE_LOG_DEV") == "1" {
		cfg = zap.NewDevelopmentConfig()
	}
	return cfg.Build()
}
