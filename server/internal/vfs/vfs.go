package vfs

import (
	"context"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"

	"filestore/internal/driver"
	"filestore/internal/index"
	"filestore/internal/mount"
	"filestore/internal/obs"
	"filestore/internal/overlay"
	pathx "filestore/internal/path"
)

const (
	writeTTL     = 6 * time.Hour
	jobTTL       = 24 * time.Hour
	partSize     = 8 << 20
	syncCopyMax  = 64 << 20
	TaskCopy     = "fs:copy"
	TaskMove     = "fs:move"
	TaskReconcile = "fs:reconcile"
)

var ErrNeedAsync = errors.New("need async")
var ErrNotLoaded = errors.New("mount not loaded")

type FS struct {
	mounts  *mount.Table
	index   *index.Store
	overlay *overlay.Store
	rdb     *redis.Client
	asynq   *asynq.Client
	log     *zap.Logger
}

func New(mounts *mount.Table, idx *index.Store, ov *overlay.Store, rdb *redis.Client, ac *asynq.Client, log *zap.Logger) *FS {
	return &FS{mounts: mounts, index: idx, overlay: ov, rdb: rdb, asynq: ac, log: log}
}

type ReadResult struct {
	Mode    string
	URL     string
	Headers map[string]string
	Body    io.ReadCloser
	Info    driver.Info
}

