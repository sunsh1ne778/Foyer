package s3gw

import (
	"encoding/xml"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"filestore/internal/driver"
	pathx "filestore/internal/path"
	"filestore/internal/vfs"
)

type Gateway struct {
	fs  *vfs.FS
	log *zap.Logger
	ak  string
	sk  string
	h   *gin.Engine
}

func New(fs *vfs.FS, log *zap.Logger) http.Handler {
	g := &Gateway{
		fs:  fs,
		log: log,
		ak:  os.Getenv("FILESTORE_S3_ACCESS_KEY"),
		sk:  os.Getenv("FILESTORE_S3_SECRET_KEY"),
		h:   gin.New(),
	}
	g.h.Use(gin.Recovery())
	g.h.Use(g.auth)
	g.h.GET("/", g.listBuckets)
	g.h.Any("/:bucket", g.bucket)
	g.h.Any("/:bucket/*key", g.object)
	return g.h
}

func (g *Gateway) auth(c *gin.Context) {
	if g.ak == "" {
		c.Next()
		return
	}
	authz := c.GetHeader("Authorization")
	if strings.Contains(authz, g.ak) || strings.Contains(c.Request.URL.RawQuery, g.ak) {
		c.Next()
		return
	}
	if authz == "" && c.Query("AWSAccessKeyId") == g.ak {
		c.Next()
		return
	}
	c.Header("Content-Type", "application/xml")
	c.XML(http.StatusForbidden, gin.H{"Error": "AccessDenied"})
	c.Abort()
}

func (g *Gateway) listBuckets(c *gin.Context) {
	if c.Request.Method != http.MethodGet {
		c.Status(http.StatusMethodNotAllowed)
		return
	}
	names, err := g.fs.MountNames(c.Request.Context())
	if err != nil {
		c.String(http.StatusInternalServerError, err.Error())
		return
	}
	var b strings.Builder
	b.WriteString(xmlHeader)
	b.WriteString(`<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets>`)
	for _, n := range names {
		b.WriteString(`<Bucket><Name>`)
		b.WriteString(xmlEscape(n))
		b.WriteString(`</Name></Bucket>`)
	}
	b.WriteString(`</Buckets></ListAllMyBucketsResult>`)
	c.Header("Content-Type", "application/xml")
	c.String(http.StatusOK, b.String())
}

func (g *Gateway) bucket(c *gin.Context) {
	bucket := c.Param("bucket")
	key := strings.TrimPrefix(c.Query("prefix"), "/")
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead:
		g.list(c, bucket, key)
	case http.MethodPut:
		c.Status(http.StatusOK)
	case http.MethodDelete:
		c.Status(http.StatusNoContent)
	default:
		c.Status(http.StatusMethodNotAllowed)
	}
}

func (g *Gateway) object(c *gin.Context) {
	bucket := c.Param("bucket")
	key := strings.TrimPrefix(c.Param("key"), "/")
	ref, err := pathx.Parse(bucket + ":/" + key)
	if err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	switch c.Request.Method {
	case http.MethodGet:
		g.get(c, ref)
	case http.MethodHead:
		g.head(c, ref)
	case http.MethodPut:
		if src := c.GetHeader("x-amz-copy-source"); src != "" {
			g.copy(c, ref, src)
			return
		}
		g.put(c, ref)
	case http.MethodDelete:
		if err := g.fs.Remove(c.Request.Context(), ref); err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.Status(http.StatusNoContent)
	default:
		c.Status(http.StatusMethodNotAllowed)
	}
}

func (g *Gateway) list(c *gin.Context, bucket, prefix string) {
	p := bucket + ":/"
	if prefix != "" {
		p = bucket + ":/" + prefix
	}
	ref, err := pathx.Parse(p)
	if err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	page, err := g.fs.List(c.Request.Context(), ref, driver.ListRec{Recursive: c.Query("delimiter") == "", Limit: 1000})
	if err != nil {
		c.Header("Content-Type", "application/xml")
		c.String(http.StatusNotFound, `<Error><Code>NoSuchBucket</Code></Error>`)
		return
	}
	var b strings.Builder
	b.WriteString(xmlHeader)
	b.WriteString(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>`)
	b.WriteString(xmlEscape(bucket))
	b.WriteString(`</Name>`)
	for _, e := range page.Entries {
		if e.IsDir {
			b.WriteString(`<CommonPrefixes><Prefix>`)
			b.WriteString(xmlEscape(e.Key + "/"))
			b.WriteString(`</Prefix></CommonPrefixes>`)
			continue
		}
		b.WriteString(`<Contents><Key>`)
		b.WriteString(xmlEscape(e.Key))
		b.WriteString(`</Key><Size>`)
		b.WriteString(itoa(e.Size))
		b.WriteString(`</Size><LastModified>`)
		b.WriteString(e.ModTime.UTC().Format(time.RFC3339))
		b.WriteString(`</LastModified><ETag>&quot;`)
		b.WriteString(xmlEscape(e.ETag))
		b.WriteString(`&quot;</ETag></Contents>`)
	}
	b.WriteString(`</ListBucketResult>`)
	c.Header("Content-Type", "application/xml")
	c.String(http.StatusOK, b.String())
}

func (g *Gateway) get(c *gin.Context, ref pathx.Ref) {
	res, err := g.fs.Read(c.Request.Context(), ref, nil)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	if res.Mode == "redirect" && res.URL != "" {
		c.Redirect(http.StatusTemporaryRedirect, res.URL)
		return
	}
	defer res.Body.Close()
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, res.Body)
}

func (g *Gateway) head(c *gin.Context, ref pathx.Ref) {
	info, err := g.fs.Stat(c.Request.Context(), ref)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Content-Length", itoa(info.Size))
	if info.ETag != "" {
		c.Header("ETag", `"`+info.ETag+`"`)
	}
	c.Status(http.StatusOK)
}

func (g *Gateway) put(c *gin.Context, ref pathx.Ref) {
	sess, err := g.fs.WriteBegin(c.Request.Context(), ref, vfs.WriteIn{Size: c.Request.ContentLength})
	if err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	if sess.Mode == "redirect" && len(sess.Parts) == 1 {
		// client (mc) expects to PUT here; proxy stream to keep S3 protocol
	}
	if err := g.fs.WritePart(c.Request.Context(), sess.ID, 1, c.Request.Body); err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	if err := g.fs.WriteComplete(c.Request.Context(), sess.ID); err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	c.Status(http.StatusOK)
}

func (g *Gateway) copy(c *gin.Context, dst pathx.Ref, srcHeader string) {
	srcHeader = strings.TrimPrefix(srcHeader, "/")
	bucket, key, ok := strings.Cut(srcHeader, "/")
	if !ok {
		c.Status(http.StatusBadRequest)
		return
	}
	src, err := pathx.Parse(bucket + ":/" + key)
	if err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	if _, err := g.fs.Copy(c.Request.Context(), src, dst, false); err != nil {
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	c.Header("Content-Type", "application/xml")
	c.String(http.StatusOK, xmlHeader+`<CopyObjectResult></CopyObjectResult>`)
}

const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?>`

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}
