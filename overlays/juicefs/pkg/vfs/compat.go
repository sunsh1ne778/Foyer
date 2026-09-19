/*
 * Foyer overlay: community-edition compatible-format (EE-style import).
 * File content is an object-store name, not a chunk list.
 */

package vfs

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/object"
)

const (
	ObjectXattr = "jfs.object"
	BlobXattr   = "jfs.blob"
)

// BlobSpec reopens the source store on read (volume bucket or external URI).
type BlobSpec struct {
	URI       string `json:"u,omitempty"`
	Name      string `json:"n,omitempty"`
	Endpoint  string `json:"e,omitempty"`
	AccessKey string `json:"a,omitempty"`
	SecretKey string `json:"s,omitempty"`
	Token     string `json:"t,omitempty"`
	Prefix    string `json:"p,omitempty"`
}

func (s BlobSpec) cacheKey() string {
	if s.URI != "" {
		return "uri:" + s.URI
	}
	return s.Name + "\x00" + s.Endpoint + "\x00" + s.AccessKey + "\x00" + s.Token + "\x00" + s.Prefix
}

var (
	blobMu    sync.Mutex
	blobCache = map[string]object.ObjectStorage{}
)

func OpenBlob(spec BlobSpec) (object.ObjectStorage, error) {
	k := spec.cacheKey()
	blobMu.Lock()
	defer blobMu.Unlock()
	if b, ok := blobCache[k]; ok {
		return b, nil
	}
	var b object.ObjectStorage
	var err error
	if spec.URI != "" {
		b, err = OpenStorageURI(spec.URI)
	} else {
		b, err = object.CreateStorage(strings.ToLower(spec.Name), spec.Endpoint, spec.AccessKey, spec.SecretKey, spec.Token)
		if err == nil && spec.Prefix != "" {
			b = object.WithPrefix(b, spec.Prefix)
		}
	}
	if err != nil {
		return nil, err
	}
	blobCache[k] = b
	return b, nil
}

func OpenStorageURI(uri string) (object.ObjectStorage, error) {
	if !strings.Contains(uri, "://") {
		abs, err := filepath.Abs(uri)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(abs, "/") {
			abs = "/" + strings.ReplaceAll(abs, "\\", "/")
		}
		if strings.HasSuffix(uri, "/") && !strings.HasSuffix(abs, "/") {
			abs += "/"
		}
		uri = "file://" + abs
	}
	u, err := url.Parse(uri)
	if err != nil {
		return nil, err
	}
	var accessKey, secretKey string
	if u.User != nil {
		accessKey = u.User.Username()
		secretKey, _ = u.User.Password()
	}
	name := strings.ToLower(u.Scheme)
	var endpoint string
	switch name {
	case "file":
		endpoint = u.Path
		if runtime.GOOS == "windows" && strings.HasPrefix(endpoint, "/") && len(endpoint) > 2 && endpoint[2] == ':' {
			endpoint = endpoint[1:]
		}
		if endpoint != "" && !strings.HasSuffix(endpoint, "/") {
			endpoint += "/"
		}
	case "webdav", "webdavs":
		scheme := "http"
		if name == "webdavs" || u.Scheme == "https" {
			scheme = "https"
		}
		name = "webdav"
		endpoint = scheme + "://" + u.Host + u.Path
	default:
		endpoint = u.Host + u.Path
		if name == "minio" || name == "s3" {
			endpoint = "http://" + u.Host + u.Path
		}
	}
	store, err := object.CreateStorage(name, endpoint, accessKey, secretKey, "")
	if err != nil {
		return nil, fmt.Errorf("create %s %s: %w", name, endpoint, err)
	}
	switch name {
	case "file":
	case "minio":
		if strings.Count(u.Path, "/") > 1 {
			store = object.WithPrefix(store, strings.SplitN(u.Path[1:], "/", 2)[1])
		}
	default:
		if name != "webdav" && len(u.Path) > 1 {
			store = object.WithPrefix(store, u.Path[1:])
		}
	}
	return store, nil
}

// isInternalKey 判断对象键是否属于卷自身的前缀或 chunks 目录。
// 与 SkipInternalKey 的区别：这里不因为键以 "/" 结尾（目录）而返回 true。
func isInternalKey(key, volume string) bool {
	if volume != "" && (key == volume || strings.HasPrefix(key, volume+"/")) {
		return true
	}
	return strings.HasPrefix(key, "chunks/")
}

func SkipInternalKey(key, volume string) bool {
	if key == "" || strings.HasSuffix(key, "/") {
		return true
	}
	return isInternalKey(key, volume)
}

// SkipInternalDirKey 是给目录用的版本：目录键天然以 "/" 结尾（源根为 ""），
// 不能套用 SkipInternalKey 的"尾斜杠即内部键"规则。传入的 key 应已去掉尾斜杠。
func SkipInternalDirKey(key, volume string) bool {
	return isInternalKey(key, volume)
}

func JoinImportPath(dest, key string) string {
	dest = strings.TrimSuffix(dest, "/")
	if dest == "" {
		dest = "/"
	}
	key = strings.TrimPrefix(key, "/")
	if dest == "/" {
		return "/" + key
	}
	return dest + "/" + key
}

func tryOpenCompat(m meta.Meta, inode Ino, length uint64) FileReader {
	if m == nil {
		return nil
	}
	var obj []byte
	if st := m.GetXattr(meta.Background(), inode, ObjectXattr, &obj); st != 0 || len(obj) == 0 {
		return nil
	}
	var raw []byte
	if st := m.GetXattr(meta.Background(), inode, BlobXattr, &raw); st != 0 || len(raw) == 0 {
		logger.Warnf("inode %d has %s but missing %s", inode, ObjectXattr, BlobXattr)
		return nil
	}
	var spec BlobSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		logger.Warnf("inode %d invalid %s: %s", inode, BlobXattr, err)
		return nil
	}
	blob, err := OpenBlob(spec)
	if err != nil {
		logger.Warnf("inode %d open blob: %s", inode, err)
		return nil
	}
	return &objectFileReader{key: string(obj), blob: blob, length: length}
}

type objectFileReader struct {
	key    string
	blob   object.ObjectStorage
	length uint64
}

func (f *objectFileReader) GetLength() uint64 { return f.length }

func (f *objectFileReader) Close(ctx meta.Context) {}

func (f *objectFileReader) Read(ctx meta.Context, off uint64, buf []byte) (int, syscall.Errno) {
	if off >= f.length || len(buf) == 0 {
		return 0, 0
	}
	n := uint64(len(buf))
	if off+n > f.length {
		n = f.length - off
		buf = buf[:n]
	}
	rc, err := f.blob.Get(f.key, int64(off), int64(len(buf)))
	if err != nil {
		logger.Warnf("compat get %s off=%d: %s", f.key, off, err)
		return 0, syscall.EIO
	}
	defer rc.Close()
	got, err := io.ReadFull(rc, buf)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return got, 0
	}
	if err != nil {
		logger.Warnf("compat read %s: %s", f.key, err)
		return got, syscall.EIO
	}
	return got, 0
}
