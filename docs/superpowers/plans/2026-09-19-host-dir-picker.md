# 挂载本地目录选择器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「新增存储挂载」的本地目录字段可以从已绑定盘符里逐级选择，而不是只能手填绝对路径。

**Architecture:** 后端新增只读的 `GET /foyer/browse`，把宿主机目录映射到容器内绑定根（`<HostMountBase>/<letter>`）后列子目录；前端新增 `DirectoryPicker` 弹窗消费该接口，把选中的宿主机路径回填进现有输入框。回填值经 `HostPathFromContainer` 生成，保证与 `spec.root` 同语义、能被 resync 还原。

**Tech Stack:** Go（标准库 net/http、`path`/`os`）、React 19 + TypeScript、Tailwind v4、vitest（node 环境）。

**Spec:** `docs/superpowers/specs/2026-09-19-host-dir-picker-design.md`

## Global Constraints

- 交互为**单击即进入**：目录列表没有「选中」态，当前所在目录即选中项。
- 不设条目上限：`entries` 返回当前目录全部子目录。
- 保留 `entries[].mtime`（`DirEntry.Info()` 逐项取，可空）。
- **只列目录**，不列文件；**跳过符号链接与 junction**。
- browse **只支持盘符绑定**，允许根是 `HostMountBase`（默认 `/mnt`）；`/host` 不在范围内。
- 越界（`/etc`、`..` 逃逸）必须 400，**不允许**把容器自身文件系统暴露出去。
- 前端 query 一律用 `URLSearchParams` 构造，禁止手工拼串——路径里的 `#` 会被读成 fragment 并截断到父目录。
- 本次**只覆盖新增挂载弹窗**；挂载管理页的编辑入口不做。
- **不改** `deploy/compose.yml` 的端口绑定。
- 前端测试目录约定：`web/vite.config.ts` 的 `test.include` 是 `src/**/*.test.ts`（**不含 `.tsx`**）且 `environment: 'node'`。因此组件本身不做单测，逻辑必须下沉到 `.ts` 纯函数再测。

---

### Task 1: 盘符绑定根可配置

现在 `/mnt` 这个绑定根在 `MapHostPath` 里写死，`DetectHostDrives` 也写死读 `/mnt`。要让 browse 可测（用 `t.TempDir()` 造假盘符）必须把它变成配置项。

**Files:**
- Modify: `server/internal/foyer/config.go`
- Modify: `server/internal/foyer/path.go:13-70`（`MapHostPath`）与 `:90-104`（`DetectHostDrives`）
- Modify: `server/internal/foyer/health.go:31`（`DetectHostDrives()` 调用点）
- Test: `server/internal/foyer/path_test.go`

**Interfaces:**
- Consumes: 无（本任务是基础）
- Produces:
  - `Config.HostMountBase string`，env `FOYER_HOST_MOUNT_BASE`，默认 `/mnt`
  - `hostMountBase(cfg Config) string` — 归一化后的绑定根（无尾斜杠）
  - `hostMountRoot(cfg Config) string` — 归一化后的 `HostMount`（默认 `/host`）
  - `slashTrim(s, def string) string`
  - `underRoot(p, root string) bool`
  - `DetectHostDrives(base string) []string` —— **签名变了**，旧的无参调用点必须一起改

- [ ] **Step 1: 写失败测试**

在 `server/internal/foyer/path_test.go` 追加（并在文件顶部 import 块补 `os`、`path/filepath`）：

```go
func TestDetectHostDrivesUsesConfiguredBase(t *testing.T) {
	mnt := t.TempDir()
	for _, name := range []string{"g", "toolong"} {
		if err := os.MkdirAll(filepath.Join(mnt, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	got := DetectHostDrives(mnt)
	if len(got) != 1 || got[0] != `G:\` {
		t.Fatalf("got %v", got)
	}
	if DetectHostDrives(filepath.Join(mnt, "missing")) != nil {
		t.Fatal("missing base must yield nil")
	}
}

func TestMapHostPathUsesConfiguredBase(t *testing.T) {
	cfg := Config{HostMountBase: t.TempDir()}
	got, err := MapHostPath(cfg, `G:\20260619`)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.ToSlash(cfg.HostMountBase) + "/g/20260619"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestDetectHostDrivesUsesConfiguredBase|TestMapHostPathUsesConfiguredBase' -v`
Expected: 编译失败 `too many arguments in call to DetectHostDrives`

