package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
	"go.uber.org/zap"

	"filestore/internal/auth"
	"filestore/internal/driver"
	"filestore/internal/mount"
	"filestore/internal/obs"
	pathx "filestore/internal/path"
	"filestore/internal/vfs"
)

type Server struct {
	cfg    *gin.Engine
	fs     *vfs.FS
	mounts *mount.Table
	auth   *auth.Service
	pool   *pgxpool.Pool
	rdb    *redis.Client
	log    *zap.Logger
}

func New(fs *vfs.FS, mounts *mount.Table, a *auth.Service, pool *pgxpool.Pool, rdb *redis.Client, log *zap.Logger) *Server {
	g := gin.New()
	g.Use(gin.Recovery(), otelgin.Middleware("filestore"), accessLog(log))
	s := &Server{cfg: g, fs: fs, mounts: mounts, auth: a, pool: pool, rdb: rdb, log: log}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.cfg }

func accessLog(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Info("http",
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("dur", time.Since(start)),
			zap.String("node", obs.NodeID()),
		)
	}
}

func (s *Server) routes() {
	s.cfg.GET("/v1/health", s.health)
	s.cfg.GET("/metrics", gin.WrapH(obs.MetricsHandler()))
	s.cfg.POST("/v1/login", s.login)
	v1 := s.cfg.Group("/v1")
	v1.Use(s.auth.Middleware())
	v1.GET("/mounts", s.listMounts)
	v1.POST("/mounts", s.createMount)
	v1.PATCH("/mounts/:id", s.patchMount)
	v1.DELETE("/mounts/:id", s.deleteMount)
	v1.POST("/mounts/:id/probe", s.probeMount)
	v1.POST("/mounts/:id/unmount", s.unmount)
	v1.POST("/mounts/:id/mount", s.remount)
	v1.POST("/mounts/:id/reconcile", s.reconcile)
	v1.GET("/fs/list", s.list)
	v1.GET("/fs/stat", s.stat)
	v1.POST("/fs/mkdir", s.mkdir)
	v1.DELETE("/fs", s.remove)
	v1.GET("/fs", s.read)
	v1.POST("/fs/writes", s.writeBegin)
	v1.PUT("/fs/writes/:id/parts/:n", s.writePart)
	v1.POST("/fs/writes/:id/complete", s.writeComplete)
	v1.DELETE("/fs/writes/:id", s.writeAbort)
	v1.POST("/fs/copy", s.copy)
	v1.POST("/fs/move", s.move)
	v1.GET("/jobs/:id", s.job)
}

func (s *Server) health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": "postgres"})
		return
	}
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": "redis"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) login(c *gin.Context) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad json"})
		return
	}
	tok, err := s.auth.Login(in.Username, in.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": tok, "username": in.Username})
}

func mountJSON(r mount.Record) gin.H {
	return gin.H{
		"id": r.ID, "name": r.Name, "type": r.Type, "spec": r.PublicSpec(),
		"status": r.Status, "last_error": r.LastError,
		"created_at": r.CreatedAt, "updated_at": r.UpdatedAt,
	}
}

func (s *Server) listMounts(c *gin.Context) {
	list, err := s.mounts.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, r := range list {
		out = append(out, mountJSON(r))
	}
	c.JSON(http.StatusOK, gin.H{"mounts": out})
}

func (s *Server) createMount(c *gin.Context) {
	var in struct {
		ID   string            `json:"id"`
		Name string            `json:"name"`
		Type string            `json:"type"`
		Spec map[string]string `json:"spec"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad json"})
		return
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	if in.Name == "" || in.Type == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name and type required"})
		return
	}
	rec := mount.Record{ID: in.ID, Name: in.Name, Type: in.Type, Spec: in.Spec, Status: "mounted"}
	if err := s.mounts.Attach(c.Request.Context(), rec); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_, _ = s.fs.Reconcile(c.Request.Context(), rec.ID, false)
	got, _ := s.mounts.GetRecord(c.Request.Context(), rec.ID)
	c.JSON(http.StatusOK, mountJSON(got))
}

func (s *Server) patchMount(c *gin.Context) {
	var in struct {
		Name   *string           `json:"name"`
		Type   *string           `json:"type"`
		Spec   map[string]string `json:"spec"`
		Status *string           `json:"status"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad json"})
		return
	}
	if err := s.mounts.Update(c.Request.Context(), c.Param("id"), in.Name, in.Type, in.Spec, in.Status); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	got, err := s.mounts.GetRecord(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, mountJSON(got))
}

