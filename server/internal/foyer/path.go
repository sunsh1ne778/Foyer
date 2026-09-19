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

// slashTrim 归一化配置里的路径：反斜杠转正斜杠、去掉尾部斜杠；空值回退到 def。
func slashTrim(s, def string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		s = def
	}
	return strings.TrimSuffix(strings.ReplaceAll(s, "\\", "/"), "/")
}

// hostMountBase 是盘符在容器内的绑定根，默认 /mnt。
// 生产由 scripts/gen-host-drives.ps1 生成 "G:/:/mnt/g" 这样的绑定。
func hostMountBase(cfg Config) string { return slashTrim(cfg.HostMountBase, "/mnt") }

// hostMountRoot 是 FOYER_HOST_DATA 在容器内的挂载点，默认 /host。
func hostMountRoot(cfg Config) string { return slashTrim(cfg.HostMount, "/host") }

// underRoot 判断 p 是否等于 root 或位于 root 之下。两侧都必须是已 Clean 的斜杠路径。
func underRoot(p, root string) bool {
	if root == "" {
		return false
	}
	return p == root || strings.HasPrefix(p, root+"/")
}

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
	base := hostMountBase(cfg)
	mount := hostMountRoot(cfg)
	if cleaned := path.Clean(s); underRoot(cleaned, base) || underRoot(cleaned, mount) {
		return cleaned, nil
	}
	if len(s) >= 2 && unicode.IsLetter(rune(s[0])) && s[1] == ':' {
		letter := strings.ToLower(s[:1])
		rest := strings.TrimPrefix(s[2:], "/")
		if rest == "" {
			return path.Clean(base + "/" + letter), nil
		}
		return path.Clean(base + "/" + letter + "/" + rest), nil
	}
	host := strings.TrimSpace(cfg.HostData)
	if host == "" {
		if strings.HasPrefix(s, "/") {
			return path.Clean(s), nil
		}
		return "", fmt.Errorf("use a Windows path like E:\\data or a container path under %s/<drive>", base)
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

// DetectHostDrives 列出已绑定进容器的盘符，形如 "C:\\"。base 为绑定根（生产是 /mnt）。
func DetectHostDrives(base string) []string {
	if base == "" {
		base = "/mnt"
	}
	ents, err := os.ReadDir(base)
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
		out = append(out, strings.ToUpper(n)+`:\`)
	}
	return out
}