- [ ] **Step 3: 改 config.go**

把结构体里的 `HostMount` 行后面加一个字段：

```go
	HostData        string
	HostMount       string
	HostMountBase   string
	MountsFile      string
```

`LoadConfig` 里在 `HostMount` 之后加：

```go
		HostMount:       envOr("FOYER_HOST_MOUNT", "/host"),
		HostMountBase:   envOr("FOYER_HOST_MOUNT_BASE", "/mnt"),
		MountsFile:      envOr("FOYER_MOUNTS_FILE", "/var/lib/foyer/mounts.json"),
```

- [ ] **Step 4: 改 path.go**

在 `MapHostPath` 之前插入三个 helper：

```go
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
```

把 `MapHostPath` 开头那段替换成用配置根（注意：**只改根，分支顺序不动**，盘符分支仍然抢在 HostData 分支之前）：

```go
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
```

同时删掉这段 `mount` 计算——它已经在上方用 `hostMountBase`/`hostMountRoot` 算好了，留着会 `:=` 重声明报错：

```go
	mount := strings.TrimSuffix(strings.ReplaceAll(cfg.HostMount, "\\", "/"), "/")
	if mount == "" {
		mount = "/host"
	}
```

删完这一段之后，紧接着的代码应该是（`host` 保留）：

```go
	host := strings.TrimSpace(cfg.HostData)
	if host == "" {
		if strings.HasPrefix(s, "/") {
			return path.Clean(s), nil
		}
		return "", fmt.Errorf("use a Windows path like E:\\data or a container path under %s/<drive>", base)
	}
```

`hasDirPrefix` 与后半段（`hostSlash`/`userSlash`/`return mount`）保持不变。

`DetectHostDrives` 改成接受 base：

```go
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
		out = append(out, strings.ToUpper(n)+`:\\`)
	}
	return out
}
```

- [ ] **Step 5: 改 health.go 调用点**

`HealthJSON` 里：

```go
		"host_drives": DetectHostDrives(hostMountBase(cfg)),
```

- [ ] **Step 6: 跑全部 foyer 测试**

Run: `cd server && go test ./internal/foyer/ -v`
Expected: PASS。特别确认 `TestMapHostPathAnyDrive`（期望 `/mnt/d/photos/raw`）、`TestMapHostPathUnderHostData`（期望 `/mnt/e/photos/raw`，盘符分支抢先）、`TestMapHostPathAlreadyContainer` 都仍然通过——`Config{}` 的默认 base 是 `/mnt`，行为不该变。

- [ ] **Step 7: Commit**

```bash
git add server/internal/foyer/config.go server/internal/foyer/path.go server/internal/foyer/health.go server/internal/foyer/path_test.go
git commit -m "feat(foyer): 盘符绑定根改成可配置 HostMountBase"
```

---

### Task 2: `HostPathFromContainer` 反向映射

选择器要回填宿主机形式的路径，必须能把容器路径还原回 `G:\...`。

**Files:**
- Modify: `server/internal/foyer/path.go`（在 `DetectHostDrives` 之后追加）
- Test: `server/internal/foyer/path_test.go`

**Interfaces:**
- Consumes: `hostMountBase`、`underRoot`（Task 1）
- Produces:
  - `HostPathFromContainer(cfg Config, containerPath string) (string, error)`
  - `isASCIILetter(c byte) bool`
  - `toBackslash(p string) string`

- [ ] **Step 1: 写失败测试**

追加到 `server/internal/foyer/path_test.go`：

```go
func TestHostPathFromContainer(t *testing.T) {
	cfg := Config{}
	cases := []struct{ in, want string }{
		{"/mnt/g", `G:\`},
		{"/mnt/g/20260619", `G:\20260619`},
		{"/mnt/g/20260619/#整理完成", `G:\20260619\#整理完成`},
		{"/mnt/d/photos/raw", `D:\photos\raw`},
		{"/mnt/c/Program Files/a", `C:\Program Files\a`},
	}
	for _, c := range cases {
		got, err := HostPathFromContainer(cfg, c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("%s: got %q want %q", c.in, got, c.want)
		}
	}
	// 绑定根自身不是某个盘符目录；非盘符路径一律拒绝。
	for _, bad := range []string{"/mnt", "/etc", "/host", "/mnt/gg/x", ""} {
		if got, err := HostPathFromContainer(cfg, bad); err == nil {
			t.Fatalf("%q should fail, got %q", bad, got)
		}
	}
}

