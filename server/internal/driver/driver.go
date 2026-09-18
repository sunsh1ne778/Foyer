package driver

import (
	"context"
	"errors"
	"io"
	"time"
)

var ErrUnsupported = errors.New("unsupported")
var ErrNotFound = errors.New("not found")

type Caps struct {
	List, Mkdir, Copy, Move bool
	Multipart, Presign      bool
	Directory               bool
}

type Range struct {
	Start int64
	End   int64 // inclusive; -1 = until EOF
}

type Info struct {
	Key     string
	IsDir   bool
	Size    int64
	ETag    string
	ModTime time.Time
}

type ListRec struct {
	Recursive bool
	Limit     int
	Cursor    string
}

type ListPage struct {
	Entries []Info
	Cursor  string
}

type Driver interface {
	Kind() string
	Caps() Caps
	Close() error
	Health(ctx context.Context) error

	List(ctx context.Context, prefix string, rec ListRec) (ListPage, error)
	Stat(ctx context.Context, key string) (Info, error)
	Mkdir(ctx context.Context, key string) error
	Remove(ctx context.Context, key string) error

	Read(ctx context.Context, key string, rng *Range) (io.ReadCloser, error)
	Write(ctx context.Context, key string, r io.Reader, n int64) error

	Copy(ctx context.Context, src, dst string) error
	Move(ctx context.Context, src, dst string) error

	CreateUpload(ctx context.Context, key string) (uploadID string, err error)
	PutPart(ctx context.Context, uploadID string, n int, r io.Reader) error
	Complete(ctx context.Context, uploadID string) error
	Abort(ctx context.Context, uploadID string) error

	PresignGet(ctx context.Context, key string, ttl time.Duration) (url string, headers map[string]string, err error)
	PresignPut(ctx context.Context, key string, n int64, ttl time.Duration) (url string, headers map[string]string, err error)
}

type PartPresigner interface {
	PresignPart(ctx context.Context, uploadID string, n int, size int64, ttl time.Duration) (url string, headers map[string]string, err error)
}

type Factory func(id string, spec map[string]string) (Driver, error)
