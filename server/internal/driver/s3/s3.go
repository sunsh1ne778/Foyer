package s3drv

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"filestore/internal/driver"
)

func init() {
	driver.Register("s3", openKind("s3"))
	driver.Register("minio", openKind("minio"))
}

func openKind(kind string) driver.Factory {
	return func(id string, spec map[string]string) (driver.Driver, error) {
		return Open(kind, id, spec)
	}
}

type drv struct {
	kind   string
	bucket string
	cli    *s3.Client
	pre    *s3.PresignClient
}

func Open(kind, id string, spec map[string]string) (driver.Driver, error) {
	endpoint := spec["endpoint"]
	bucket := spec["bucket"]
	if bucket == "" {
		return nil, fmt.Errorf("%s: bucket required", kind)
	}
	region := spec["region"]
	if region == "" {
		region = "us-east-1"
	}
	pathStyle := spec["path_style"] == "true" || kind == "minio"
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(spec["access_key"], spec["secret_key"], ""),
	}
	cli := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = pathStyle
	})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := cli.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)}); err != nil {
		if spec["auto_create"] == "true" {
			if _, err := cli.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
				return nil, fmt.Errorf("%s: create bucket: %w", kind, err)
			}
		} else {
			return nil, fmt.Errorf("%s: bucket %s not reachable (auto_create!=true): %w", kind, bucket, err)
		}
	}
	return &drv{kind: kind, bucket: bucket, cli: cli, pre: s3.NewPresignClient(cli)}, nil
}

func (d *drv) Kind() string { return d.kind }
func (d *drv) Caps() driver.Caps {
	return driver.Caps{List: true, Mkdir: true, Copy: true, Multipart: true, Presign: true}
}
func (d *drv) Close() error { return nil }
func (d *drv) Health(ctx context.Context) error {
	_, err := d.cli.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(d.bucket)})
	return err
}

func (d *drv) List(ctx context.Context, prefix string, rec driver.ListRec) (driver.ListPage, error) {
	prefix = strings.TrimPrefix(prefix, "/")
	limit := int32(rec.Limit)
	if limit <= 0 {
		limit = 1000
	}
	in := &s3.ListObjectsV2Input{
		Bucket:  aws.String(d.bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: aws.Int32(limit),
	}
	if !rec.Recursive {
		in.Delimiter = aws.String("/")
		if prefix != "" && !strings.HasSuffix(prefix, "/") {
			in.Prefix = aws.String(prefix + "/")
		}
	}
	out, err := d.cli.ListObjectsV2(ctx, in)
	if err != nil {
		return driver.ListPage{}, err
	}
	var entries []driver.Info
	for _, p := range out.CommonPrefixes {
		k := strings.TrimSuffix(aws.ToString(p.Prefix), "/")
		entries = append(entries, driver.Info{Key: k, IsDir: true})
	}
	for _, o := range out.Contents {
		k := aws.ToString(o.Key)
		if strings.HasSuffix(k, "/") {
			continue
		}
		mt := time.Time{}
		if o.LastModified != nil {
			mt = o.LastModified.UTC()
		}
		entries = append(entries, driver.Info{
			Key:     k,
			Size:    aws.ToInt64(o.Size),
			ETag:    strings.Trim(aws.ToString(o.ETag), `"`),
			ModTime: mt,
		})
	}
	return driver.ListPage{Entries: entries, Cursor: aws.ToString(out.NextContinuationToken)}, nil
}

func (d *drv) Stat(ctx context.Context, key string) (driver.Info, error) {
	key = strings.TrimPrefix(key, "/")
	out, err := d.cli.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key)})
	if err != nil {
		return driver.Info{}, driver.ErrNotFound
	}
	mt := time.Time{}
	if out.LastModified != nil {
		mt = out.LastModified.UTC()
	}
	return driver.Info{Key: key, Size: aws.ToInt64(out.ContentLength), ETag: strings.Trim(aws.ToString(out.ETag), `"`), ModTime: mt}, nil
}