type PresignPart struct {
	N       int               `json:"n"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Size    int64             `json:"size"`
}

type WriteIn struct {
	Size     int64
	MIME     string
	PartSize int64
}

type WriteSession struct {
	ID       string        `json:"id"`
	Mode     string        `json:"mode"`
	PartSize int64         `json:"part_size"`
	Parts    []PresignPart `json:"parts,omitempty"`
}

type writeState struct {
	ID       string `json:"id"`
	MountID  string `json:"mount_id"`
	Mount    string `json:"mount"`
	Key      string `json:"key"`
	Mode     string `json:"mode"`
	UploadID string `json:"upload_id"`
	Size     int64  `json:"size"`
}

type CopyResult struct {
	Async bool   `json:"async"`
	JobID string `json:"job_id,omitempty"`
}

type Job struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Src     string `json:"src,omitempty"`
	Dst     string `json:"dst,omitempty"`
	MountID string `json:"mount_id,omitempty"`
}

func (f *FS) span(ctx context.Context, op string, ref pathx.Ref) (context.Context, trace.Span) {
	return obs.Tracer().Start(ctx, "vfs."+op, trace.WithAttributes(
		attribute.String("op", op),
		attribute.String("mount", ref.Mount),
		attribute.String("key", ref.Key()),
		attribute.String("node", obs.NodeID()),
	))
}

func (f *FS) resolve(ref pathx.Ref) (mount.Record, driver.Driver, error) {
	rec, drv, err := f.mounts.Get(ref.Mount)
	if err != nil {
		return mount.Record{}, nil, fmt.Errorf("%w: %v", ErrNotLoaded, err)
	}
	return rec, drv, nil
}

func backendKey(rec mount.Record, key string) string {
	key = strings.TrimPrefix(key, "/")
	prefix := strings.Trim(rec.Spec["prefix"], "/")
	if prefix == "" {
		return key
	}
	if key == "" {
		return prefix
	}
	return prefix + "/" + key
}

func (f *FS) MountNames(ctx context.Context) ([]string, error) {
	recs, err := f.mounts.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(recs))
	for _, r := range recs {
		out = append(out, r.Name)
	}
	return out, nil
}

func (f *FS) List(ctx context.Context, ref pathx.Ref, rec driver.ListRec) (driver.ListPage, error) {
	ctx, sp := f.span(ctx, "list", ref)
	defer sp.End()
	m, _, err := f.resolve(ref)
	if err != nil {
		return driver.ListPage{}, err
	}
	obs.LogOp(f.log, "list", m.Name, ref.Key(), "index")
	return f.index.ListChildren(ctx, m.ID, ref.Key(), rec)
}

func (f *FS) Stat(ctx context.Context, ref pathx.Ref) (driver.Info, error) {
	ctx, sp := f.span(ctx, "stat", ref)
	defer sp.End()
	m, _, err := f.resolve(ref)
	if err != nil {
		return driver.Info{}, err
	}
	obs.LogOp(f.log, "stat", m.Name, ref.Key(), "index")
	info, err := f.index.Stat(ctx, m.ID, ref.Key())
	if err != nil {
		return driver.Info{}, err
	}
	return info, nil
}

func (f *FS) Mkdir(ctx context.Context, ref pathx.Ref) error {
	ctx, sp := f.span(ctx, "mkdir", ref)
	defer sp.End()
	m, drv, err := f.resolve(ref)
	if err != nil {
		return err
	}
	obs.LogOp(f.log, "mkdir", m.Name, ref.Key(), "driver")
	if drv.Caps().Mkdir {
		if err := drv.Mkdir(ctx, backendKey(m, ref.Key())); err != nil && !errors.Is(err, driver.ErrUnsupported) {
			return err
		}
	}
	return f.index.Upsert(ctx, m.ID, driver.Info{Key: ref.Key(), IsDir: true, ModTime: time.Now().UTC()})
}

func (f *FS) Remove(ctx context.Context, ref pathx.Ref) error {
	ctx, sp := f.span(ctx, "remove", ref)
	defer sp.End()
	m, drv, err := f.resolve(ref)
	if err != nil {
		return err
	}
	obs.LogOp(f.log, "remove", m.Name, ref.Key(), "driver")
	if err := drv.Remove(ctx, backendKey(m, ref.Key())); err != nil && !errors.Is(err, driver.ErrNotFound) {
		return err
	}
	return f.index.DeletePrefix(ctx, m.ID, ref.Key())
}

func (f *FS) Read(ctx context.Context, ref pathx.Ref, rng *driver.Range) (ReadResult, error) {
	ctx, sp := f.span(ctx, "read", ref)
	defer sp.End()
	m, drv, err := f.resolve(ref)
	if err != nil {
		return ReadResult{}, err
	}
	info, _ := f.index.Stat(ctx, m.ID, ref.Key())
	key := backendKey(m, ref.Key())
	if drv.Caps().Presign && rng == nil {
		url, hdr, err := drv.PresignGet(ctx, key, 15*time.Minute)
		if err == nil && url != "" {
			obs.LogOp(f.log, "read", m.Name, ref.Key(), "redirect")
			sp.SetAttributes(attribute.String("mode", "redirect"))
			return ReadResult{Mode: "redirect", URL: url, Headers: hdr, Info: info}, nil
		}
	}
	body, err := drv.Read(ctx, key, rng)
	if err != nil {
		return ReadResult{}, err
	}
	obs.LogOp(f.log, "read", m.Name, ref.Key(), "stream")
	sp.SetAttributes(attribute.String("mode", "stream"))
	return ReadResult{Mode: "stream", Body: body, Info: info}, nil
}

func (f *FS) WriteBegin(ctx context.Context, ref pathx.Ref, in WriteIn) (WriteSession, error) {
	ctx, sp := f.span(ctx, "write_begin", ref)
	defer sp.End()
	m, drv, err := f.resolve(ref)
	if err != nil {
		return WriteSession{}, err
	}
	ps := in.PartSize
	if ps <= 0 {
		ps = partSize
	}
	st := writeState{ID: uuid.NewString(), MountID: m.ID, Mount: m.Name, Key: ref.Key(), Size: in.Size}
	key := backendKey(m, ref.Key())
	sess := WriteSession{ID: st.ID, PartSize: ps}

	if drv.Caps().Presign && in.Size > 0 && in.Size <= ps {
		url, hdr, err := drv.PresignPut(ctx, key, in.Size, 15*time.Minute)
		if err == nil && url != "" {
			st.Mode = "redirect"
			sess.Mode = "redirect"
			sess.Parts = []PresignPart{{N: 1, URL: url, Headers: hdr, Size: in.Size}}
			if err := f.saveWrite(ctx, st); err != nil {
				return WriteSession{}, err
			}
			obs.LogOp(f.log, "write_begin", m.Name, ref.Key(), "redirect")
			return sess, nil
		}
	}

	uploadID, err := drv.CreateUpload(ctx, key)
	if err != nil {
		if errors.Is(err, driver.ErrUnsupported) {
			st.Mode = "stream"
			sess.Mode = "stream"
			if err := f.saveWrite(ctx, st); err != nil {
				return WriteSession{}, err
			}
			obs.LogOp(f.log, "write_begin", m.Name, ref.Key(), "stream")
			return sess, nil
		}
		return WriteSession{}, err
	}
	st.UploadID = uploadID
	st.Mode = "stream"
	sess.Mode = "stream"

	if pp, ok := drv.(driver.PartPresigner); ok && drv.Caps().Presign && in.Size > 0 {
		nParts := int((in.Size + ps - 1) / ps)
		var parts []PresignPart
		okParts := true
		remain := in.Size
		for i := 1; i <= nParts; i++ {
			sz := ps
			if remain < ps {
				sz = remain
			}
			url, hdr, err := pp.PresignPart(ctx, uploadID, i, sz, 15*time.Minute)
			if err != nil {
				okParts = false
				break
			}
			parts = append(parts, PresignPart{N: i, URL: url, Headers: hdr, Size: sz})
			remain -= sz
		}
		if okParts && len(parts) > 0 {
			st.Mode = "redirect"
			sess.Mode = "redirect"
			sess.Parts = parts
		}
	}
	if err := f.saveWrite(ctx, st); err != nil {
		return WriteSession{}, err
	}
	obs.LogOp(f.log, "write_begin", m.Name, ref.Key(), sess.Mode)
	return sess, nil
}

func (f *FS) WritePart(ctx context.Context, sid string, n int, r io.Reader) error {
	st, drv, err := f.loadWrite(ctx, sid)
	if err != nil {
		return err
	}
	obs.LogOp(f.log, "write_part", st.Mount, st.Key, st.Mode)
	if st.Mode == "redirect" {
		_, _ = io.Copy(io.Discard, r)
		return nil
	}
	if st.UploadID == "" {
		rec, drv2, err := f.mounts.Get(st.Mount)
		if err != nil {
			return err
		}
		body, err := io.ReadAll(r)
		if err != nil {
			return err
		}
		return drv2.Write(ctx, backendKey(rec, st.Key), bytes.NewReader(body), int64(len(body)))
	}
	return drv.PutPart(ctx, st.UploadID, n, r)
}

func (f *FS) WriteComplete(ctx context.Context, sid string) error {
	st, drv, err := f.loadWrite(ctx, sid)
	if err != nil {
		return err
	}
	obs.LogOp(f.log, "write_complete", st.Mount, st.Key, st.Mode)
	if st.UploadID != "" {
		if err := drv.Complete(ctx, st.UploadID); err != nil {
			_ = f.index.Delete(ctx, st.MountID, st.Key)
			return err
		}
	}
	info := driver.Info{Key: st.Key, Size: st.Size, ModTime: time.Now().UTC()}
	if rec, d2, err := f.mounts.Get(st.Mount); err == nil {
		if stt, err := d2.Stat(ctx, backendKey(rec, st.Key)); err == nil {
			stt.Key = st.Key
			info = stt
		}
	}
	if err := f.index.Upsert(ctx, st.MountID, info); err != nil {
		return err
	}
	_ = f.rdb.Del(ctx, writeKey(sid)).Err()
	return nil
}

func (f *FS) WriteAbort(ctx context.Context, sid string) error {
	st, drv, err := f.loadWrite(ctx, sid)
	if err != nil {
		return err
	}
	if st.UploadID != "" {
		_ = drv.Abort(ctx, st.UploadID)
	}
	_ = f.index.Delete(ctx, st.MountID, st.Key)
	return f.rdb.Del(ctx, writeKey(sid)).Err()
}

func (f *FS) Copy(ctx context.Context, src, dst pathx.Ref, async bool) (CopyResult, error) {
	return f.xfer(ctx, "copy", src, dst, async, false)
}

func (f *FS) Move(ctx context.Context, src, dst pathx.Ref, async bool) (CopyResult, error) {
	return f.xfer(ctx, "move", src, dst, async, true)
}

func (f *FS) xfer(ctx context.Context, op string, src, dst pathx.Ref, async, move bool) (CopyResult, error) {
	ctx, sp := f.span(ctx, op, src)
	defer sp.End()
	sm, sd, err := f.resolve(src)
	if err != nil {
		return CopyResult{}, err
	}
	dm, dd, err := f.resolve(dst)
	if err != nil {
		return CopyResult{}, err
	}
	same := sm.ID == dm.ID
	if same && ((move && sd.Caps().Move) || (!move && sd.Caps().Copy)) {
		sk, dk := backendKey(sm, src.Key()), backendKey(dm, dst.Key())
		if move {
			err = sd.Move(ctx, sk, dk)
		} else {
			err = sd.Copy(ctx, sk, dk)
		}
		if err != nil {
			return CopyResult{}, err
		}
		info := driver.Info{Key: dst.Key(), ModTime: time.Now().UTC()}
		if st, err := dd.Stat(ctx, dk); err == nil {
			st.Key = dst.Key()
			info = st
		}
		if err := f.index.Upsert(ctx, dm.ID, info); err != nil {
			return CopyResult{}, err
		}
		if move {
			_ = f.index.DeletePrefix(ctx, sm.ID, src.Key())
		}
		obs.LogOp(f.log, op, sm.Name, src.Key(), "driver")
		return CopyResult{}, nil
	}

	var srcSize int64
	if inf, err := f.index.Stat(ctx, sm.ID, src.Key()); err == nil {
		srcSize = inf.Size
	}
	needAsync := !same || !sd.Caps().Copy
	if needAsync && async {
		return f.enqueue(ctx, op, src, dst)
	}
	if needAsync && srcSize > syncCopyMax {
		if f.asynq == nil {
			return CopyResult{}, ErrNeedAsync
		}
		return f.enqueue(ctx, op, src, dst)
	}
	if err := f.streamCopy(ctx, src, dst, sm, sd, dm, dd); err != nil {
		return CopyResult{}, err
	}
	if move {
		if err := f.Remove(ctx, src); err != nil {
			return CopyResult{}, err
		}
	}
	obs.LogOp(f.log, op, sm.Name, src.Key(), "stream")
	return CopyResult{}, nil
}

func (f *FS) streamCopy(ctx context.Context, src, dst pathx.Ref, sm mount.Record, sd driver.Driver, dm mount.Record, dd driver.Driver) error {
	in, err := sd.Read(ctx, backendKey(sm, src.Key()), nil)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := dd.Write(ctx, backendKey(dm, dst.Key()), in, -1); err != nil {
		return err
	}
	info := driver.Info{Key: dst.Key(), ModTime: time.Now().UTC()}
	if st, err := dd.Stat(ctx, backendKey(dm, dst.Key())); err == nil {
		st.Key = dst.Key()
		info = st
	}
	return f.index.Upsert(ctx, dm.ID, info)
}

func (f *FS) enqueue(ctx context.Context, op string, src, dst pathx.Ref) (CopyResult, error) {
	if f.asynq == nil {
		return CopyResult{}, ErrNeedAsync
	}
	id := uuid.NewString()
	job := Job{ID: id, Type: op, Status: "pending", Src: src.String(), Dst: dst.String()}
	if err := f.saveJob(ctx, job); err != nil {
		return CopyResult{}, err
	}
	typ := TaskCopy
	if op == "move" {
		typ = TaskMove
	}
	payload, _ := json.Marshal(job)
	if _, err := f.asynq.EnqueueContext(ctx, asynq.NewTask(typ, payload), asynq.Queue("copy")); err != nil {
		return CopyResult{}, err
	}
	obs.LogOp(f.log, op, src.Mount, src.Key(), "async")
	return CopyResult{Async: true, JobID: id}, nil
}

func (f *FS) Reconcile(ctx context.Context, mountRef string, async bool) (CopyResult, error) {
	rec, drv, err := f.mounts.Get(mountRef)
	if err != nil {
		r, err2 := f.mounts.GetRecord(ctx, mountRef)
		if err2 != nil {
			return CopyResult{}, err
		}
		rec = r
	}
	if async && f.asynq != nil {
		id := uuid.NewString()
		job := Job{ID: id, Type: "reconcile", Status: "pending", MountID: rec.ID}
		if err := f.saveJob(ctx, job); err != nil {
			return CopyResult{}, err
		}
		payload, _ := json.Marshal(job)
		if _, err := f.asynq.EnqueueContext(ctx, asynq.NewTask(TaskReconcile, payload), asynq.Queue("reconcile")); err != nil {
			return CopyResult{}, err
		}
		return CopyResult{Async: true, JobID: id}, nil
	}
	if drv == nil {
		_, drv, err = f.mounts.Get(rec.ID)
		if err != nil {
			return CopyResult{}, err
		}
	}
	if !drv.Caps().List {
		return CopyResult{}, nil
	}
	obs.LogOp(f.log, "reconcile", rec.Name, "", "driver")
	prefix := strings.Trim(rec.Spec["prefix"], "/")
	page, err := drv.List(ctx, prefix, driver.ListRec{Recursive: true, Limit: 100000})
	if err != nil {
		return CopyResult{}, err
	}
	infos := make([]driver.Info, 0, len(page.Entries))
	for _, e := range page.Entries {
		e.Key = stripPrefix(e.Key, prefix)
		infos = append(infos, e)
	}
	return CopyResult{}, f.index.ReplaceMount(ctx, rec.ID, infos)
}

func (f *FS) RunJob(ctx context.Context, job Job) error {
	job.Status = "running"
	_ = f.saveJob(ctx, job)
	var err error
	switch job.Type {
	case "copy", "move":
		src, e1 := pathx.Parse(job.Src)
		dst, e2 := pathx.Parse(job.Dst)
		if e1 != nil || e2 != nil {
			err = fmt.Errorf("bad job refs")
			break
		}
		_, err = f.xfer(ctx, job.Type, src, dst, false, job.Type == "move")
	case "reconcile":
		_, err = f.Reconcile(ctx, job.MountID, false)
	default:
		err = fmt.Errorf("unknown job type %s", job.Type)
	}
	if err != nil {
		job.Status = "error"
		job.Error = err.Error()
		_ = f.saveJob(ctx, job)
		return err
	}
	job.Status = "ok"
	return f.saveJob(ctx, job)
}

func (f *FS) GetJob(ctx context.Context, id string) (Job, error) {
	b, err := f.rdb.Get(ctx, jobKey(id)).Bytes()
	if err != nil {
		return Job{}, err
	}
	var j Job
	err = json.Unmarshal(b, &j)
	return j, err
}

func (f *FS) saveJob(ctx context.Context, j Job) error {
	b, _ := json.Marshal(j)
	return f.rdb.Set(ctx, jobKey(j.ID), b, jobTTL).Err()
}

func writeKey(id string) string { return "sess:write:" + id }
func jobKey(id string) string   { return "job:" + id }

func (f *FS) saveWrite(ctx context.Context, st writeState) error {
	b, _ := json.Marshal(st)
	return f.rdb.Set(ctx, writeKey(st.ID), b, writeTTL).Err()
}

func (f *FS) loadWrite(ctx context.Context, sid string) (writeState, driver.Driver, error) {
	b, err := f.rdb.Get(ctx, writeKey(sid)).Bytes()
	if err != nil {
		return writeState{}, nil, err
	}
	var st writeState
	if err := json.Unmarshal(b, &st); err != nil {
		return writeState{}, nil, err
	}
	_, drv, err := f.mounts.Get(st.Mount)
	if err != nil {
		return writeState{}, nil, err
	}
	return st, drv, nil
}

func stripPrefix(key, prefix string) string {
	key = strings.TrimPrefix(key, "/")
	prefix = strings.Trim(prefix, "/")
	if prefix == "" {
		return key
	}
	if key == prefix {
		return ""
	}
	return strings.TrimPrefix(key, prefix+"/")
}