func (s *Server) deleteMount(c *gin.Context) {
	if err := s.mounts.Delete(c.Request.Context(), c.Param("id")); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) probeMount(c *gin.Context) {
	rec, err := s.mounts.GetRecord(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err := s.mounts.Probe(c.Request.Context(), rec.Type, rec.Spec); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) unmount(c *gin.Context) {
	if err := s.mounts.Detach(c.Request.Context(), c.Param("id")); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) remount(c *gin.Context) {
	st := "mounted"
	if err := s.mounts.Update(c.Request.Context(), c.Param("id"), nil, nil, nil, &st); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_, _ = s.fs.Reconcile(c.Request.Context(), c.Param("id"), false)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) reconcile(c *gin.Context) {
	res, err := s.fs.Reconcile(c.Request.Context(), c.Param("id"), true)
	if err != nil {
		if errors.Is(err, vfs.ErrNeedAsync) {
			res, err = s.fs.Reconcile(c.Request.Context(), c.Param("id"), false)
		}
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if res.Async {
		c.JSON(http.StatusAccepted, gin.H{"job_id": res.JobID})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func parseP(c *gin.Context) (pathx.Ref, bool) {
	p := c.Query("p")
	if p == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query p=mount:path required"})
		return pathx.Ref{}, false
	}
	ref, err := pathx.Parse(p)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return pathx.Ref{}, false
	}
	return ref, true
}

func (s *Server) list(c *gin.Context) {
	ref, ok := parseP(c)
	if !ok {
		return
	}
	rec := driver.ListRec{Recursive: c.Query("recursive") == "1", Limit: atoi(c.Query("limit"))}
	page, err := s.fs.List(c.Request.Context(), ref, rec)
	if err != nil {
		writeVFSErr(c, err)
		return
	}
	entries := make([]gin.H, 0, len(page.Entries))
	for _, e := range page.Entries {
		entries = append(entries, gin.H{
			"name": pathx.Base(e.Key), "key": e.Key, "is_dir": e.IsDir,
			"size": e.Size, "etag": e.ETag, "mtime": e.ModTime,
			"p": ref.Mount + ":/" + e.Key,
		})
	}
	c.JSON(http.StatusOK, gin.H{"entries": entries, "cursor": page.Cursor})
}

func (s *Server) stat(c *gin.Context) {
	ref, ok := parseP(c)
	if !ok {
		return
	}
	info, err := s.fs.Stat(c.Request.Context(), ref)
	if err != nil {
		writeVFSErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"name": pathx.Base(info.Key), "key": info.Key, "is_dir": info.IsDir,
		"size": info.Size, "etag": info.ETag, "mtime": info.ModTime, "p": ref.String(),
	})
}

func (s *Server) mkdir(c *gin.Context) {
	ref, ok := parseP(c)
	if !ok {
		return
	}
	if err := s.fs.Mkdir(c.Request.Context(), ref); err != nil {
		writeVFSErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "p": ref.String()})
}

func (s *Server) remove(c *gin.Context) {
	ref, ok := parseP(c)
	if !ok {
		return
	}
	if err := s.fs.Remove(c.Request.Context(), ref); err != nil {
		writeVFSErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) read(c *gin.Context) {
	ref, ok := parseP(c)
	if !ok {
		return
	}
	var rng *driver.Range
	if rh := c.GetHeader("Range"); strings.HasPrefix(rh, "bytes=") {
		rng = parseRange(rh)
	}
	res, err := s.fs.Read(c.Request.Context(), ref, rng)
	if err != nil {
		writeVFSErr(c, err)
		return
	}
	if res.Mode == "redirect" {
		c.Redirect(http.StatusTemporaryRedirect, res.URL)
		return
	}
	defer res.Body.Close()
	if res.Info.ETag != "" {
		c.Header("ETag", res.Info.ETag)
	}
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, res.Body)
}

func (s *Server) writeBegin(c *gin.Context) {
	var in struct {
		P    string `json:"p"`
		Size int64  `json:"size"`
		MIME string `json:"mime"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad json"})
		return
	}
	ref, err := pathx.Parse(in.P)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	sess, err := s.fs.WriteBegin(c.Request.Context(), ref, vfs.WriteIn{Size: in.Size, MIME: in.MIME})
	if err != nil {
		writeVFSErr(c, err)
		return
	}
	c.JSON(http.StatusOK, sess)
}

func (s *Server) writePart(c *gin.Context) {
	n, _ := strconv.Atoi(c.Param("n"))
	if err := s.fs.WritePart(c.Request.Context(), c.Param("id"), n, c.Request.Body); err != nil {
		writeVFSErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) writeComplete(c *gin.Context) {
	if err := s.fs.WriteComplete(c.Request.Context(), c.Param("id")); err != nil {
		writeVFSErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) writeAbort(c *gin.Context) {
	if err := s.fs.WriteAbort(c.Request.Context(), c.Param("id")); err != nil {
		writeVFSErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) copy(c *gin.Context) { s.xfer(c, false) }
func (s *Server) move(c *gin.Context) { s.xfer(c, true) }

func (s *Server) xfer(c *gin.Context, move bool) {
	var in struct {
		Src   string `json:"src"`
		Dst   string `json:"dst"`
		Async bool   `json:"async"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad json"})
		return
	}
	src, err := pathx.Parse(in.Src)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dst, err := pathx.Parse(in.Dst)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var res vfs.CopyResult
	if move {
		res, err = s.fs.Move(c.Request.Context(), src, dst, in.Async)
	} else {
		res, err = s.fs.Copy(c.Request.Context(), src, dst, in.Async)
	}
	if err != nil {
		writeVFSErr(c, err)
		return
	}
	if res.Async {
		c.JSON(http.StatusAccepted, gin.H{"job_id": res.JobID})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *Server) job(c *gin.Context) {
	j, err := s.fs.GetJob(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, j)
}

func writeVFSErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, vfs.ErrNotLoaded):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, vfs.ErrNeedAsync):
		c.JSON(http.StatusAccepted, gin.H{"error": err.Error()})
	case errors.Is(err, driver.ErrNotFound), errors.Is(err, pgx.ErrNoRows):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	}
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func parseRange(h string) *driver.Range {
	h = strings.TrimPrefix(h, "bytes=")
	a, b, ok := strings.Cut(h, "-")
	if !ok {
		return nil
	}
	start, _ := strconv.ParseInt(a, 10, 64)
	end := int64(-1)
	if b != "" {
		end, _ = strconv.ParseInt(b, 10, 64)
	}
	return &driver.Range{Start: start, End: end}
}
