package ossdrv

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"

	"filestore/internal/driver"
)

func init() {
	driver.Register("oss", Open)
}

type drv struct {
	bucket *oss.Bucket
	raw    *oss.Client
	name   string
}

func Open(id string, spec map[string]string) (driver.Driver, error) {
	endpoint := spec["endpoint"]
	bucket := spec["bucket"]
	if endpoint == "" || bucket == "" {
		return nil, fmt.Errorf("oss: endpoint and bucket required")
	}
	cli, err := oss.New(endpoint, spec["access_key"], spec["secret_key"])
	if err != nil {
		return nil, err
	}
	ok, err := cli.IsBucketExist(bucket)
	if err != nil {
		return nil, err
	}
	if !ok {
		if spec["auto_create"] == "true" {
			if err := cli.CreateBucket(bucket); err != nil {
				return nil, err
			}
		} else {
			return nil, fmt.Errorf("oss: bucket %s not found (auto_create!=true)", bucket)
		}
	}
	b, err := cli.Bucket(bucket)
	if err != nil {
		return nil, err
	}
	return &drv{bucket: b, raw: cli, name: bucket}, nil
}

func (d *drv) Kind() string { return "oss" }
func (d *drv) Caps() driver.Caps {
	return driver.Caps{List: true, Mkdir: true, Copy: true, Multipart: true, Presign: true}
}
func (d *drv) Close() error { return nil }
func (d *drv) Health(context.Context) error {
	_, err := d.raw.IsBucketExist(d.name)
	return err
}

func (d *drv) List(ctx context.Context, prefix string, rec driver.ListRec) (driver.ListPage, error) {
	prefix = strings.TrimPrefix(prefix, "/")
	limit := rec.Limit
	if limit <= 0 {
		limit = 1000
	}
	opts := []oss.Option{oss.Prefix(prefix), oss.MaxKeys(limit)}
	if !rec.Recursive {
		opts = append(opts, oss.Delimiter("/"))
		if prefix != "" && !strings.HasSuffix(prefix, "/") {
			opts[0] = oss.Prefix(prefix + "/")
		}
	}
	res, err := d.bucket.ListObjects(opts...)
	if err != nil {
		return driver.ListPage{}, err
	}
	var entries []driver.Info
	for _, p := range res.CommonPrefixes {
		entries = append(entries, driver.Info{Key: strings.TrimSuffix(p, "/"), IsDir: true})
	}
	for _, o := range res.Objects {
		if strings.HasSuffix(o.Key, "/") {
			continue
		}
		entries = append(entries, driver.Info{Key: o.Key, Size: o.Size, ETag: strings.Trim(o.ETag, `"`), ModTime: o.LastModified.UTC()})
	}
	return driver.ListPage{Entries: entries, Cursor: res.NextMarker}, nil
}

func (d *drv) Stat(ctx context.Context, key string) (driver.Info, error) {
	key = strings.TrimPrefix(key, "/")
	h, err := d.bucket.GetObjectMeta(key)
	if err != nil {
		return driver.Info{}, driver.ErrNotFound
	}
	var size int64
	if s := h.Get("Content-Length"); s != "" {
		size, _ = strconv.ParseInt(s, 10, 64)
	}
	mt := time.Time{}
	if lm := h.Get("Last-Modified"); lm != "" {
		mt, _ = time.Parse(time.RFC1123, lm)
	}
	return driver.Info{Key: key, Size: size, ETag: strings.Trim(h.Get("Etag"), `"`), ModTime: mt.UTC()}, nil
}

func (d *drv) Mkdir(ctx context.Context, key string) error {
	key = strings.TrimPrefix(key, "/")
	if key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	return d.bucket.PutObject(key, strings.NewReader(""))
}

func (d *drv) Remove(ctx context.Context, key string) error {
	return d.bucket.DeleteObject(strings.TrimPrefix(key, "/"))
}

func (d *drv) Read(ctx context.Context, key string, rng *driver.Range) (io.ReadCloser, error) {
	key = strings.TrimPrefix(key, "/")
	var opts []oss.Option
	if rng != nil {
		end := rng.End
		if end < 0 {
			opts = append(opts, oss.NormalizedRange(fmt.Sprintf("%d-", rng.Start)))
		} else {
			opts = append(opts, oss.Range(rng.Start, end))
		}
	}
	return d.bucket.GetObject(key, opts...)
}

func (d *drv) Write(ctx context.Context, key string, r io.Reader, n int64) error {
	return d.bucket.PutObject(strings.TrimPrefix(key, "/"), r)
}

func (d *drv) Copy(ctx context.Context, src, dst string) error {
	_, err := d.bucket.CopyObject(strings.TrimPrefix(src, "/"), strings.TrimPrefix(dst, "/"))
	return err
}

func (d *drv) Move(ctx context.Context, src, dst string) error {
	if err := d.Copy(ctx, src, dst); err != nil {
		return err
	}
	return d.Remove(ctx, src)
}

func (d *drv) CreateUpload(ctx context.Context, key string) (string, error) {
	key = strings.TrimPrefix(key, "/")
	imur, err := d.bucket.InitiateMultipartUpload(key)
	if err != nil {
		return "", err
	}
	return imur.UploadID + "|" + key, nil
}

func splitUpload(id string) (string, string, error) {
	uid, key, ok := strings.Cut(id, "|")
	if !ok {
		return "", "", fmt.Errorf("bad upload id")
	}
	return uid, key, nil
}

func (d *drv) PutPart(ctx context.Context, uploadID string, n int, r io.Reader) error {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return err
	}
	imur := oss.InitiateMultipartUploadResult{Bucket: d.name, Key: key, UploadID: uid}
	_, err = d.bucket.UploadPart(imur, r, -1, n)
	return err
}

func (d *drv) Complete(ctx context.Context, uploadID string) error {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return err
	}
	imur := oss.InitiateMultipartUploadResult{Bucket: d.name, Key: key, UploadID: uid}
	ls, err := d.bucket.ListUploadedParts(imur)
	if err != nil {
		return err
	}
	var parts []oss.UploadPart
	for _, p := range ls.UploadedParts {
		parts = append(parts, oss.UploadPart{PartNumber: p.PartNumber, ETag: p.ETag})
	}
	_, err = d.bucket.CompleteMultipartUpload(imur, parts)
	return err
}

func (d *drv) Abort(ctx context.Context, uploadID string) error {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return err
	}
	imur := oss.InitiateMultipartUploadResult{Bucket: d.name, Key: key, UploadID: uid}
	return d.bucket.AbortMultipartUpload(imur)
}

func (d *drv) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, map[string]string, error) {
	url, err := d.bucket.SignURL(strings.TrimPrefix(key, "/"), oss.HTTPGet, int64(ttl.Seconds()))
	return url, map[string]string{}, err
}

func (d *drv) PresignPut(ctx context.Context, key string, n int64, ttl time.Duration) (string, map[string]string, error) {
	url, err := d.bucket.SignURL(strings.TrimPrefix(key, "/"), oss.HTTPPut, int64(ttl.Seconds()))
	return url, map[string]string{}, err
}
