package foyer

import (
	"fmt"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

// BrowseEntry 是目录选择器里的一行子目录。
type BrowseEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Mtime string `json:"mtime,omitempty"`
}

// BrowseResult 是 GET /foyer/browse 的响应。
type BrowseResult struct {
	OK      bool          `json:"ok"`
	Path    string        `json:"path"`
	Parent  string        `json:"parent"`
	Drives  []string      `json:"drives"`
	Entries []BrowseEntry `json:"entries"`
}

// Browse 列出宿主机目录下的子目录，供 Web 端目录选择器使用。
//
// hostPath 为空表示"盘符列表"层级：只回盘符，path/parent 均为空串。
// hostPath 形如 `G:\20260619\#整理完成`，与挂载 spec.root 同语义。
func Browse(cfg Config, hostPath string) (BrowseResult, error) {
	base := hostMountBase(cfg)
	res := BrowseResult{OK: true, Drives: DetectHostDrives(base), Entries: []BrowseEntry{}}
	if res.Drives == nil {
		res.Drives = []string{}
	}

	hostPath = strings.TrimSpace(hostPath)
	if hostPath == "" {
		return res, nil
	}

	container, err := MapHostPath(cfg, hostPath)
	if err != nil {
		return BrowseResult{}, err
	}
	container = path.Clean(container)

	// 越界防护不是可选的加固：MapHostPath 对 "/etc" 这类绝对路径会原样放行
	// （HostData 为空时走 `if strings.HasPrefix(s, "/")` 分支），只能在这里拦。
	if !underRoot(container, base) {
		return BrowseResult{}, fmt.Errorf("path is outside the allowed root (%s)", base)
	}

	fi, err := os.Lstat(container)
	if err != nil {
		if os.IsNotExist(err) {
			return BrowseResult{}, fmt.Errorf("no such directory: %s", hostPath)
		}
		return BrowseResult{}, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return BrowseResult{}, fmt.Errorf("refusing to follow symlink: %s", hostPath)
	}
	if !fi.IsDir() {
		return BrowseResult{}, fmt.Errorf("not a directory: %s", hostPath)
	}

	res.Path, err = HostPathFromContainer(cfg, container)
	if err != nil {
		return BrowseResult{}, err
	}
	// 盘符根的上级是"盘符列表"而不是某个目录：此时 HostPathFromContainer 会
	// 拒绝绑定根自身，Parent 保持空串，正是前端要的信号。
	if parent, perr := HostPathFromContainer(cfg, path.Dir(container)); perr == nil {
		res.Parent = parent
	}

	ents, err := os.ReadDir(container)
	if err != nil {
		return BrowseResult{}, err
	}
	for _, e := range ents {
		// 只列目录；符号链接一律跳过——它可能指向允许根之外，跟随会让
		// "限定在已绑定盘符内"的约束失效。Windows 上目录 symlink 的 IsDir()
		// 仍为 true，所以 ModeSymlink 检查必须显式写出来。
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		hp, herr := HostPathFromContainer(cfg, path.Join(container, e.Name()))
		if herr != nil {
			continue
		}
		item := BrowseEntry{Name: e.Name(), Path: hp}
		if info, ierr := e.Info(); ierr == nil {
			item.Mtime = info.ModTime().UTC().Format(time.RFC3339)
		}
		res.Entries = append(res.Entries, item)
	}
	// 大小写不敏感升序，保证同一目录重复请求结果一致。
	sort.SliceStable(res.Entries, func(i, j int) bool {
		return strings.ToLower(res.Entries[i].Name) < strings.ToLower(res.Entries[j].Name)
	})
	return res, nil
}
