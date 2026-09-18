package cliclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server string `yaml:"server" json:"server"`
	Token  string `yaml:"token" json:"token"`
}

func ConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".filestore", "config")
}

func LoadConfig() (Config, error) {
	b, err := os.ReadFile(ConfigPath())
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return Config{}, err
	}
	return c, nil
}

func SaveConfig(c Config) error {
	p := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

type Client struct {
	base   string
	token  string
	http   *http.Client
	asJSON bool
}

func New(cfg Config, asJSON bool) *Client {
	return &Client{
		base:   strings.TrimRight(cfg.Server, "/"),
		token:  cfg.Token,
		http:   &http.Client{Timeout: 0, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }},
		asJSON: asJSON,
	}
}

func (c *Client) do(method, path string, query url.Values, body any, out any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		switch b := body.(type) {
		case io.Reader:
			rdr = b
		default:
			buf, err := json.Marshal(b)
			if err != nil {
				return nil, err
			}
			rdr = bytes.NewReader(buf)
		}
	}
	u := c.base + path
	if query != nil {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, u, rdr)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		if _, ok := body.(io.Reader); !ok {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if out != nil && res.StatusCode < 300 && res.Header.Get("Content-Type") != "" && strings.Contains(res.Header.Get("Content-Type"), "json") {
		defer res.Body.Close()
		return res, json.NewDecoder(res.Body).Decode(out)
	}
	if out != nil && res.StatusCode < 300 {
		defer res.Body.Close()
		return res, json.NewDecoder(res.Body).Decode(out)
	}
	if res.StatusCode >= 400 {
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return res, fmt.Errorf("%s: %s", res.Status, bytes.TrimSpace(b))
	}
	return res, nil
}

func (c *Client) Login(username, password string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/login", nil, map[string]string{"username": username, "password": password}, &out)
	return out, err
}

func (c *Client) List(p string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodGet, "/v1/fs/list", url.Values{"p": {p}}, nil, &out)
	return out, err
}

func (c *Client) Stat(p string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodGet, "/v1/fs/stat", url.Values{"p": {p}}, nil, &out)
	return out, err
}

func (c *Client) Mkdir(p string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/fs/mkdir", url.Values{"p": {p}}, nil, &out)
	return out, err
}

func (c *Client) Remove(p string) error {
	res, err := c.do(http.MethodDelete, "/v1/fs", url.Values{"p": {p}}, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

type WriteSession struct {
	ID       string `json:"id"`
	Mode     string `json:"mode"`
	PartSize int64  `json:"part_size"`
	Parts    []struct {
		N       int               `json:"n"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
		Size    int64             `json:"size"`
	} `json:"parts"`
}

func (c *Client) WriteBegin(p string, size int64) (WriteSession, error) {
	var out WriteSession
	_, err := c.do(http.MethodPost, "/v1/fs/writes", nil, map[string]any{"p": p, "size": size}, &out)
	return out, err
}

func (c *Client) WritePart(id string, n int, r io.Reader) error {
	res, err := c.do(http.MethodPut, fmt.Sprintf("/v1/fs/writes/%s/parts/%d", id, n), nil, r, nil)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return nil
}

func (c *Client) WriteComplete(id string) error {
	var out map[string]any
	_, err := c.do(http.MethodPost, fmt.Sprintf("/v1/fs/writes/%s/complete", id), nil, nil, &out)
	return err
}

func (c *Client) Read(p string) (*http.Response, error) {
	follow := &http.Client{Timeout: 0}
	req, err := http.NewRequest(http.MethodGet, c.base+"/v1/fs?"+url.Values{"p": {p}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := follow.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return nil, fmt.Errorf("%s: %s", res.Status, bytes.TrimSpace(b))
	}
	return res, nil
}

func (c *Client) Copy(src, dst string, async bool) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/fs/copy", nil, map[string]any{"src": src, "dst": dst, "async": async}, &out)
	return out, err
}

func (c *Client) Move(src, dst string, async bool) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/fs/move", nil, map[string]any{"src": src, "dst": dst, "async": async}, &out)
	return out, err
}

func (c *Client) Job(id string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodGet, "/v1/jobs/"+id, nil, nil, &out)
	return out, err
}

func (c *Client) ListMounts() (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodGet, "/v1/mounts", nil, nil, &out)
	return out, err
}

func (c *Client) CreateMount(body map[string]any) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/mounts", nil, body, &out)
	return out, err
}

func (c *Client) DeleteMount(id string) error {
	res, err := c.do(http.MethodDelete, "/v1/mounts/"+id, nil, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (c *Client) ProbeMount(id string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/mounts/"+id+"/probe", nil, nil, &out)
	return out, err
}

func (c *Client) Unmount(id string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/mounts/"+id+"/unmount", nil, nil, &out)
	return out, err
}

func (c *Client) Remount(id string) (map[string]any, error) {
	var out map[string]any
	_, err := c.do(http.MethodPost, "/v1/mounts/"+id+"/mount", nil, nil, &out)
	return out, err
}

func PutFile(c *Client, localPath, dest string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	sess, err := c.WriteBegin(dest, st.Size())
	if err != nil {
		return err
	}
	if sess.Mode == "redirect" && len(sess.Parts) > 0 {
		off := int64(0)
		direct := &http.Client{Timeout: 0}
		for _, p := range sess.Parts {
			chunk := io.NewSectionReader(f, off, p.Size)
			req, err := http.NewRequest(http.MethodPut, p.URL, chunk)
			if err != nil {
				return err
			}
			for k, v := range p.Headers {
				req.Header.Set(k, v)
			}
			req.ContentLength = p.Size
			res, err := direct.Do(req)
			if err != nil {
				return err
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode >= 300 {
				return fmt.Errorf("presign put %d", res.StatusCode)
			}
			off += p.Size
		}
		return c.WriteComplete(sess.ID)
	}
	ps := sess.PartSize
	if ps <= 0 {
		ps = 8 << 20
	}
	n := 1
	buf := make([]byte, ps)
	for {
		nr, err := io.ReadFull(f, buf)
		if nr > 0 {
			if err := c.WritePart(sess.ID, n, bytes.NewReader(buf[:nr])); err != nil {
				return err
			}
			n++
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return c.WriteComplete(sess.ID)
}

func GetFile(c *Client, src, localPath string) error {
	res, err := c.Read(src)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil && filepath.Dir(localPath) != "." {
		return err
	}
	f, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, res.Body)
	return err
}
