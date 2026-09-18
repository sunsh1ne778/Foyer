package pathx

import (
	"fmt"
	"path"
	"strings"
)

type Ref struct {
	Mount string
	Path  string
}

func Parse(s string) (Ref, error) {
	s = strings.TrimSpace(s)
	mount, rest, ok := strings.Cut(s, ":")
	if !ok || mount == "" {
		return Ref{}, fmt.Errorf("path: want mount:path, got %q", s)
	}
	if strings.ContainsAny(mount, `/\`) {
		return Ref{}, fmt.Errorf("path: invalid mount %q", mount)
	}
	p := rest
	if p == "" {
		p = "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	cleaned := path.Clean(p)
	if cleaned == "." {
		cleaned = "/"
	}
	if strings.HasPrefix(cleaned, "..") || strings.Contains(cleaned, "/../") {
		return Ref{}, fmt.Errorf("path: escapes root: %q", s)
	}
	return Ref{Mount: mount, Path: cleaned}, nil
}

func (r Ref) String() string {
	p := r.Path
	if p == "" {
		p = "/"
	}
	return r.Mount + ":" + p
}

func (r Ref) Key() string {
	return strings.TrimPrefix(r.Path, "/")
}

func Join(dir, name string) string {
	dir = strings.Trim(dir, "/")
	name = strings.Trim(name, "/")
	if dir == "" {
		return name
	}
	if name == "" {
		return dir
	}
	return dir + "/" + name
}

func Parent(key string) string {
	key = strings.Trim(key, "/")
	i := strings.LastIndex(key, "/")
	if i < 0 {
		return ""
	}
	return key[:i]
}

func Base(key string) string {
	key = strings.Trim(key, "/")
	if key == "" {
		return ""
	}
	i := strings.LastIndex(key, "/")
	if i < 0 {
		return key
	}
	return key[i+1:]
}
