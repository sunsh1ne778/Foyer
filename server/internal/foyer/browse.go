package foyer

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ErrBrowseBadPath 标记由客户端请求内容导致的错误（越界、非目录、拒绝跟随链接、
// 解析后逃逸绑定根、路径不存在、宿主路径无法映射）。HTTP 层据此区分 400 与 500：
// 只有 errors.Is(err, ErrBrowseBadPath) 才是客户端错误，其余（如 os.ReadDir/权限
// 失败）是服务端错误。
var ErrBrowseBadPath = errors.New("browse: invalid path")

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
		// 映射失败来自客户端给的路径本身（形态不对、不在 FOYER_HOST_DATA 下），
		// 不是服务端故障；保持与改动前一致的 400，不能落到 500。
		return BrowseResult{}, fmt.Errorf("%w: %v", ErrBrowseBadPath, err)
	}
	container = path.Clean(container)

	// 越界防护不是可选的加固：MapHostPath 对 "/etc" 这类绝对路径会原样放行
	// （HostData 为空时走 `if strings.HasPrefix(s, "/")` 分支），只能在这里拦。
	// 两侧都过 containerStyle：base 由 env 配置，可能是 `//mnt`、`/mnt/.` 这类
	// 未归一化的形状；container 在 Windows 上则可能没有前导斜杠。
	if !underRoot(containerStyle(container), containerStyle(base)) {
		return BrowseResult{}, fmt.Errorf("%w: path is outside the allowed root (%s)", ErrBrowseBadPath, base)
	}

	fi, err := os.Lstat(container)
	if err != nil {
		if os.IsNotExist(err) {
			// 目标不存在是请求路径的属性（请求了一个不存在的目录），按客户端错误处理。
			return BrowseResult{}, fmt.Errorf("%w: no such directory: %s", ErrBrowseBadPath, hostPath)
		}
		return BrowseResult{}, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return BrowseResult{}, fmt.Errorf("%w: refusing to follow symlink: %s", ErrBrowseBadPath, hostPath)
	}
	if !fi.IsDir() {
		return BrowseResult{}, fmt.Errorf("%w: not a directory: %s", ErrBrowseBadPath, hostPath)
	}

	// 上面两步都不够：词法前缀比较只看字符串，Lstat 只对最后一段生效。若中间
	// 路径段是指向根外的符号链接/junction，`G:\link\sub` 映射后词法仍在根内，
	// 而 Lstat/ReadDir 会跟随中间段读到盘符之外。解析真实路径后再校验一次包含性。
	realContainer, err := filepath.EvalSymlinks(filepath.FromSlash(container))
	if err != nil {
		return BrowseResult{}, fmt.Errorf("cannot resolve real path of %s: %w", hostPath, err)
	}
	realBase, err := filepath.EvalSymlinks(filepath.FromSlash(base))
	if err != nil {
		return BrowseResult{}, fmt.Errorf("cannot resolve allowed root %s: %w", base, err)
	}
	if !underRoot(containerStyle(realContainer), containerStyle(realBase)) {
		return BrowseResult{}, fmt.Errorf("%w: path escapes the allowed root (%s): %s", ErrBrowseBadPath, base, hostPath)
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
		// 只列目录，不列文件；符号链接/junction 一律跳过——它可能指向允许根
		// 之外，跟随会让"限定在已绑定盘符内"的约束失效。
		// Go ≥ 1.23 在 Windows 上目录 symlink 与 junction 都报 IsDir()==false
		// （junction 报 ModeIrregular，且不带 ModeSymlink），所以这里实际起作用
		// 的是 !e.IsDir()；ModeSymlink 分支只是纵深防御，不依赖平台行为。
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
