package fastdfs

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"filestore/internal/driver"
)

func init() {
	driver.Register("fastdfs", Open)
}

const (
	headerSize    = 10
	groupNameSize = 16
	ipAddrSize    = 16
	fileExtSize   = 6
	cmdQueryStore = 101
	cmdQueryFetch = 102
	cmdQueryUpdate = 103
	cmdUpload     = 11
	cmdDelete     = 12
	cmdDownload   = 14
)

type drv struct {
	tracker string
	group   string
}

func Open(id string, spec map[string]string) (driver.Driver, error) {
	tracker := spec["tracker"]
	if tracker == "" {
		return nil, fmt.Errorf("fastdfs: tracker required")
	}
	d := &drv{tracker: tracker, group: spec["group"]}
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.Dial("tcp", tracker)
	if err != nil {
		return nil, fmt.Errorf("fastdfs tracker %s: %w", tracker, err)
	}
	_ = conn.Close()
	return d, nil
}

func (d *drv) Kind() string { return "fastdfs" }
func (d *drv) Caps() driver.Caps {
	return driver.Caps{Multipart: true}
}
func (d *drv) Close() error { return nil }
func (d *drv) Health(ctx context.Context) error {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", d.tracker)
	if err != nil {
		return err
	}
	return conn.Close()
}

func (d *drv) List(context.Context, string, driver.ListRec) (driver.ListPage, error) {
	return driver.ListPage{}, driver.ErrUnsupported
}
func (d *drv) Mkdir(context.Context, string) error { return driver.ErrUnsupported }
func (d *drv) Copy(context.Context, string, string) error {
	return driver.ErrUnsupported
}
func (d *drv) Move(context.Context, string, string) error {
	return driver.ErrUnsupported
}
func (d *drv) PresignGet(context.Context, string, time.Duration) (string, map[string]string, error) {
	return "", nil, driver.ErrUnsupported
}
func (d *drv) PresignPut(context.Context, string, int64, time.Duration) (string, map[string]string, error) {
	return "", nil, driver.ErrUnsupported
}

func mapKey(logical string) string {
	sum := sha1.Sum([]byte(strings.TrimPrefix(logical, "/")))
	return ".vfsmap/" + hex.EncodeToString(sum[:])
}

func (d *drv) Stat(ctx context.Context, key string) (driver.Info, error) {
	blob, err := d.lookup(ctx, key)
	if err != nil {
		return driver.Info{}, err
	}
	r, err := d.getBlob(ctx, blob)
	if err != nil {
		return driver.Info{}, err
	}
	defer r.Close()
	n, _ := io.Copy(io.Discard, r)
	return driver.Info{Key: strings.TrimPrefix(key, "/"), Size: n, ModTime: time.Now().UTC()}, nil
}

func (d *drv) Remove(ctx context.Context, key string) error {
	blob, err := d.lookup(ctx, key)
	if err != nil {
		return err
	}
	_ = d.deleteBlob(ctx, blob)
	return d.deleteBlob(ctx, mapKey(key))
}

func (d *drv) Read(ctx context.Context, key string, rng *driver.Range) (io.ReadCloser, error) {
	blob, err := d.lookup(ctx, key)
	if err != nil {
		return nil, err
	}
	body, err := d.getBlob(ctx, blob)
	if err != nil {
		return nil, err
	}
	if rng == nil {
		return body, nil
	}
	data, err := io.ReadAll(body)
	body.Close()
	if err != nil {
		return nil, err
	}
	end := rng.End
	if end < 0 || end >= int64(len(data)) {
		end = int64(len(data)) - 1
	}
	if rng.Start >= int64(len(data)) {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	return io.NopCloser(bytes.NewReader(data[rng.Start : end+1])), nil
}

func (d *drv) Write(ctx context.Context, key string, r io.Reader, n int64) error {
	blob, err := d.putBlob(ctx, key, r, n)
	if err != nil {
		return err
	}
	_, err = d.putBlob(ctx, mapKey(key), strings.NewReader(blob), int64(len(blob)))
	return err
}

func (d *drv) CreateUpload(ctx context.Context, key string) (string, error) {
	id := uuid.NewString()
	dir := filepath.Join(os.TempDir(), "filestore-fdfs", id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "key"), []byte(key), 0o644); err != nil {
		return "", err
	}
	return id, nil
}