// 回填给前端的路径必须能被 MapHostPath 原样还原，否则 resync 会落到别的目录。
func TestHostPathRoundTrip(t *testing.T) {
	cfg := Config{}
	for _, host := range []string{`G:\`, `G:\20260619`, `G:\20260619\#整理完成`, `D:\photos\raw`, `E:\a b\中 文`} {
		container, err := MapHostPath(cfg, host)
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		back, err := HostPathFromContainer(cfg, container)
		if err != nil {
			t.Fatalf("%s -> %s: %v", host, container, err)
		}
		if back != host {
			t.Fatalf("round trip %q -> %q -> %q", host, container, back)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestHostPathFromContainer|TestHostPathRoundTrip' -v`
Expected: 编译失败 `undefined: HostPathFromContainer`

- [ ] **Step 3: 实现**

追加到 `server/internal/foyer/path.go`（`DetectHostDrives` 之后）：

```go
func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// toBackslash 把容器内的相对路径片段转成 Windows 分隔符。
func toBackslash(p string) string {
	return strings.ReplaceAll(strings.TrimPrefix(p, "/"), "/", "\\")
}

// HostPathFromContainer 把容器内路径还原成宿主机路径（盘符形式），是
// MapHostPath 盘符分支的逆运算。
//
// 只覆盖盘符绑定：MapHostPath 对 G:\... 一律映射到 <HostMountBase>/g/...，
// 所以目录选择器产出的条目都在这个根下。FOYER_HOST_DATA 那套（/host）不做
// 反向映射——它只接非盘符路径，且被盘符分支抢先，硬映射会产出回喂 MapHostPath
// 后落到 /mnt 的静默错误值。
func HostPathFromContainer(cfg Config, containerPath string) (string, error) {
	p := path.Clean("/" + strings.TrimPrefix(filepath.ToSlash(containerPath), "/"))
	base := hostMountBase(cfg)
	if !underRoot(p, base) {
		return "", fmt.Errorf("container path %s is not under %s", containerPath, base)
	}
	rest := ""
	if p != base {
		rest = strings.TrimPrefix(p, base+"/")
	}
	letter, tail, _ := strings.Cut(rest, "/")
	if len(letter) != 1 || !isASCIILetter(letter[0]) {
		return "", fmt.Errorf("%s is not a drive directory", containerPath)
	}
	return strings.ToUpper(letter) + ":\\" + toBackslash(tail), nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && go test ./internal/foyer/ -run 'TestHostPathFromContainer|TestHostPathRoundTrip' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/internal/foyer/path.go server/internal/foyer/path_test.go
git commit -m "feat(foyer): 新增 HostPathFromContainer 反向映射（盘符形式）"
```

---

### Task 3: `Browse` 与 `/foyer/browse` 路由

**Files:**
- Create: `server/internal/foyer/browse.go`
- Create: `server/internal/foyer/browse_test.go`
- Modify: `server/internal/foyer/health.go`（在 `/foyer/stat` 路由之后插入）

**Interfaces:**
- Consumes: `MapHostPath`、`HostPathFromContainer`（Task 2）、`hostMountBase`、`underRoot`、`DetectHostDrives`（Task 1）、`writeJSON`（已在 `health.go`）
- Produces:
  - `type BrowseEntry struct { Name, Path, Mtime string }`（json: `name` / `path` / `mtime,omitempty`）
  - `type BrowseResult struct { OK bool; Path, Parent string; Drives []string; Entries []BrowseEntry }`（json: `ok` / `path` / `parent` / `drives` / `entries`）
  - `Browse(cfg Config, hostPath string) (BrowseResult, error)`
  - 路由 `GET /foyer/browse?path=<宿主机路径>`；`path` 省略 = 盘符列表层级

- [ ] **Step 1: 写失败测试**

创建 `server/internal/foyer/browse_test.go`：

```go
package foyer

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeDriveEnv 造一个假盘符环境：<tmp>/mnt/g 当作 G 盘，返回 cfg 与盘根容器路径。
func fakeDriveEnv(t *testing.T) (Config, string) {
	t.Helper()
	mnt := filepath.ToSlash(filepath.Join(t.TempDir(), "mnt"))
	drive := path.Join(mnt, "g")
	if err := os.MkdirAll(filepath.FromSlash(drive), 0755); err != nil {
		t.Fatal(err)
	}
	return Config{HostMountBase: mnt}, drive
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.FromSlash(p), 0755); err != nil {
		t.Fatal(err)
	}
}

func TestBrowseDriveList(t *testing.T) {
	cfg, _ := fakeDriveEnv(t)
	res, err := Browse(cfg, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "" || res.Parent != "" {
		t.Fatalf("drive list must not carry a path: %+v", res)
	}
	if len(res.Drives) != 1 || res.Drives[0] != `G:\` {
		t.Fatalf("drives %v", res.Drives)
	}
	// 必须是空切片而不是 nil：前端会直接渲染它。
	if res.Entries == nil || len(res.Entries) != 0 {
		t.Fatalf("entries must be an empty slice, got %#v", res.Entries)
	}
}

func TestBrowseListsDirsOnly(t *testing.T) {
	cfg, drive := fakeDriveEnv(t)
	mustMkdir(t, path.Join(drive, "b"))
	mustMkdir(t, path.Join(drive, "A"))
	mustMkdir(t, path.Join(drive, "20260619", "#整理完成"))
	if err := os.WriteFile(filepath.FromSlash(path.Join(drive, "f.txt")), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	res, err := Browse(cfg, `G:\`)
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != `G:\` || res.Parent != "" {
		t.Fatalf("path/parent: %q %q", res.Path, res.Parent)
	}
	names := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		names = append(names, e.Name)
	}
	// 大小写不敏感升序：数字 < 字母；文件 f.txt 不出现。
	if strings.Join(names, ",") != "20260619,A,b" {
		t.Fatalf("names %v", names)
	}
	if res.Entries[2].Path != `G:\b` {
		t.Fatalf("entry path %q", res.Entries[2].Path)
	}
	for _, e := range res.Entries {
		if e.Mtime != "" {
			if _, err := time.Parse(time.RFC3339, e.Mtime); err != nil {
				t.Fatalf("mtime %q: %v", e.Mtime, err)
			}
		}
	}

	sub, err := Browse(cfg, `G:\20260619`)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Path != `G:\20260619` || sub.Parent != `G:\` {
		t.Fatalf("sub path/parent: %q %q", sub.Path, sub.Parent)
	}
	if len(sub.Entries) != 1 || sub.Entries[0].Name != "#整理完成" {
		t.Fatalf("sub entries %+v", sub.Entries)
	}
	if sub.Entries[0].Path != `G:\20260619\#整理完成` {
		t.Fatalf("sub entry path %q", sub.Entries[0].Path)
	}
}

func TestBrowseSkipsSymlink(t *testing.T) {
	cfg, drive := fakeDriveEnv(t)
	outside := filepath.Join(t.TempDir(), "outside")
	mustMkdir(t, filepath.ToSlash(outside))
	if err := os.Symlink(outside, filepath.Join(drive, "link")); err != nil {
		t.Skipf("symlink unsupported here: %v", err)
	}
	res, err := Browse(cfg, `G:\`)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 上目录 symlink 的 IsDir() 是 true，靠显式的 ModeSymlink 检查拦下。
	if len(res.Entries) != 0 {
		t.Fatalf("symlink must be skipped: %+v", res.Entries)
	}
}

func TestBrowseReturnsAllSubdirs(t *testing.T) {
	cfg, drive := fakeDriveEnv(t)
	const n = 60
	for i := 0; i < n; i++ {
		mustMkdir(t, path.Join(drive, fmt.Sprintf("d%02d", i)))
	}
	res, err := Browse(cfg, `G:\`)
	if err != nil {
		t.Fatal(err)
	}
	// 评审决定：不设条目上限，全部返回。
	if len(res.Entries) != n {
		t.Fatalf("got %d entries, want %d", len(res.Entries), n)
	}
	if res.Entries[0].Name != "d00" || res.Entries[n-1].Name != "d59" {
		t.Fatalf("order: %s .. %s", res.Entries[0].Name, res.Entries[n-1].Name)
	}
}

func TestBrowseRejectsEscape(t *testing.T) {
	cfg, _ := fakeDriveEnv(t)
	// 这三个都在允许根检查阶段就被拒，不依赖目标是否存在。
	for _, bad := range []string{"/etc", "/mnt/g/../../etc", "/"} {
		if res, err := Browse(cfg, bad); err == nil {
			t.Fatalf("%q should be rejected, got %+v", bad, res)
		}
	}
	// 未绑定的盘符会映射到绑定根下的空目录。
	if _, err := Browse(cfg, `Z:\nope`); err == nil {
		t.Fatal("unbound drive should fail")
	}
}

func TestBrowseRoute(t *testing.T) {
	cfg, drive := fakeDriveEnv(t)
	mustMkdir(t, path.Join(drive, "20260619"))
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/browse", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var list BrowseResult
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Drives) != 1 || list.Drives[0] != `G:\` {
		t.Fatalf("drives %+v", list.Drives)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/browse?path="+url.QueryEscape(`G:\20260619`), nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var sub BrowseResult
	if err := json.Unmarshal(rr.Body.Bytes(), &sub); err != nil {
		t.Fatal(err)
	}
	if sub.Path != `G:\20260619` || sub.Parent != `G:\` {
		t.Fatalf("path/parent %q %q", sub.Path, sub.Parent)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/browse?path="+url.QueryEscape("/etc"), nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("escape must 400, got %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/browse", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST must 405, got %d", rr.Code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestBrowse' -v`
Expected: 编译失败 `undefined: Browse`

- [ ] **Step 3: 实现 browse.go**

创建 `server/internal/foyer/browse.go`：

```go
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
```

- [ ] **Step 4: 加路由**

在 `server/internal/foyer/health.go` 的 `/foyer/stat` handler 之后、`/foyer/mounts` 之前插入：

```go
	mux.HandleFunc("/foyer/browse", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		res, err := Browse(cfg, r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && go test ./internal/foyer/ -v`
Expected: 全部 PASS（含之前的 `TestHealthJSONAndRoute`、`TestImportDryRunRouteSkipsMountRecord`）

- [ ] **Step 6: Commit**

```bash
git add server/internal/foyer/browse.go server/internal/foyer/browse_test.go server/internal/foyer/health.go
git commit -m "feat(foyer): 新增 GET /foyer/browse 列宿主机子目录"
```

---

### Task 4: 前端 `foyerBrowse` 与路径纯函数

**Files:**
- Modify: `web/src/api/jfs.ts`（追加到文件末尾，`foyerResyncMount` 之后）
- Create: `web/src/utils/hostPath.ts`
- Create: `web/src/utils/hostPath.test.ts`
- Create: `web/src/api/browse.test.ts`

**Interfaces:**
- Consumes: `ApiError`（`web/src/api/errors.ts`，`jfs.ts` 已 import）
- Produces:
  - `foyerBrowse(path?: string): Promise<FoyerBrowseResult>`
  - `type FoyerBrowseEntry = { name: string; path: string; mtime?: string }`
  - `type FoyerBrowseResult = { ok: boolean; path: string; parent: string; drives: string[]; entries: FoyerBrowseEntry[] }`
  - `hostPathSegments(path: string): HostPathSegment[]`
  - `type HostPathSegment = { label: string; value: string }`

- [ ] **Step 1: 写失败测试**

创建 `web/src/utils/hostPath.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { hostPathSegments } from './hostPath';

describe('hostPathSegments', () => {
  it('returns nothing for the drive-list level', () => {
    expect(hostPathSegments('')).toEqual([]);
    expect(hostPathSegments('   ')).toEqual([]);
  });

  it('makes the drive root the first clickable crumb', () => {
    expect(hostPathSegments('G:\\')).toEqual([{ label: 'G:\\', value: 'G:\\' }]);
  });

  it('accumulates each level and keeps # verbatim', () => {
    expect(hostPathSegments('G:\\20260619\\#整理完成')).toEqual([
      { label: 'G:\\', value: 'G:\\' },
      { label: '20260619', value: 'G:\\20260619' },
      { label: '#整理完成', value: 'G:\\20260619\\#整理完成' },
    ]);
  });

  it('tolerates spaces in segment names', () => {
    const got = hostPathSegments('C:\\Program Files\\a');
    expect(got[1]).toEqual({ label: 'Program Files', value: 'C:\\Program Files' });
  });

  it('does not treat a non-drive path as a host path', () => {
    expect(hostPathSegments('/mnt/g/x')).toEqual([]);
  });
});
```

创建 `web/src/api/browse.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foyerBrowse } from './jfs';

function stubFetch(payload: unknown, ok = true): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return {
      ok,
      status: ok ? 200 : 400,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('foyerBrowse', () => {
  it('percent-encodes # so it cannot be read as a fragment', async () => {
    const calls = stubFetch({ ok: true, path: 'G:\\20260619\\#整理完成', entries: [] });
    await foyerBrowse('G:\\20260619\\#整理完成');
    expect(calls[0]).toContain('%23');
    expect(calls[0]).not.toContain('#');
  });

  it('omits the query entirely for the drive-list level', async () => {
    const calls = stubFetch({ ok: true, drives: ['C:\\'] });
    await foyerBrowse();
    expect(calls[0]).toBe('/foyer/browse');
  });

  it('defaults missing collections instead of throwing', async () => {
    stubFetch({ ok: true });
    const res = await foyerBrowse('');
    expect(res.entries).toEqual([]);
    expect(res.drives).toEqual([]);
    expect(res.path).toBe('');
    expect(res.parent).toBe('');
  });

  it('surfaces the server message on failure', async () => {
    stubFetch('path is outside the allowed root', false);
    await expect(foyerBrowse('/etc')).rejects.toThrow(/outside the allowed root/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npm test`
Expected: FAIL — `Failed to resolve import "./hostPath"` 与 `foyerBrowse is not a function`

- [ ] **Step 3: 实现 hostPath.ts**

创建 `web/src/utils/hostPath.ts`：

```ts
export type HostPathSegment = { label: string; value: string };

const DRIVE_RE = /^[A-Za-z]:$/;

/**
 * 把宿主机路径拆成面包屑。首段是盘符根（G:\），后续逐级累加。
 *
 * 盘符列表层级（空串）与非盘符路径都返回空数组——调用方据此不渲染面包屑。
 * 不做任何 URL 编码：这里的值会作为 query 参数交给 URLSearchParams 处理，
 * 手工编码会双重转义。
 */
export function hostPathSegments(path: string): HostPathSegment[] {
  const trimmed = (path || '').trim();
  if (!trimmed) return [];

  const parts = trimmed.replace(/\\+$/, '').split('\\');
  const drive = parts[0];
  if (!DRIVE_RE.test(drive)) return [];

  const out: HostPathSegment[] = [{ label: `${drive}\\`, value: `${drive}\\` }];
  let acc = `${drive}\\`;
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    acc += `${seg}\\`;
    out.push({ label: seg, value: acc.replace(/\\+$/, '') });
  }
  return out;
}
```

- [ ] **Step 4: 实现 foyerBrowse**

追加到 `web/src/api/jfs.ts` 末尾：

```ts
export type FoyerBrowseEntry = {
  name: string;
  path: string;
  mtime?: string;
};

export type FoyerBrowseResult = {
  ok: boolean;
  path: string;
  parent: string;
  drives: string[];
  entries: FoyerBrowseEntry[];
};

/**
 * 列出宿主机目录下的子目录。path 必须是宿主机形式（如 G:\20260619）；
 * 省略表示只要盘符列表。
 *
 * query 绝对不能手工拼：路径里的 # 会被下游读成 fragment 分隔符，导致列到
 * 父目录——这正是之前导入路径被截断成 G:\20260619 的同一个坑。交给
 * URLSearchParams 编码成 %23 后，服务端 URL.Query() 能还原出原值。
 */
export async function foyerBrowse(path?: string): Promise<FoyerBrowseResult> {
  const p = (path || '').trim();
  const qs = new URLSearchParams();
  if (p) qs.set('path', p);
  const q = qs.toString();
  const res = await fetch(`/foyer/browse${q ? `?${q}` : ''}`);
  if (!res.ok) {
    throw new ApiError((await res.text()) || '读取目录失败', res.status);
  }
  const data = (await res.json()) as Partial<FoyerBrowseResult>;
  return {
    ok: data.ok ?? true,
    path: data.path || '',
    parent: data.parent || '',
    drives: data.drives || [],
    entries: data.entries || [],
  };
}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd web && npm test`
Expected: PASS（含既有 `jfs.test.ts`、`mounts.test.ts`、`stat.test.ts`）

Run: `cd web && npm run lint`
Expected: 无输出（`tsc --noEmit` 通过）

- [ ] **Step 6: Commit**

```bash
git add web/src/api/jfs.ts web/src/api/browse.test.ts web/src/utils/hostPath.ts web/src/utils/hostPath.test.ts
git commit -m "feat(web): 新增 foyerBrowse 与宿主机路径面包屑纯函数"
```

---

### Task 5: `DirectoryPicker` 组件

**Files:**
- Create: `web/src/components/DirectoryPicker.tsx`

**Interfaces:**
- Consumes: `foyerBrowse`、`FoyerBrowseEntry`、`FoyerBrowseResult`（Task 4）；`hostPathSegments`（Task 4）
- Produces: `DirectoryPicker` React 组件，props 为
  `{ open: boolean; initialPath?: string; onSelect: (hostPath: string) => void; onClose: () => void }`

> 该组件不做单测：`web/vite.config.ts` 的 `test.include` 只匹配 `src/**/*.test.ts` 且 `environment: 'node'`，没有 DOM。可测逻辑已下沉到 Task 4 的纯函数。

- [ ] **Step 1: 实现组件**

创建 `web/src/components/DirectoryPicker.tsx`：

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { X, Folder, HardDrive, ArrowUp, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
import { foyerBrowse, FoyerBrowseEntry, FoyerBrowseResult } from '../api/jfs';
import { hostPathSegments } from '../utils/hostPath';

type Props = {
  open: boolean;
  initialPath?: string;
  onSelect: (hostPath: string) => void;
  onClose: () => void;
};

export const DirectoryPicker: React.FC<Props> = ({ open, initialPath, onSelect, onClose }) => {
  const [path, setPath] = useState('');
  const [data, setData] = useState<FoyerBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (target: string): Promise<boolean> => {
    setLoading(true);
    setError('');
    try {
      const res = await foyerBrowse(target);
      setData(res);
      setPath(res.path);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取目录失败');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const start = (initialPath || '').trim();
    if (!start) {
      void load('');
      return;
    }
    // 输入框里的路径可能已失效或越界；退回盘符列表，而不是卡在错误上。
    void (async () => {
      if (!(await load(start))) await load('');
    })();
  }, [open, initialPath, load]);

  if (!open) return null;

  const crumbs = hostPathSegments(path);
  const entries: FoyerBrowseEntry[] = data?.entries || [];
  const drives = data?.drives || [];
  const currentDrive = drives.find(d => path.toUpperCase().startsWith(d.toUpperCase()));

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-[60] animate-in fade-in duration-150 font-sans">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg overflow-hidden shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">选择宿主机目录</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav：盘符列表层级没有路径可拆，面包屑整个不出现 */}
        {path && (
          <div className="px-4 py-2 border-b border-slate-200 bg-white space-y-2">
            <div className="flex flex-wrap items-center gap-1">
              {drives.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => void load(d)}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border transition-colors ${
                    currentDrive === d
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-bold'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => void load(data?.parent || '')}
                className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                title="上级目录"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <div className="flex items-center gap-0.5 flex-wrap font-mono text-slate-600">
                {crumbs.map((c, i) => (
                  <span key={c.value} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300" />}
                    <button
                      type="button"
                      onClick={() => void load(c.value)}
                      className="hover:text-indigo-600 hover:underline"
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2 min-h-48">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>读取中…</span>
            </div>
          )}

          {!loading && error && (
            <div className="m-2 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && !path && (
            <div>
              <p className="px-2 py-1.5 text-[11px] text-slate-400">选择要挂载的磁盘：</p>
              {drives.length === 0 && (
                <p className="px-2 py-3 text-xs text-amber-700">
                  没有检测到已绑定的盘符，请用 scripts/run-foyer.ps1 重建容器。
                </p>
              )}
              {drives.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => void load(d)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-800"
                >
                  <HardDrive className="w-4 h-4 text-slate-400" />
                  <span className="font-mono">{d}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && path && (
            <div>
              {entries.length === 0 && (
                <p className="px-2 py-3 text-xs text-slate-400">该目录下没有子目录。</p>
              )}
              {entries.map(e => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => void load(e.path)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-800"
                >
                  <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50/50 space-y-2">
          <div className="text-[11px] font-mono text-slate-500 truncate" title={path}>
            {path || '（未选择盘符）'}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!path || loading}
              onClick={() => onSelect(path)}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
            >
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npm run lint`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add web/src/components/DirectoryPicker.tsx
git commit -m "feat(web): 新增宿主机目录选择器组件"
```

---

### Task 6: 接进新增挂载弹窗

保留手填，只加一个「浏览…」按钮与回填。**不要**动表单其余逻辑。

**Files:**
- Modify: `web/src/components/NewMountModal.tsx`（import 段、state 段、`useEffect` 段、local 目录输入块、根节点末尾）

**Interfaces:**
- Consumes: `DirectoryPicker`（Task 5）
- Produces: 无对外接口（终端功能）

- [ ] **Step 1: 加 import**

`lucide-react` 的 import 列表里加 `FolderOpen`：

```tsx
import {
  X,
  HardDrive,
  Cloud,
  Server,
  Plus,
  Info,
  ShieldAlert,
  FileCheck,
  FolderOpen,
  Loader2
} from 'lucide-react';
```

并在 `foyerHealth` 那行之后加：

```tsx
import { DirectoryPicker } from './DirectoryPicker';
```

- [ ] **Step 2: 加 state 与关闭时机**

在 `const [hostHint, setHostHint] = useState<...>({});` 之后加：

```tsx
  const [isPickerOpen, setIsPickerOpen] = useState(false);
```

在 `useEffect` 的 `if (!isNewMountOpen) return;` 之后加一行，保证弹窗重开时不会残留上次的选择器：

```tsx
    setIsPickerOpen(false);
```

- [ ] **Step 3: 输入框加「浏览…」**

把 local 分支里的「宿主机目录」那个 `<div>` 整体替换成：

```tsx
              <div>
                <label className="text-[11px] text-slate-600">宿主机目录:</label>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <input
                    type="text"
                    required
                    placeholder="E:\data\photos"
                    value={localRoot}
                    onChange={e => { setLocalRoot(e.target.value); setPreview(null); }}
                    className="flex-1 bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setIsPickerOpen(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-white hover:bg-slate-50 text-slate-700 font-medium shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-indigo-600" />
                    <span>浏览…</span>
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  填本机绝对路径，或点「浏览…」从已绑定盘符里逐级选。启动时会把本机已有盘符绑进容器
                  {hostHint.host_drives && hostHint.host_drives.length
                    ? `（当前：${hostHint.host_drives.join(' ')}）`
                    : '；若列表为空请用 scripts/run-foyer.ps1 重建'}
                  。
                </p>
              </div>
```

> `type="button"` 是必须的：这个按钮在 `<form>` 里，默认 `type="submit"` 会直接提交表单。

- [ ] **Step 4: 挂载选择器**

在 `return` 的最外层 overlay `<div>` 里，把 `DirectoryPicker` 作为内层白色卡片 `<div>` 的**兄弟节点**放在其后：

```tsx
        </form>
      </div>

      <DirectoryPicker
        open={isPickerOpen}
        initialPath={localRoot}
        onSelect={p => {
          setLocalRoot(p);
          setPreview(null); // 路径变了，旧预检结果作废
          setIsPickerOpen(false);
        }}
        onClose={() => setIsPickerOpen(false)}
      />
    </div>
  );
};
```

- [ ] **Step 5: 类型检查与前端测试**

Run: `cd web && npm run lint`
Expected: 无输出

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 6: 手工验证**

启动 `scripts/run-foyer.ps1` 与 `scripts/run-web.ps1`，打开 Web 控制台 →「添加新挂载源」→ 选 `Local / NAS` → 点「浏览…」，逐项确认：

1. 默认落在盘符列表，列出 `/foyer/health` 里 `host_drives` 报的同一批盘符。
2. 点盘符 → 列出该盘根的子目录，**只列目录**，没有文件。
3. 单击子目录即进入；面包屑与「↑ 上级」都能回跳；到盘符根时「↑ 上级」回到盘符列表。
4. 进到含 `#` 的目录（如 `G:\20260619\#整理完成`），底部路径显示完整，**没有被截断成父目录**。
5. 点「选择此目录」→ 输入框回填 `G:\20260619\#整理完成`，选择器关闭，旧预检结果被清空。
6. 点「预检并导入」→ 预检结果里的对象路径位于 `#整理完成` 之下，而不是 `20260619` 之下。

- [ ] **Step 7: Commit**

```bash
git add web/src/components/NewMountModal.tsx
git commit -m "feat(web): 新增挂载弹窗接入目录选择器"
```

---

## 已知遗留

- 选择器只覆盖新增挂载弹窗；挂载管理页的编辑/重设来源目录入口未做。
- `deploy/compose.yml` 的 `8092:8092` 仍对外可达，`/foyer/browse` 会暴露绑定盘符内的目录名。与既有 `/foyer/import` 的信任模型一致，本次刻意不改。
- `entries[].mtime` 会逐项 `Info()`，在 Docker Desktop 的盘符绑定挂载上大目录会变慢。这是评审时明确接受的取舍。
