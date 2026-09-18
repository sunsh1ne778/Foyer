package obs

import (
	"context"
	"net/http"
	"os"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
	"go.uber.org/zap"

	"filestore/internal/config"
)

func NewTracer(ctx context.Context, cfg *config.Config) (trace.TracerProvider, func(), error) {
	if cfg.OTel.Endpoint == "" {
		tp := noop.NewTracerProvider()
		otel.SetTracerProvider(tp)
		return tp, func() {}, nil
	}
	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(cfg.OTel.Endpoint))
	if err != nil {
		return nil, nil, err
	}
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName("filestore"),
		semconv.ServiceInstanceID(cfg.Node),
	))
	if err != nil {
		return nil, nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return tp, func() { _ = tp.Shutdown(context.Background()) }, nil
}

func Tracer() trace.Tracer {
	return otel.Tracer("filestore")
}

var (
	OpTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "filestore_vfs_ops_total",
		Help: "VFS operations",
	}, []string{"op", "mode", "node"})
)

func init() {
	prometheus.MustRegister(OpTotal)
}

func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

func NodeID() string {
	n := os.Getenv("FILESTORE_NODE")
	if n != "" {
		return n
	}
	h, _ := os.Hostname()
	return h
}

func LogOp(log *zap.Logger, op, mount, key, mode string) {
	log.Info("vfs",
		zap.String("op", op),
		zap.String("mount", mount),
		zap.String("key", key),
		zap.String("mode", mode),
		zap.String("node", NodeID()),
	)
	OpTotal.WithLabelValues(op, mode, NodeID()).Inc()
}
