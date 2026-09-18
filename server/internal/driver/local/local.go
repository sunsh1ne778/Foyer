package local

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"filestore/internal/driver"
)

func init() {
	driver.Register("local", Open)
}

type drv struct {
	id   string
	root string
}

func Open(id string, spec map[string]string) (driver.Driver, error) {
	root := spec["root"]
	if root == "" {
		return nil, fmt.Errorf("local: root required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &drv{id: id, root: abs}, nil
}

func (d *drv) Kind() string { return "local" }
func (d *drv) Caps() driver.Caps {
	return driver.Caps{List: true, Mkdir: true, Copy: true, Move: true, Multipart: true, Directory: true}
}
func (d *drv) Close() error { return nil }
func (d *drv) Health(context.Context) error {
	fi, err := os.Stat(d.root)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("local: root is not a directory")
	}
	return nil
}

func (d *drv) resolve(key string) (string, error) {
	key = strings.TrimPrefix(filepath.ToSlash(key), "/")
	p := filepath.Join(d.root, filepath.FromSlash(key))
	rel, err := filepath.Rel(d.root, p)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("local: key escapes root")
	}
	return p, nil
}

func (d *drv) List(ctx context.Context, prefix string, rec driver.ListRec) (driver.ListPage, error) {
	prefix = strings.TrimPrefix(prefix, "/")
	base, err := d.resolve(prefix)
	if err != nil {
		return driver.ListPage{}, err
	}
	limit := rec.Limit
	if limit <= 0 {
		limit = 1000
	}
	var entries []driver.Info
	walk := func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == base {
			if info.IsDir() && rec.Recursive {
				return nil
			}
			if path == base && prefix == "" && info.IsDir() {
				return nil
			}
		}
		rel, _ := filepath.Rel(d.root, path)
		key := filepath.ToSlash(rel)
		if key == "." {
			key = ""
		}
		if !rec.Recursive && filepath.Dir(path) != base && path != base {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if path == base && info.IsDir() {
			return nil
		}
		entries = append(entries, fileInfo(key, info))
		if !rec.Recursive && info.IsDir() && path != base {
			return filepath.SkipDir
		}
		if len(entries) >= limit {
			return io.EOF
		}
		return nil
	}
	err = filepath.Walk(base, walk)
	if err == io.EOF {
		err = nil
	}
	if os.IsNotExist(err) {
		return driver.ListPage{}, nil
	}
	return driver.ListPage{Entries: entries}, err
}

func (d *drv) Stat(ctx context.Context, key string) (driver.Info, error) {
	p, err := d.resolve(key)
	if err != nil {
		return driver.Info{}, err
	}
	fi, err := os.Stat(p)
	if os.IsNotExist(err) {
		return driver.Info{}, driver.ErrNotFound
	}
	if err != nil {
		return driver.Info{}, err
	}
	return fileInfo(strings.TrimPrefix(filepath.ToSlash(key), "/"), fi), nil
}

func (d *drv) Mkdir(ctx context.Context, key string) error {
	p, err := d.resolve(key)
	if err != nil {
		return err
	}
	return os.MkdirAll(p, 0o755)
}

func (d *drv) Remove(ctx context.Context, key string) error {
	p, err := d.resolve(key)
	if err != nil {
		return err
	}
	return os.RemoveAll(p)
}

func (d *drv) Read(ctx context.Context, key string, rng *driver.Range) (io.ReadCloser, error) {
	p, err := d.resolve(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, driver.ErrNotFound
		}
		return nil, err
	}
	if rng == nil {
		return f, nil
	}
	end := rng.End
	if end < 0 {
		fi, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, err
		}
		end = fi.Size() - 1
	}
	if _, err := f.Seek(rng.Start, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	return &limited{ReadCloser: f, left: end - rng.Start + 1}, nil
}

func (d *drv) Write(ctx context.Context, key string, r io.Reader, n int64) error {
	p, err := d.resolve(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp-" + uuid.NewString()
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	cerr := f.Close()
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return cerr
	}
	return os.Rename(tmp, p)
}

func (d *drv) Copy(ctx context.Context, src, dst string) error {
	in, err := d.Read(ctx, src, nil)
	if err != nil {
		return err
	}
	defer in.Close()
	return d.Write(ctx, dst, in, -1)
}

func (d *drv) Move(ctx context.Context, src, dst string) error {
	sp, err := d.resolve(src)
	if err != nil {
		return err
	}
	dp, err := d.resolve(dst)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dp), 0o755); err != nil {
		return err
	}
	return os.Rename(sp, dp)
}

func (d *drv) uploadsDir() string {
	return filepath.Join(d.root, ".filestore-uploads")
}

func (d *drv) CreateUpload(ctx context.Context, key string) (string, error) {
	id := uuid.NewString()
	dir := filepath.Join(d.uploadsDir(), id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "key"), []byte(key), 0o644); err != nil {
		return "", err
	}
	return id, nil
}

func (d *drv) PutPart(ctx context.Context, uploadID string, n int, r io.Reader) error {
	dir := filepath.Join(d.uploadsDir(), uploadID)
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(dir, fmt.Sprintf("%d", n)))
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, r)
	cerr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	return cerr
}

func (d *drv) Complete(ctx context.Context, uploadID string) error {
	dir := filepath.Join(d.uploadsDir(), uploadID)
	keyb, err := os.ReadFile(filepath.Join(dir, "key"))
	if err != nil {
		return err
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	max := 0
	for _, e := range ents {
		var n int
		if _, err := fmt.Sscanf(e.Name(), "%d", &n); err == nil && n > max {
			max = n
		}
	}
	var readers []io.Reader
	var files []*os.File
	for i := 1; i <= max; i++ {
		f, err := os.Open(filepath.Join(dir, fmt.Sprintf("%d", i)))
		if err != nil {
			for _, x := range files {
				x.Close()
			}
			return err
		}
		files = append(files, f)
		readers = append(readers, f)
	}
	err = d.Write(ctx, string(keyb), io.MultiReader(readers...), -1)
	for _, f := range files {
		_ = f.Close()
	}
	_ = os.RemoveAll(dir)
	return err
}

func (d *drv) Abort(ctx context.Context, uploadID string) error {
	return os.RemoveAll(filepath.Join(d.uploadsDir(), uploadID))
}

func (d *drv) PresignGet(context.Context, string, time.Duration) (string, map[string]string, error) {
	return "", nil, driver.ErrUnsupported
}
func (d *drv) PresignPut(context.Context, string, int64, time.Duration) (string, map[string]string, error) {
	return "", nil, driver.ErrUnsupported
}

func fileInfo(key string, fi os.FileInfo) driver.Info {
	etag := ""
	if !fi.IsDir() {
		h := sha1.Sum([]byte(fmt.Sprintf("%d:%d", fi.Size(), fi.ModTime().UnixNano())))
		etag = hex.EncodeToString(h[:8])
	}
	return driver.Info{Key: key, IsDir: fi.IsDir(), Size: fi.Size(), ETag: etag, ModTime: fi.ModTime().UTC()}
}

type limited struct {
	io.ReadCloser
	left int64
}

func (l *limited) Read(p []byte) (int, error) {
	if l.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > l.left {
		p = p[:l.left]
	}
	n, err := l.ReadCloser.Read(p)
	l.left -= int64(n)
	return n, err
}