func (d *drv) Mkdir(ctx context.Context, key string) error {
	key = strings.TrimPrefix(key, "/")
	if key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	_, err := d.cli.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key), Body: strings.NewReader("")})
	return err
}

func (d *drv) Remove(ctx context.Context, key string) error {
	key = strings.TrimPrefix(key, "/")
	_, err := d.cli.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key)})
	return err
}

func (d *drv) Read(ctx context.Context, key string, rng *driver.Range) (io.ReadCloser, error) {
	key = strings.TrimPrefix(key, "/")
	in := &s3.GetObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key)}
	if rng != nil {
		if rng.End < 0 {
			in.Range = aws.String(fmt.Sprintf("bytes=%d-", rng.Start))
		} else {
			in.Range = aws.String(fmt.Sprintf("bytes=%d-%d", rng.Start, rng.End))
		}
	}
	out, err := d.cli.GetObject(ctx, in)
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

func (d *drv) Write(ctx context.Context, key string, r io.Reader, n int64) error {
	key = strings.TrimPrefix(key, "/")
	in := &s3.PutObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key), Body: r}
	if n > 0 {
		in.ContentLength = aws.Int64(n)
	}
	_, err := d.cli.PutObject(ctx, in)
	return err
}

func (d *drv) Copy(ctx context.Context, src, dst string) error {
	src = strings.TrimPrefix(src, "/")
	dst = strings.TrimPrefix(dst, "/")
	_, err := d.cli.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(d.bucket),
		Key:        aws.String(dst),
		CopySource: aws.String(d.bucket + "/" + src),
	})
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
	out, err := d.cli.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(d.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.UploadId) + "|" + key, nil
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
	_, err = d.cli.UploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(d.bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uid),
		PartNumber: aws.Int32(int32(n)),
		Body:       r,
	})
	return err
}

func (d *drv) Complete(ctx context.Context, uploadID string) error {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return err
	}
	listed, err := d.cli.ListParts(ctx, &s3.ListPartsInput{
		Bucket:   aws.String(d.bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uid),
	})
	if err != nil {
		return err
	}
	completed := types.CompletedMultipartUpload{}
	for _, p := range listed.Parts {
		completed.Parts = append(completed.Parts, types.CompletedPart{ETag: p.ETag, PartNumber: p.PartNumber})
	}
	_, err = d.cli.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(d.bucket),
		Key:             aws.String(key),
		UploadId:        aws.String(uid),
		MultipartUpload: &completed,
	})
	return err
}

func (d *drv) Abort(ctx context.Context, uploadID string) error {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return err
	}
	_, err = d.cli.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(d.bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uid),
	})
	return err
}

func (d *drv) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, map[string]string, error) {
	key = strings.TrimPrefix(key, "/")
	out, err := d.pre.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(d.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", nil, err
	}
	return out.URL, map[string]string{}, nil
}

func (d *drv) PresignPut(ctx context.Context, key string, n int64, ttl time.Duration) (string, map[string]string, error) {
	key = strings.TrimPrefix(key, "/")
	in := &s3.PutObjectInput{Bucket: aws.String(d.bucket), Key: aws.String(key)}
	if n > 0 {
		in.ContentLength = aws.Int64(n)
	}
	out, err := d.pre.PresignPutObject(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", nil, err
	}
	return out.URL, map[string]string{}, nil
}

func (d *drv) PresignPart(ctx context.Context, uploadID string, n int, size int64, ttl time.Duration) (string, map[string]string, error) {
	uid, key, err := splitUpload(uploadID)
	if err != nil {
		return "", nil, err
	}
	in := &s3.UploadPartInput{
		Bucket:     aws.String(d.bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uid),
		PartNumber: aws.Int32(int32(n)),
	}
	if size > 0 {
		in.ContentLength = aws.Int64(size)
	}
	out, err := d.pre.PresignUploadPart(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", nil, err
	}
	return out.URL, map[string]string{}, nil
}

var _ driver.PartPresigner = (*drv)(nil)