func (d *drv) PutPart(ctx context.Context, uploadID string, n int, r io.Reader) error {
	dir := filepath.Join(os.TempDir(), "filestore-fdfs", uploadID)
	f, err := os.Create(filepath.Join(dir, strconv.Itoa(n)))
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	cerr := f.Close()
	if err != nil {
		return err
	}
	return cerr
}

func (d *drv) Complete(ctx context.Context, uploadID string) error {
	dir := filepath.Join(os.TempDir(), "filestore-fdfs", uploadID)
	keyb, err := os.ReadFile(filepath.Join(dir, "key"))
	if err != nil {
		return err
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var nums []int
	for _, e := range ents {
		if n, err := strconv.Atoi(e.Name()); err == nil {
			nums = append(nums, n)
		}
	}
	sort.Ints(nums)
	var readers []io.Reader
	var files []*os.File
	for _, n := range nums {
		f, err := os.Open(filepath.Join(dir, strconv.Itoa(n)))
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
	return os.RemoveAll(filepath.Join(os.TempDir(), "filestore-fdfs", uploadID))
}

func (d *drv) lookup(ctx context.Context, key string) (string, error) {
	if strings.Contains(key, "M00/") || strings.Count(key, "/") >= 1 && strings.HasPrefix(key, d.group) {
		return strings.TrimPrefix(key, "/"), nil
	}
	r, err := d.getBlob(ctx, mapKey(key))
	if err != nil {
		return "", driver.ErrNotFound
	}
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	return string(bytes.TrimSpace(b)), nil
}

func (d *drv) putBlob(ctx context.Context, key string, r io.Reader, size int64) (string, error) {
	store, pathIndex, err := d.queryStore(ctx)
	if err != nil {
		return "", err
	}
	body, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	if size <= 0 {
		size = int64(len(body))
	}
	ext := strings.TrimPrefix(path.Ext(key), ".")
	if len(ext) > fileExtSize {
		ext = ext[:fileExtSize]
	}
	payload := make([]byte, 1+8+fileExtSize+len(body))
	payload[0] = byte(pathIndex)
	binary.BigEndian.PutUint64(payload[1:9], uint64(size))
	copy(payload[9:9+fileExtSize], ext)
	copy(payload[9+fileExtSize:], body)
	resp, err := d.rpc(ctx, store, cmdUpload, payload)
	if err != nil {
		return "", err
	}
	if len(resp) < groupNameSize {
		return "", fmt.Errorf("fastdfs upload: short response")
	}
	group := cString(resp[:groupNameSize])
	filename := string(bytes.TrimRight(resp[groupNameSize:], "\x00"))
	return group + "/" + filename, nil
}

func (d *drv) getBlob(ctx context.Context, blobKey string) (io.ReadCloser, error) {
	group, filename, err := splitBlob(blobKey)
	if err != nil {
		return nil, err
	}
	store, err := d.queryByGroup(ctx, cmdQueryFetch, group, filename)
	if err != nil {
		return nil, err
	}
	body := make([]byte, 16+groupNameSize+len(filename))
	copy(body[16:16+groupNameSize], groupPad(group))
	copy(body[16+groupNameSize:], filename)
	data, err := d.rpc(ctx, store, cmdDownload, body)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (d *drv) deleteBlob(ctx context.Context, blobKey string) error {
	group, filename, err := splitBlob(blobKey)
	if err != nil {
		return err
	}
	store, err := d.queryByGroup(ctx, cmdQueryUpdate, group, filename)
	if err != nil {
		return err
	}
	body := append(groupPad(group), []byte(filename)...)
	_, err = d.rpc(ctx, store, cmdDelete, body)
	return err
}

type storeAddr struct {
	host string
	port int
}

func (d *drv) queryStore(ctx context.Context) (storeAddr, int, error) {
	cmd := byte(cmdQueryStore)
	var body []byte
	if d.group != "" {
		cmd = 104
		body = groupPad(d.group)
	}
	resp, err := d.rpc(ctx, storeAddr{host: trackerHost(d.tracker), port: trackerPort(d.tracker)}, cmd, body)
	if err != nil {
		return storeAddr{}, 0, err
	}
	if len(resp) < groupNameSize+ipAddrSize+8+1 {
		return storeAddr{}, 0, fmt.Errorf("fastdfs tracker: short store query")
	}
	ip := cString(resp[groupNameSize : groupNameSize+ipAddrSize])
	port := int(binary.BigEndian.Uint64(resp[groupNameSize+ipAddrSize : groupNameSize+ipAddrSize+8]))
	idx := int(resp[groupNameSize+ipAddrSize+8])
	return storeAddr{host: ip, port: port}, idx, nil
}

func (d *drv) queryByGroup(ctx context.Context, cmd byte, group, filename string) (storeAddr, error) {
	body := append(groupPad(group), []byte(filename)...)
	resp, err := d.rpc(ctx, storeAddr{host: trackerHost(d.tracker), port: trackerPort(d.tracker)}, cmd, body)
	if err != nil {
		return storeAddr{}, err
	}
	if len(resp) < groupNameSize+ipAddrSize+8 {
		return storeAddr{}, fmt.Errorf("fastdfs tracker: short fetch query")
	}
	ip := cString(resp[groupNameSize : groupNameSize+ipAddrSize])
	port := int(binary.BigEndian.Uint64(resp[groupNameSize+ipAddrSize : groupNameSize+ipAddrSize+8]))
	return storeAddr{host: ip, port: port}, nil
}

func (d *drv) rpc(ctx context.Context, addr storeAddr, cmd byte, body []byte) ([]byte, error) {
	dialer := net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", addr.host, addr.port))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	hdr := make([]byte, headerSize)
	binary.BigEndian.PutUint64(hdr[0:8], uint64(len(body)))
	hdr[8] = cmd
	if _, err := conn.Write(hdr); err != nil {
		return nil, err
	}
	if len(body) > 0 {
		if _, err := conn.Write(body); err != nil {
			return nil, err
		}
	}
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint64(hdr[0:8])
	status := hdr[9]
	resp := make([]byte, n)
	if n > 0 {
		if _, err := io.ReadFull(conn, resp); err != nil {
			return nil, err
		}
	}
	if status != 0 {
		return nil, fmt.Errorf("fastdfs cmd %d status %d", cmd, status)
	}
	return resp, nil
}

func splitBlob(blobKey string) (string, string, error) {
	i := strings.IndexByte(blobKey, '/')
	if i <= 0 || i == len(blobKey)-1 {
		return "", "", fmt.Errorf("invalid fastdfs blob_key")
	}
	return blobKey[:i], blobKey[i+1:], nil
}

func groupPad(group string) []byte {
	b := make([]byte, groupNameSize)
	copy(b, group)
	return b
}

func cString(b []byte) string {
	n := bytes.IndexByte(b, 0)
	if n < 0 {
		return string(b)
	}
	return string(b[:n])
}

func trackerHost(addr string) string {
	h, _, ok := strings.Cut(addr, ":")
	if !ok {
		return addr
	}
	return h
}

func trackerPort(addr string) int {
	_, p, ok := strings.Cut(addr, ":")
	if !ok {
		return 22122
	}
	n, _ := strconv.Atoi(p)
	if n == 0 {
		return 22122
	}
	return n
}
