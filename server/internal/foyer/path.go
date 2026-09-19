package foyer

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"
)

func MapHostPath(cfg Config, userPath string) (string, error) {
	s := strings.TrimSpace(userPath)
	if s == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.HasPrefix(s, "file:") {
		u, err := url.Parse(s)
		if err != nil {
			return "", err
		}
		s = u.Path
		if s == "" {
			s = u.Host
		}
	}
	s = strings.ReplaceAll(s, "\\", "/")
	if strings.HasPrefix(s, "/mnt/") || strings.HasPrefix(s, "/host/") || s == "/host" || s == "/mnt" {
		return path.Clean(s), nil
	}
	if len(s) >= 2 && unicode.IsLetter(rune(s[0])) && s[1] == ':' {
		letter := strings.ToLower(s[:1])
		rest := strings.TrimPrefix(s[2:], "/")
		if rest == "" {
			return path.Clean("/mnt/" + letter), nil
		}
		return path.Clean("/mnt/" + letter + "/" + rest), nil
	}
	host := strings.TrimSpace(cfg.HostData)
	mount := strings.TrimSuffix(strings.ReplaceAll(cfg.HostMount, "\\", "/"), "/")
	if mount == "" {
		mount = "/host"
	}
	if host == "" {
		if strings.HasPrefix(s, "/") {
			return path.Clean(s), nil
		}
		return "", fmt.Errorf("use a Windows path like E:\\data or a container path under /mnt/<drive>")
	}
	hostSlash := strings.TrimSuffix(strings.ReplaceAll(host, "\\", "/"), "/")
	userSlash := strings.TrimSuffix(s, "/")
	if len(userSlash) >= 2 && userSlash[1] == ':' {
		userSlash = strings.ToUpper(userSlash[:1]) + userSlash[1:]
	}
	if len(hostSlash) >= 2 && hostSlash[1] == ':' {
		hostSlash = strings.ToUpper(hostSlash[:1]) + hostSlash[1:]
	}
	if !strings.EqualFold(userSlash, hostSlash) && !hasDirPrefix(userSlash, hostSlash) {
		return "", fmt.Errorf("path %s is not under FOYER_HOST_DATA %s", userPath, host)
	}
	rel := strings.TrimPrefix(userSlash[len(hostSlash):], "/")
	if rel == "" || rel == "." {
		return mount, nil
	}
	return path.Clean(mount + "/" + rel), nil
}

func hasDirPrefix(p, root string) bool {
	if len(p) <= len(root) {
		return false
	}
	if !strings.EqualFold(p[:len(root)], root) {
		return false
	}
	return p[len(root)] == '/'
}

func FileURI(containerPath string) string {
	p := path.Clean("/" + strings.TrimPrefix(filepath.ToSlash(containerPath), "/"))
	if p != "/" && !strings.HasSuffix(p, "/") {
		p += "/"
	}
	// 必须走 url.URL 做百分号编码：文件名里的 #（还有 ?、%、空格等）直接拼进
	// URI 会被下游的 url.Parse 当成 fragment/query 分隔符吃掉，导致导入路径
	// 被截断到父目录。编码后 OpenStorageURI 的 u.Path 能还原出原始路径。
	return (&url.URL{Scheme: "file", Path: p}).String()
}

func DetectHostDrives() []string {
	ents, err := os.ReadDir("/mnt")
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if !e.IsDir() || len(n) != 1 {
			continue
		}
		c := n[0]
		if c < 'a' || c > 'z' {
			continue
		}
		out = append(out, strings.ToUpper(n)+`:\\`)
	}
	return out
}
