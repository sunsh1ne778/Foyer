package foyer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
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
	// Go ≥ 1.23 在 Windows 上目录 symlink/junction 在 os.ReadDir 里 IsDir()==false
	// （junction 报 ModeIrregular，不带 ModeSymlink），实际由 !e.IsDir() 拦下。
	if len(res.Entries) != 0 {
		t.Fatalf("symlink must be skipped: %+v", res.Entries)
	}
}

// 中间路径段是链接时，词法前缀检查与最后一段 Lstat 都拦不住，必须靠解析
// 真实路径后的包含性校验。Windows 上 os.Symlink 需要特权，这里会 skip；
// Linux CI 上会真正执行。
func TestBrowseRejectsSymlinkEscape(t *testing.T) {
	cfg, drive := fakeDriveEnv(t)
	outside := filepath.Join(t.TempDir(), "outside")
	mustMkdir(t, filepath.ToSlash(outside))
	mustMkdir(t, filepath.Join(outside, "sub"))
	if err := os.Symlink(outside, filepath.Join(drive, "link")); err != nil {
		t.Skipf("symlink unsupported here: %v", err)
	}
	// 链接本身必须被拒（Lstat 最后一段检查）。
	if res, err := Browse(cfg, `G:\link`); err == nil {
		t.Fatalf("symlink itself must be rejected, got %+v", res)
	}
	// 穿过链接的子路径词法上仍在根内，但真实路径在根外，必须被拒。
	if res, err := Browse(cfg, `G:\link\sub`); err == nil {
		t.Fatalf("path traversing a symlink out of the root must be rejected, got %+v", res)
	}
}

// Windows 上 os.Symlink 需要特权，但 junction（mklink /J）不需要。这里用 junction
// 复现 TestBrowseRejectsSymlinkEscape 的两个断言，补上该防护在 Windows 上没有
// 可执行回归测试的空白。Linux 上另有 os.Symlink 版本真正执行。
func TestBrowseRejectsJunctionEscapeWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skipf("junction test only applies to windows (GOOS=%s)", runtime.GOOS)
	}
	cfg, drive := fakeDriveEnv(t)
	outside := filepath.Join(t.TempDir(), "outside")
	mustMkdir(t, filepath.ToSlash(outside))
	mustMkdir(t, filepath.Join(outside, "sub"))
	link := filepath.Join(drive, "link")

	// mklink 是 cmd 内建：成功时退出码 0、信息写 stdout；失败时退出码非 0、信息写
	// stderr。退出码与 stderr 都必须检查，否则 cmd 不可用或卷不支持 junction 时会
	// 误以为是防护生效。两者任一异常就 skip，绝不假装通过。
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, outside)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil || stderr.Len() > 0 {
		t.Skipf("mklink /J unavailable: err=%v stderr=%q", err, strings.TrimSpace(stderr.String()))
	}

	// 确认 junction 真的建起来并解析到根外：否则下面两个断言会因"路径不存在"
	// 而虚假通过，测试就失去意义。
	if _, err := os.Stat(filepath.Join(link, "sub")); err != nil {
		t.Skipf("junction not resolvable, cannot exercise the guard: %v", err)
	}

	// 链接本身必须被拒（Windows 上 junction 的 Lstat 不带 ModeSymlink，实际由
	// IsDir() / 解析真实路径后的包含性校验拦下，但断言与符号链接版本完全一致）。
	if res, err := Browse(cfg, `G:\link`); err == nil {
		t.Fatalf("junction itself must be rejected, got %+v", res)
	}
	// 穿过 junction 的子路径词法上仍在根内，但真实路径在根外，必须被拒。
	if res, err := Browse(cfg, `G:\link\sub`); err == nil {
		t.Fatalf("path traversing a junction out of the root must be rejected, got %+v", res)
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
	// Z 未绑定：MapHostPath 仍把它映射到 <base>/z/nope，但该目录不存在，所以报错。
	// 这里断言的是"绑定根下未知盘符路径不存在"，不是"映射到空目录"。
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

	// 「不存在」是请求路径的属性，归客户端错误：400。
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/browse?path="+url.QueryEscape(`Z:\nope`), nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing directory must 400, got %d body %s", rr.Code, rr.Body.String())
	}

	// 非 ErrBrowseBadPath 的错误必须 500，而不是被压成 400。这里用绑定根下
	// 反向映射失败的路径触发（与 os.ReadDir/权限失败走同一分支）。
	base := hostMountBase(cfg)
	mustMkdir(t, path.Join(base, "zz"))
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/browse?path="+url.QueryEscape(base+"/zz"), nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("internal error must 500, got %d body %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/browse", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST must 405, got %d", rr.Code)
	}
	if allow := rr.Header().Get("Allow"); allow != "GET" {
		t.Fatalf("405 must carry Allow: GET, got %q", allow)
	}
}
