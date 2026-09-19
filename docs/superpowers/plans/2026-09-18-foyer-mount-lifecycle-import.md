# 挂载生命周期 + 导入闭环（第二期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 能安全地管理「仅导入元数据」挂载的完整生命周期——导入前预检、导入后拿到真实计数、可增量重导、可改名/停用/删除——并把 overlay 已实现但被丢弃的 `import` 信息通过结构化输出接回控制台；同时让导入**尽量沿用源对象的原始元数据**（mtime、mode、属主），而不是把它们统一压成"导入时刻 + 0444"。

**Architecture:** 三处改动，`overlays/juicefs/cmd/import.go` 增加 `--json` 机器可读摘要（不新增 HTTP 通道，仍由 `foyer` 进程 `exec` 调用）与源元数据保真逻辑；`server/internal/foyer` 把导入结果解析成 `ImportResult`，并在管理面补齐 `DELETE/PATCH /foyer/mounts/{id}` 与 `POST /foyer/mounts/{id}/resync`；`web/src` 把挂载列表合并逻辑下沉到可单测的纯函数模块，UI 增加只读徽标、删除、增量同步、「预检 → 确认」两步导入，并显示元数据保真度。

**Tech Stack:** Go 1.23（stdlib `net/http`，不引入 JuiceFS 依赖）、urfave/cli v2（overlay 侧）、React 18 + Vite + vitest（node 环境，纯函数单测）。

## Global Constraints

- 不把 JuiceFS 源码 import 进 `filestore` 模块：`server/go.mod` 不得新增 `github.com/juicedata/juicefs`；foyer 只通过 `exec` 调用 `juicefs` 二进制。
- overlay 源文件只在 `overlays/juicefs/` 维护，通过 `scripts/apply-juicefs-overlay.ps1`（Windows）或 `scripts/apply-juicefs-overlay.sh` 覆盖到 `third_party/juicefs`；不要直接编辑 submodule 内的文件。
- 导入是元数据模式：文件内容只读（`meta.FlagImmutable`，见 `pkg/meta/tkv.go:2017` 的写入保护），删除只删元数据，**不搬数据**。所有新增 UI 文案必须如实表达这点，禁止暗示「复制入库」。
- 文件 mode 沿用源权限但**必须去掉写位**（`Perm() &^ 0222`）：`FlagImmutable` 已经让写入必然失败，若还显示 0644，工具会先通过 `access(W_OK)` 检查再拿到 EPERM，错误信息自相矛盾。只保留读/执行位，「可执行」这一真正影响行为的信息不会丢。内容只读由 flag 保证，与 mode 无关，因此可以放心沿用源文件的 mode。
- **元数据保真优先**：导入时凡源能提供的元数据都要尽力保留（mtime 含纳秒、mode、属主/属组、目录 mtime），拿不到才回退到默认值。当前 overlay 用 `_ = m.SetAttr(...)` 吞掉错误，必须改为显式处理并计入回执。
- 保真的写入顺序不可交换：`SetAttrMtime` 必须在 `SetAttrFlag(FlagImmutable)` **之前**，否则会被 immutable 挡住。
- 不得为保真引入新的第三方依赖：属主/属组解析用 JuiceFS 自带的 `pkg/utils.LookupUser` / `LookupGroup`。
- 删除挂载记录 = 只从 `mounts.json` 移除目录项，**不删除 JuiceFS 中已导入的文件，也不清理对象存储**。因为清理由挂载点上的 `rmr`/`gc` 负责，网关模式下不可用。
- `/foyer/health` 保持无鉴权。本期**不引入鉴权**，因此新增端点必须是不破坏数据的操作；`gc`/`fsck`/`restore` 等危险动词留到鉴权完成之后。
- 端口与凭据沿用现状：S3 网关 host `19002`（容器 `9002`），foyer 管理面 host `8092`，网关凭据 `foyerak` / `foyersecret`。
- Web 数据面继续直连 S3 网关（`web/src/api/jfs.ts`），控制面走 Vite 代理 `/foyer` → `127.0.0.1:8092`。
- Web 测试跑 `web/` 下 `npm test`（vitest），`test.include` 为 `src/**/*.test.ts`，`environment: node`——**没有 DOM**，因此新增逻辑必须先落成纯函数才能测。
- Go 测试命令固定为 `cd server; go test ./internal/foyer -count=1`。
- 本仓库当前约定：**未获用户明确要求不提交**。因此每个任务末尾的 commit 步骤标为可选，默认不执行。

---

## 文件结构

| 路径 | 职责 | 动作 |
|------|------|------|
| `overlays/juicefs/cmd/import.go` | 导入命令；`--json` 摘要、源元数据保真（mtime/mode/属主/目录 mtime）、`--dir-mtime` 开关 | 修改 |
| `overlays/juicefs/cmd/import_test.go` | 保真推导与路径映射的纯函数单测（随 overlay 一起拷贝） | 新建 |
| `scripts/apply-juicefs-overlay.ps1` | 增加 `cmd\import_test.go` 拷贝 | 修改 |
| `scripts/apply-juicefs-overlay.sh` | 增加 `cmd/import_test.go` 拷贝 | 修改 |
| `server/internal/foyer/import.go` | `ImportResult` 类型、`ImportArgs`、`parseImportSummary` 纯函数；Task 6 追加保真计数字段 | 新建 |
| `server/internal/foyer/import_test.go` | 摘要解析与 argv 单测 | 新建 |
| `server/internal/foyer/exec.go` | `Runner.Import` 改为返回结构化结果；移除旧 `ImportArgs` | 修改 |
| `server/internal/foyer/exec_test.go` | 跟随签名变更，新增导入成功/失败用例 | 修改 |
| `server/internal/foyer/mounts.go` | `mountStore` 增加 `get` / `update` | 修改 |
| `server/internal/foyer/mounts_test.go` | store 读改单测 | 新建 |
| `server/internal/foyer/health.go` | `/foyer/import` 支持 `dry_run`；新增 `DELETE/PATCH /foyer/mounts/{id}`、`POST /foyer/mounts/{id}/resync`；`writeJSON` 辅助 | 修改 |
| `server/internal/foyer/health_test.go` | 生命周期路由 + 预检路由单测 | 修改 |
| `web/src/api/jfs.ts` | `foyerImport` 支持 `dry_run`、新增 `foyerDeleteMount` / `foyerPatchMount` / `foyerResyncMount` | 修改 |
| `web/src/api/mounts.ts` | 纯函数：内置卷挂载合并、是否元数据导入 | 新建 |
| `web/src/api/mounts.test.ts` | 合并与只读判定单测 | 新建 |
| `web/src/api/client.ts` | 去掉 `deleteMount`/`patchMount`/`unmount` 的 501，新增 `previewLocalImport` / `resyncMount` | 修改 |
| `web/src/context/FileStoreContext.tsx` | 暴露 `previewLocalImport`、`resyncMount` | 修改 |
| `web/src/components/MountManager.tsx` | 只读徽标、删除、增量同步 | 修改 |
| `web/src/components/NewMountModal.tsx` | 「预检 → 确认」两步导入 | 修改 |

任务顺序：1 → 2 是 Go 侧（2 依赖 1 的 `ImportResult`），3 → 4 → 5 是 Web 侧（4、5 依赖 3），6 收口元数据保真（依赖 1 的 `--json` 摘要与 3 的前端类型）。

---

### Task 1: 导入预检与结构化计数（overlay + foyer）

**Files:**
- Modify: `overlays/juicefs/cmd/import.go`
- Create: `server/internal/foyer/import.go`
- Create: `server/internal/foyer/import_test.go`
- Modify: `server/internal/foyer/exec.go:29-81`
- Modify: `server/internal/foyer/exec_test.go`
- Modify: `server/internal/foyer/health.go:39-42`（`importRequest`）、`health.go:70-134`（handler）
- Modify: `server/internal/foyer/health_test.go`

**Interfaces:**
- Produces（供 Task 2 使用）:

```go
type ImportResult struct {
	DryRun   bool     `json:"dry_run"`
	Dest     string   `json:"dest"`
	Scanned  int      `json:"scanned"`
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Objects  []string `json:"objects,omitempty"`
}

func ImportArgs(cfg Config, src, dest string, dryRun bool) []string
func parseImportSummary(text string) (ImportResult, error)
func (r Runner) Import(cfg Config, src, dest string, dryRun bool) (ImportResult, error)
```

`ImportArgs` 产出（`dryRun=true` 时多一个 `--dry-run`）：

```text
import --json [--dry-run] {MetaURL} {src} {dest}
```

---

- [ ] **Step 1: 先写 overlay 侧失败的期望——新增 `--json` 摘要**

编辑 `overlays/juicefs/cmd/import.go`。给 `cmdImport()` 的 `Flags` 追加：

```go
			&cli.BoolFlag{
				Name:  "dry-run",
				Usage: "list objects that would be imported",
			},
			&cli.BoolFlag{
				Name:  "json",
				Usage: "print a single JSON summary instead of plain text",
			},
```

在文件顶部 `import` 块中确认已导入 `encoding/json`（现有代码已导入，无需改动）。

在 `cmdImport` 之前新增摘要类型与采样上限：

```go
// importSummary is the machine-readable form of one import run.
// Scanned counts candidate objects (directories and internal keys excluded).
type importSummary struct {
	DryRun   bool     `json:"dry_run"`
	Dest     string   `json:"dest"`
	Scanned  int      `json:"scanned"`
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Objects  []string `json:"objects,omitempty"`
}

// importSampleLimit caps how many keys a dry-run hands back to the caller.
const importSampleLimit = 50
```

- [ ] **Step 2: 改造 `importObjects` 收集计数**

把 `importObjects` 从 `ctx := meta.Background()` 起的统计与循环段替换为下面内容（`metaURL`/`src`/`dest`/`store`/`spec`/`skipVolume` 等前置逻辑保持不变）：

```go
	ctx := meta.Background()
	summary := importSummary{DryRun: c.Bool("dry-run"), Dest: dest}
	sample := make([]string, 0, importSampleLimit)
	asJSON := c.Bool("json")
	ch, err := object.ListAllWithDelimiter(store, "", "", "", true)
	if err != nil {
		return fmt.Errorf("list source: %w", err)
	}
	for obj := range ch {
		if obj == nil {
			continue
		}
		if obj.IsDir() || vfs.SkipInternalKey(obj.Key(), skipVolume) {
			continue
		}
		summary.Scanned++
		jp := vfs.JoinImportPath(dest, obj.Key())
		if summary.DryRun {
			if len(sample) < importSampleLimit {
				sample = append(sample, obj.Key())
			}
			if !asJSON {
				fmt.Println(obj.Key(), "->", jp)
			}
			continue
		}
		st := importOne(m, ctx, jp, obj, blobJSON)
		switch st {
		case 0:
			summary.Imported++
		case syscall.EEXIST:
			summary.Skipped++
		default:
			return fmt.Errorf("import %s: %s", jp, st)
		}
	}
	summary.Objects = sample
	if asJSON {
		b, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		fmt.Println(string(b))
		return nil
	}
	if summary.DryRun {
		fmt.Printf("would import %d objects into %s\n", summary.Scanned, dest)
		return nil
	}
	fmt.Printf("imported %d, skipped %d, scanned %d -> %s\n", summary.Imported, summary.Skipped, summary.Scanned, dest)
	return nil
}
```

注意：`json.Marshal`（不是 `MarshalIndent`）保证摘要是**单行**，便于 foyer 逐行解析。

- [ ] **Step 3: 应用 overlay 并确认 JuiceFS 仍可编译**

从仓库根目录执行：

```powershell
.\scripts\apply-juicefs-overlay.ps1
cd third_party\juicefs
go build ./cmd/...
```

预期：脚本打印 `overlay applied`，`go build` 退出码 0。

（overlay 是待复制的代码片段，脱离了 `third_party/juicefs` 的完整模块无法单独 `go vet`，所以只在这里验证。）

- [ ] **Step 4: 写 foyer 侧失败的测试**

创建 `server/internal/foyer/import_test.go`：

```go
package foyer

import (
	"strings"
	"testing"
)

func TestImportArgsJSONAndDryRun(t *testing.T) {
	cfg := Config{MetaURL: "redis://redis:6379/1"}
	got := strings.Join(ImportArgs(cfg, "file:///mnt/e/photos/", "/photos", false), " ")
	want := "import --json redis://redis:6379/1 file:///mnt/e/photos/ /photos"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	got = strings.Join(ImportArgs(cfg, "file:///mnt/e/photos/", "/photos", true), " ")
	want = "import --json --dry-run redis://redis:6379/1 file:///mnt/e/photos/ /photos"
	if got != want {
		t.Fatalf("dry-run got %q want %q", got, want)
	}
}

func TestParseImportSummaryPicksJSONLine(t *testing.T) {
	text := "2026/09/18 23:00:00.000000 juicefs[1] <INFO>: scanning\n" +
		`{"dry_run":true,"dest":"/photos","scanned":3,"imported":0,"skipped":0,"objects":["a.jpg","b.jpg"]}` + "\n"
	res, err := parseImportSummary(text)
	if err != nil {
		t.Fatal(err)
	}
	if !res.DryRun || res.Scanned != 3 || res.Dest != "/photos" {
		t.Fatalf("%+v", res)
	}
	if len(res.Objects) != 2 || res.Objects[0] != "a.jpg" {
		t.Fatalf("objects %v", res.Objects)
	}
}

func TestParseImportSummaryIgnoresBracesInLogs(t *testing.T) {
	text := "<WARNING>: cannot parse {not json}\n" +
		`{"dry_run":false,"dest":"/photos","scanned":2,"imported":1,"skipped":1}` + "\n"
	res, err := parseImportSummary(text)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || res.Skipped != 1 || res.Scanned != 2 {
		t.Fatalf("%+v", res)
	}
}

func TestParseImportSummaryFailsWithoutJSON(t *testing.T) {
	if _, err := parseImportSummary("imported 0, skipped 0, scanned 0 -> /photos"); err == nil {
		t.Fatal("expected error")
	}
}
```

- [ ] **Step 5: 运行测试确认失败**

```powershell
cd server
go test ./internal/foyer -count=1 -run TestImportArgsJSONAndDryRun
```

预期：编译失败。因为 Step 6 会把 `ImportArgs` 改成 4 参、`Runner.Import` 改成 4 参并返回 `(ImportResult, error)`，此时旧签名与新测试同时存在，报错形如：

```text
too many arguments in call to ImportArgs
	have (Config, string, string, bool)
		have (Config, string, string)
```

（`health.go` 里旧的 3 参 `run.Import(cfg, srcURI, dest)` 调用也会一并报错，Step 8 会修好。）

- [ ] **Step 6: 实现 `import.go` 并改写 `exec.go` 的 Import**

创建 `server/internal/foyer/import.go`：

```go
package foyer

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ImportResult mirrors the JSON summary printed by `juicefs import --json`.
type ImportResult struct {
	DryRun   bool     `json:"dry_run"`
	Dest     string   `json:"dest"`
	Scanned  int      `json:"scanned"`
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Objects  []string `json:"objects,omitempty"`
}

// ImportArgs builds `juicefs import --json [--dry-run] META SRC DEST`.
func ImportArgs(cfg Config, src, dest string, dryRun bool) []string {
	args := []string{"import", "--json"}
	if dryRun {
		args = append(args, "--dry-run")
	}
	return append(args, cfg.MetaURL, src, dest)
}

// parseImportSummary scans output lines from the end and returns the first one
// that decodes as an ImportResult. JuiceFS logs to the same stream, and log
// lines may contain braces, so a plain "last line" parse is not enough.
func parseImportSummary(text string) (ImportResult, error) {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		s := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(s, "{") {
			continue
		}
		var res ImportResult
		if err := json.Unmarshal([]byte(s), &res); err == nil {
			return res, nil
		}
	}
	return ImportResult{}, fmt.Errorf("no JSON summary in import output: %s", truncate(text, 200))
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
```

在 `server/internal/foyer/exec.go` 中**删除**旧的 `ImportArgs` 与 `Import`，替换为：

```go
func (r Runner) Import(cfg Config, src, dest string, dryRun bool) (ImportResult, error) {
	c := r.cmd(ImportArgs(cfg, src, dest, dryRun)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return ImportResult{}, fmt.Errorf("juicefs import: %s", lastLine(msg))
		}
		return ImportResult{}, fmt.Errorf("juicefs import: %w", err)
	}
	res, perr := parseImportSummary(text)
	if perr != nil {
		return ImportResult{}, fmt.Errorf("juicefs import: %w", perr)
	}
	return res, nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
```

`exec.go` 顶部 import 需去掉不再使用的 `os`？**不要**——`cmd()` 仍在用 `os.Environ()`/`os.Stdout`，保持不变。

- [ ] **Step 7: 更新 `exec_test.go` 受影响的用例**

把 `TestFormatAndGatewayArgs` 中的 import 断言替换为：

```go
	ia := strings.Join(ImportArgs(cfg, "file:///data/in", "/photos", false), " ")
	if ia != "import --json redis://redis:6379/1 file:///data/in /photos" {
		t.Fatal(ia)
	}
```

让**两个平台**的 fake 都能回显导入摘要。现有 POSIX 分支只处理 `status` 与 `format`，不补 `import` 分支的话，Linux/容器里 `TestImportParsesSummary` 与 `TestMountResyncRoute` 会失败。

`writeFakeJuice` 的 POSIX 分支，在 `format` 那一行之后追加：

```go
	script += "if [ \"$1\" = import ]; then printf '%s\\n' '{\"dry_run\":false,\"dest\":\"/photos\",\"scanned\":2,\"imported\":1,\"skipped\":1}'; exit 0; fi\n"
```

`writeFakeJuiceGo`（Windows 分支）的 `case "import":` 分支改成回显同一条摘要：

```go
	case "import":
		fmt.Println(`{"dry_run":false,"dest":"/photos","scanned":2,"imported":1,"skipped":1}`)
		os.Exit(0)
```

两边输出的 JSON 必须逐字一致，否则 `TestMountResyncRoute` 里的 `"skipped":1` 断言只在某一个平台成立。

把 `TestImportSurfacesCommandOutput` 替换为三个用例：

```go
func TestImportParsesSummary(t *testing.T) {
	bin := writeFakeJuice(t, true)
	r := Runner{Bin: bin}
	res, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || res.Skipped != 1 || res.Scanned != 2 {
		t.Fatalf("%+v", res)
	}
}

func TestImportReportsNonZeroExit(t *testing.T) {
	bin := writeFakeImport(t, "FATAL: bucket missing", 1)
	r := Runner{Bin: bin}
	_, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err == nil || !strings.Contains(err.Error(), "bucket missing") {
		t.Fatalf("got %v", err)
	}
}

func TestImportRejectsOutputWithoutSummary(t *testing.T) {
	bin := writeFakeImport(t, "imported 0, skipped 0, scanned 0 -> /photos", 0)
	r := Runner{Bin: bin}
	_, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err == nil || !strings.Contains(err.Error(), "no JSON summary") {
		t.Fatalf("got %v", err)
	}
}

func writeFakeImport(t *testing.T, stdout string, code int) string {
	t.Helper()
	// stdout 必须是不含引号的单行文本：Windows 分支把它内联进 Go 源码，
	// POSIX 分支把它内联进 shell 单引号。需要回显 JSON 的场景请用 writeFakeJuice。
	dir := t.TempDir()
	if runtime.GOOS != "windows" {
		path := filepath.Join(dir, "juicefs")
		script := "#!/bin/sh\nprintf '%s\\n' '" + stdout + "'\nexit " + strconv.Itoa(code) + "\n"
		if err := os.WriteFile(path, []byte(script), 0755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	src := `package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("` + stdout + `")
	os.Exit(` + strconv.Itoa(code) + `)
}
`
	srcPath := filepath.Join(dir, "fakejuice.go")
	if err := os.WriteFile(srcPath, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "juicefs.exe")
	cmd := exec.Command("go", "build", "-o", out, srcPath)
	cmd.Dir = dir
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake juicefs: %v\n%s", err, b)
	}
	return out
}
```

`exec_test.go` 的 import 块需加 `strconv`。

- [ ] **Step 8: 让 `/foyer/import` 支持 `dry_run` 并返回计数**

在 `server/internal/foyer/health.go` 的 `importRequest` 增加字段：

```go
type importRequest struct {
	Src    string `json:"src"`
	Dest   string `json:"dest"`
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	DryRun bool   `json:"dry_run"`
}
```

新增响应辅助（放在 `NewHealthMux` 之前）：

```go
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
```

把 handler 里 `if err := run.Import(cfg, srcURI, dest); err != nil {` 起至函数结束的段落替换为：

```go
		res, err := run.Import(cfg, srcURI, dest, req.DryRun)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if req.DryRun {
			// 预检不落挂载表。
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
			return
		}
		if name == "" {
			name = strings.Trim(dest, "/")
		}
		rec := MountRecord{
			ID:     name,
			Name:   name,
			Type:   "local",
			Status: "mounted",
			Spec: map[string]string{
				"root":      req.Src,
				"container": container,
				"dest":      dest,
				"mode":      mode,
			},
		}
		if dir := filepath.Dir(cfg.MountsFile); dir != "." && dir != "" {
			_ = os.MkdirAll(dir, 0755)
		}
		if err := store.upsert(rec); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mount": rec, "result": res})
	})
```

（即：成功响应体从原来的 `{"ok":true,"mount":rec}` 扩展为带 `result`；预检走 `{"ok":true,"result":…}` 且不写 `mounts.json`。）

- [ ] **Step 9: 补路由测试**

在 `server/internal/foyer/health_test.go` 的 `TestHealthJSONAndRoute` 之后追加：

```go
func TestImportDryRunRouteSkipsMountRecord(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{
		Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://127.0.0.1:6379/1",
		MountsFile: filepath.Join(dir, "mounts.json"), JuiceFSBin: writeFakeJuice(t, true),
	}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/import",
		strings.NewReader(`{"src":"/mnt/e/photos","dest":"/photos","name":"photos","dry_run":true}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body struct {
		OK     bool         `json:"ok"`
		Result ImportResult `json:"result"`
		Mount  *MountRecord `json:"mount"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Result.Scanned != 2 || body.Mount != nil {
		t.Fatalf("%+v", body)
	}
	if _, err := os.Stat(cfg.MountsFile); !os.IsNotExist(err) {
		t.Fatalf("dry-run must not write mounts file, err=%v", err)
	}
}
```

`health_test.go` 的 import 块补充 `os`、`path/filepath`。

- [ ] **Step 10: 跑测试确认通过**

```powershell
cd server
go test ./internal/foyer -count=1
```

预期：`ok  filestore/internal/foyer`（包含 `TestImportArgsJSONAndDryRun`、`TestParseImportSummary*`、`TestImportParsesSummary`、`TestImportDryRunRouteSkipsMountRecord`）。

- [ ] **Step 11（可选）: 提交**

```powershell
git add overlays/juicefs/cmd/import.go server/internal/foyer
git commit -m "feat(foyer): structured import summary and dry-run preview"
```

---

### Task 2: 挂载生命周期端点（foyer）

**Files:**
- Modify: `server/internal/foyer/mounts.go`
- Create: `server/internal/foyer/mounts_test.go`
- Modify: `server/internal/foyer/health.go`
- Modify: `server/internal/foyer/health_test.go`

**Interfaces:**
- Consumes: `ImportResult`、`Runner.Import(cfg, src, dest, dryRun)`（Task 1）
- Produces:

```go
func (s *mountStore) get(id string) (MountRecord, bool, error)
func (s *mountStore) update(id string, fn func(*MountRecord)) (MountRecord, bool, error)

// HTTP
// DELETE /foyer/mounts/{id}          -> 204 | 404
// PATCH  /foyer/mounts/{id}          -> 200 {mount} | 400 | 404
// POST   /foyer/mounts/{id}/resync   -> 200 {ok:true,result} | 400 | 404 | 502
```

---

- [ ] **Step 1: 写 store 的失败测试**

创建 `server/internal/foyer/mounts_test.go`：

```go
package foyer

import (
	"path/filepath"
	"testing"
)

func TestMountStoreGetAndUpdate(t *testing.T) {
	s := newMountStore(filepath.Join(t.TempDir(), "mounts.json"))
	if err := s.upsert(MountRecord{
		ID: "photos", Name: "photos", Type: "local", Status: "mounted",
		Spec: map[string]string{"root": `E:\photos`, "dest": "/photos", "mode": "metadata"},
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := s.update("photos", func(m *MountRecord) { m.Status = "unmounted" })
	if err != nil || !ok {
		t.Fatalf("update ok=%v err=%v", ok, err)
	}
	if got.Status != "unmounted" {
		t.Fatalf("status %s", got.Status)
	}

	// update 必须落盘，而不是只改内存。
	again, ok, err := s.get("photos")
	if err != nil || !ok {
		t.Fatalf("get ok=%v err=%v", ok, err)
	}
	if again.Status != "unmounted" {
		t.Fatalf("persisted status %s", again.Status)
	}
}

func TestMountStoreMatchesByIDOrName(t *testing.T) {
	s := newMountStore(filepath.Join(t.TempDir(), "mounts.json"))
	if err := s.upsert(MountRecord{ID: "uuid-1", Name: "photos", Type: "local", Status: "mounted"}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.get("photos"); !ok {
		t.Fatal("lookup by name should hit")
	}
	if _, ok, _ := s.get("nope"); ok {
		t.Fatal("unknown id should miss")
	}
}
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd server
go test ./internal/foyer -count=1 -run TestMountStore
```

预期：编译失败 `s.get undefined`。

- [ ] **Step 3: 实现 `get` 与 `update`**

在 `server/internal/foyer/mounts.go` 末尾追加（`readLocked` 假定已持有锁，两个方法自己加锁）：

```go
func (s *mountStore) get(id string) (MountRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return MountRecord{}, false, err
	}
	for _, x := range list {
		if x.ID == id || x.Name == id {
			return x, true, nil
		}
	}
	return MountRecord{}, false, nil
}

// update applies fn to the first record matching id (by ID or Name) and
// persists the whole table. Returns the updated record; ok=false means miss.
func (s *mountStore) update(id string, fn func(*MountRecord)) (MountRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return MountRecord{}, false, err
	}
	for i := range list {
		if list[i].ID == id || list[i].Name == id {
			fn(&list[i])
			b, err := json.MarshalIndent(list, "", "  ")
			if err != nil {
				return MountRecord{}, false, err
			}
			if err := os.WriteFile(s.file, b, 0644); err != nil {
				return MountRecord{}, false, err
			}
			return list[i], true, nil
		}
	}
	return MountRecord{}, false, nil
}
```

- [ ] **Step 4: 运行 store 测试**

```powershell
cd server
go test ./internal/foyer -count=1 -run TestMountStore
```

预期：`PASS`（两个用例）。

- [ ] **Step 5: 写生命周期路由的失败测试**

在 `server/internal/foyer/health_test.go` 追加：

```go
func seedMounts(t *testing.T, cfg Config) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(cfg.MountsFile), 0755); err != nil {
		t.Fatal(err)
	}
	seed := `[{"id":"photos","name":"photos","type":"local","status":"mounted",` +
		`"spec":{"root":"E:\\photos","dest":"/photos","mode":"metadata"}}]`
	if err := os.WriteFile(cfg.MountsFile, []byte(seed), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMountPatchRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json")}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/photos",
		strings.NewReader(`{"status":"unmounted"}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "unmounted") {
		t.Fatalf("body %s", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/photos",
		strings.NewReader(`{"status":"weird"}`)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad status accepted: %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPatch, "/foyer/mounts/ghost",
		strings.NewReader(`{"status":"unmounted"}`)))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestMountDeleteRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json")}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/foyer/mounts/photos", nil))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/foyer/mounts/photos", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("second delete should 404, got %d", rr.Code)
	}
}

func TestMountResyncRoute(t *testing.T) {
	cfg := Config{Volume: "foyer", GatewayListen: ":9002", MetaURL: "redis://x",
		MountsFile: filepath.Join(t.TempDir(), "mounts.json"), JuiceFSBin: writeFakeJuice(t, true)}
	seedMounts(t, cfg)
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/mounts/photos/resync", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"skipped":1`) {
		t.Fatalf("expected import summary in body, got %s", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/mounts/ghost/resync", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}
```

`seedMounts` 用 `spec.container` 缺省触发 `MapHostPath`；`cfg.HostData` 为空且 `root` 是 Windows 路径时 `MapHostPath` 会走 `E:\photos` → `/mnt/e/photos` 分支并且**不报错**（见 `path_test.go` 的 `TestMapHostPathAnyDrive`）。因此 resync 能构造出 `file:///mnt/e/photos/`。

- [ ] **Step 6: 运行确认失败**

```powershell
cd server
go test ./internal/foyer -count=1 -run TestMount
```

预期：`TestMountStore*` 通过，`TestMountPatchRoute` / `TestMountDeleteRoute` / `TestMountResyncRoute` 失败（`404 page not found`，因为路由未注册）。

- [ ] **Step 7: 注册生命周期路由**

在 `server/internal/foyer/health.go` 的 `NewHealthMux` 中，把 `mux.HandleFunc("/foyer/mounts", …)` 的注册改为同时注册集合与条目两个模式，紧跟其后插入：

```go
	mux.HandleFunc("/foyer/mounts/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/foyer/mounts/"), "/")
		if rest == "" {
			http.NotFound(w, r)
			return
		}
		if id, ok := strings.CutSuffix(rest, "/resync"); ok {
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			resyncMount(w, cfg, store, run, id)
			return
		}
		switch r.Method {
		case http.MethodDelete:
			deleteMount(w, store, rest)
		case http.MethodPatch:
			patchMount(w, r, store, rest)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
```

并在文件中新增三个 handler：

```go
func deleteMount(w http.ResponseWriter, store *mountStore, id string) {
	if _, ok, err := store.get(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	} else if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	if err := store.remove(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func patchMount(w http.ResponseWriter, r *http.Request, store *mountStore, id string) {
	var in struct {
		Name   *string           `json:"name"`
		Spec   map[string]string `json:"spec"`
		Status *string           `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.Status != nil && *in.Status != "mounted" && *in.Status != "unmounted" {
		http.Error(w, "status must be mounted or unmounted", http.StatusBadRequest)
		return
	}
	rec, ok, err := store.update(id, func(m *MountRecord) {
		if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
			m.Name = strings.TrimSpace(*in.Name)
		}
		if in.Spec != nil {
			m.Spec = in.Spec
		}
		if in.Status != nil {
			m.Status = *in.Status
		}
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mount": rec})
}

func resyncMount(w http.ResponseWriter, cfg Config, store *mountStore, run Runner, id string) {
	rec, ok, err := store.get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	dest := strings.TrimSpace(rec.Spec["dest"])
	if dest == "" {
		dest = "/" + rec.Name
	}
	container := strings.TrimSpace(rec.Spec["container"])
	if container == "" {
		container, err = MapHostPath(cfg, rec.Spec["root"])
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	// 重复导入是幂等的：importOne 遇到 EEXIST 会跳过并计入 skipped。
	res, err := run.Import(cfg, FileURI(container), dest, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
}
```

`strings.CutSuffix` 需要 Go 1.20+；`server/go.mod` 已是 1.23，无需改动。

- [ ] **Step 8: 跑测试确认通过**

```powershell
cd server
go test ./internal/foyer -count=1
```

预期：`ok  filestore/internal/foyer`。

- [ ] **Step 9: 手工验证真实栈（可选但推荐）**

```powershell
curl.exe -X POST http://127.0.0.1:8092/foyer/import -H "Content-Type: application/json" -d '{\"src\":\"E:\\\\photos\",\"dest\":\"/photos\",\"name\":\"photos\",\"dry_run\":true}'
curl.exe -X PATCH http://127.0.0.1:8092/foyer/mounts/photos -H "Content-Type: application/json" -d '{\"status\":\"unmounted\"}'
curl.exe -X POST http://127.0.0.1:8092/foyer/mounts/photos/resync
curl.exe -X DELETE http://127.0.0.1:8092/foyer/mounts/photos
```

预期依次为：`{"ok":true,"result":{...,"scanned":N,...}}`、`{"mount":{...,"status":"unmounted"}}`、`{"ok":true,"result":{...,"imported":0,"skipped":N,...}}`（第二次导入全部跳过）、HTTP 204。最后用 `curl http://127.0.0.1:8092/foyer/mounts` 确认列表已空，并确认 JuiceFS 里 `/photos` 的文件仍可读（删除只动目录项）。

- [ ] **Step 10（可选）: 提交**

```powershell
git add server/internal/foyer
git commit -m "feat(foyer): mount patch/delete/resync endpoints"
```

---

### Task 3: Web API 层接上控制面（含纯函数单测）

**Files:**
- Modify: `web/src/api/jfs.ts`
- Create: `web/src/api/mounts.ts`
- Create: `web/src/api/mounts.test.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/context/FileStoreContext.tsx`

**Interfaces:**
- Consumes: Task 1 的 `dry_run` 响应、Task 2 的 `PATCH`/`DELETE`/`resync` 端点
- Produces（供 Task 4/5 使用）:

```ts
// jfs.ts —— FoyerImportResult 是命名导出，供 Context 用 `import type { FoyerImportResult }` 引用
export type FoyerImportResult = {  dry_run: boolean;
  dest: string;
  scanned: number;
  imported: number;
  skipped: number;
  objects?: string[];
};
export async function foyerImport(body: {
  src: string; dest?: string; name?: string; mode?: string; dry_run?: boolean;
}): Promise<{ ok: boolean; mount?: FoyerMount; result?: FoyerImportResult }>
export async function foyerDeleteMount(id: string): Promise<void>
export async function foyerPatchMount(
  id: string,
  patch: { name?: string; spec?: Record<string, string>; status?: string }
): Promise<FoyerMount>
export async function foyerResyncMount(id: string): Promise<FoyerImportResult>

// mounts.ts
export type FoyerMountLike = {
  id: string;
  name: string;
  type?: string;
  spec?: Record<string, string>;
  status?: string;
  created_at?: string;
};
export function volumeMount(): ApiMount
export function isMetadataImport(m: { spec?: Record<string, string> }): boolean
export function mergeMounts(extra: FoyerMountLike[]): ApiMount[]

// client.ts
export async function previewLocalImport(name: string, root: string): Promise<jfs.FoyerImportResult>
export async function resyncMount(id: string): Promise<jfs.FoyerImportResult>
```

---

- [ ] **Step 1: 写纯函数失败测试**

创建 `web/src/api/mounts.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isMetadataImport, mergeMounts, volumeMount } from './mounts';
import type { ApiMount } from './client';

const imported: ApiMount = {
  id: 'photos',
  name: 'photos',
  type: 'local',
  status: 'mounted',
  spec: { root: 'E:\\photos', container: '/mnt/e/photos', dest: '/photos', mode: 'metadata' },
};

describe('mounts merge', () => {
  it('always puts the gateway volume first', () => {
    const list = mergeMounts([imported]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(volumeMount());
    expect(list[0].name).toBe('foyer');
    expect(list[1].name).toBe('photos');
  });

  it('skips entries that shadow the volume mount', () => {
    const list = mergeMounts([{ ...imported, id: 'foyer', name: 'foyer' }, imported]);
    expect(list.map(m => m.name)).toEqual(['foyer', 'photos']);
  });

  it('skips nameless entries', () => {
    const list = mergeMounts([{ id: 'x', name: '', type: 'local' }]);
    expect(list).toHaveLength(1);
  });

  it('defaults type and status', () => {
    const list = mergeMounts([{ id: 'a', name: 'a' }]);
    expect(list[1].type).toBe('local');
    expect(list[1].status).toBe('mounted');
  });
});

describe('isMetadataImport', () => {
  it('detects the metadata import mode', () => {
    expect(isMetadataImport(imported)).toBe(true);
    expect(isMetadataImport({ spec: { mode: 'copy' } })).toBe(false);
    expect(isMetadataImport({})).toBe(false);
    expect(isMetadataImport({ spec: { bucket: 'foyer' } })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd web
npm test -- src/api/mounts.test.ts
```

预期：`Failed to resolve import "./mounts"`。

- [ ] **Step 3: 实现 `mounts.ts`**

创建 `web/src/api/mounts.ts`：

```ts
import type { ApiMount } from './client';
import * as jfs from './jfs';

/** foyer 目录项的形状：type/status 允许缺省，由 mergeMounts 补默认值 */
export type FoyerMountLike = {
  id: string;
  name: string;
  type?: string;
  spec?: Record<string, string>;
  status?: string;
  created_at?: string;
};

/** 网关本身暴露的卷，永远排在挂载表第一位 */
export function volumeMount(): ApiMount {
  return {
    id: jfs.JFS_MOUNT,
    name: jfs.JFS_MOUNT,
    type: 's3',
    spec: { bucket: jfs.JFS_BUCKET, via: 'juicefs-gateway' },
    status: 'mounted',
  };
}

/** 仅导入元数据的挂载：内容只读，删除只去元数据 */
export function isMetadataImport(m: { spec?: Record<string, string> }): boolean {
  return (m.spec?.mode || '') === 'metadata';
}

/** 合并内置卷挂载与 foyer 目录项，保持卷在首位并跳过重名 */
export function mergeMounts(extra: FoyerMountLike[]): ApiMount[] {
  const out: ApiMount[] = [volumeMount()];
  for (const m of extra) {
    if (!m.name || m.name === jfs.JFS_MOUNT) continue;
    if (out.some(x => x.name === m.name)) continue;
    out.push({ ...m, type: m.type || 'local', status: m.status || 'mounted' });
  }
  return out;
}
```

`ApiMount` 用 `import type`，运行时不会与 `client.ts` 形成循环依赖（`client.ts` 反向以值导入 `mergeMounts`）。`FoyerMountLike` 允许 `type`/`status` 缺省，这样 `<ApiMount>` 必填字段校验不会挡掉测试里那些只给 `{id, name}` 的桩数据。

- [ ] **Step 4: 运行确认纯函数测试通过**

```powershell
cd web
npm test -- src/api/mounts.test.ts
```

预期：`Tests  5 passed`。

（`src/**/*.test.ts` 里只有这一个文件被 positional filter 选中；`npm test` 是 `vitest run`。）

- [ ] **Step 5: 扩展 `jfs.ts`**

把 `foyerImport` 的入参与返回类型替换为：

```ts
export type FoyerImportResult = {
  dry_run: boolean;
  dest: string;
  scanned: number;
  imported: number;
  skipped: number;
  objects?: string[];
};

export async function foyerImport(body: {
  src: string;
  dest?: string;
  name?: string;
  mode?: string;
  dry_run?: boolean;
}): Promise<{ ok: boolean; mount?: FoyerMount; result?: FoyerImportResult }> {
  const res = await fetch('/foyer/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(text || '导入失败', res.status);
  }
  try {
    return JSON.parse(text) as { ok: boolean; mount?: FoyerMount; result?: FoyerImportResult };
  } catch {
    return { ok: true };
  }
}

export async function foyerDeleteMount(id: string): Promise<void> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new ApiError((await res.text()) || '删除挂载失败', res.status);
  }
}

export async function foyerPatchMount(
  id: string,
  patch: { name?: string; spec?: Record<string, string>; status?: string }
): Promise<FoyerMount> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(text || '更新挂载失败', res.status);
  const data = JSON.parse(text) as { mount: FoyerMount };
  return data.mount;
}

export async function foyerResyncMount(id: string): Promise<FoyerImportResult> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}/resync`, { method: 'POST' });
  const text = await res.text();
  if (!res.ok) throw new ApiError(text || '增量同步失败', res.status);
  const data = JSON.parse(text) as { ok: boolean; result: FoyerImportResult };
  return data.result;
}
```

- [ ] **Step 6: 让 `client.ts` 去掉 501 并复用 `mergeMounts`**

把 `listMounts` 内联的合并逻辑替换为调用纯函数，并改写四个动词：

```ts
export async function listMounts(): Promise<{ mounts: ApiMount[] }> {
  await jfs.headBucket();
  let extra: ApiMount[] = [];
  try {
    extra = await jfs.foyerMounts();
  } catch {
    /* foyer 目录暂时不可用时仍暴露卷挂载 */
  }
  return { mounts: mergeMounts(extra) };
}

export async function patchMount(
  id: string,
  body: { name?: string; type?: string; spec?: Record<string, string>; status?: string }
): Promise<ApiMount> {
  const m = await jfs.foyerPatchMount(id, { name: body.name, spec: body.spec, status: body.status });
  return {
    id: m.id || id,
    name: m.name || id,
    type: m.type || 'local',
    spec: m.spec,
    status: m.status || 'mounted',
    created_at: m.created_at,
  };
}

export async function deleteMount(id: string): Promise<void> {
  await jfs.foyerDeleteMount(id);
}

export async function unmount(id: string): Promise<Record<string, unknown>> {
  return (await jfs.foyerPatchMount(id, { status: 'unmounted' })) as unknown as Record<string, unknown>;
}

export async function remount(_id: string): Promise<Record<string, unknown>> {
  await jfs.headBucket();
  return { ok: true };
}

export async function resyncMount(id: string): Promise<jfs.FoyerImportResult> {
  const out = await jfs.foyerResyncMount(id);
  await jfs.headBucket();
  return out;
}

export async function previewLocalImport(name: string, root: string): Promise<jfs.FoyerImportResult> {
  const out = await jfs.foyerImport({
    src: root,
    dest: `/${name}`,
    name,
    mode: 'metadata',
    dry_run: true,
  });
  if (!out.result) throw new ApiError('预检未返回结果', 502);
  return out.result;
}
```

在 `client.ts` 顶部 import 区加入 `import { mergeMounts } from './mounts';`，并删除现在不再使用的 `volumeMount` 局部函数（第 59-66 行）。`unsupported` 仍被 `reconcileMount` / `getJob` 使用，保留。

- [ ] **Step 7: 暴露到 Context**

在 `web/src/context/FileStoreContext.tsx` 的接口里，紧接 `triggerReconcile` 之后加：

```ts
  previewLocalImport: (name: string, root: string) => Promise<FoyerImportResult>;
  resyncMount: (id: string) => Promise<FoyerImportResult>;
```

顶部加 `import type { FoyerImportResult } from '../api/jfs';`（`isolatedModules: true` 下类型导入必须用 `import type`）。

实现放在 `triggerReconcile` 之后：

```ts
  const previewLocalImport = async (name: string, root: string) => {
    return api.previewLocalImport(name, root);
  };

  const resyncMount = async (id: string) => {
    try {
      const res = await api.resyncMount(id);
      await refreshMounts();
      await refreshDirectory();
      return res;
    } catch (err) {
      reportError(err);
      throw err;
    }
  };
```

并把这两个名字加进 `value={{ … }}` 列表。

- [ ] **Step 8: 类型检查与全量测试**

```powershell
cd web
npm run lint
npm test
```

预期：`npm run lint`（即 `tsc --noEmit`）无输出、退出码 0；vitest 全绿（含既有 `parse.test.ts` / `run.test.ts` / `jfs.test.ts` 与新增 `mounts.test.ts`）。

- [ ] **Step 9（可选）: 提交**

```powershell
git add web/src/api web/src/context
git commit -m "feat(web): mount lifecycle API and pure merge helpers"
```

---

### Task 4: 挂载卡（只读徽标 / 删除 / 增量同步）

**Files:**
- Modify: `web/src/components/MountManager.tsx`

**Interfaces:**
- Consumes: `removeMount` / `resyncMount` / `triggerReconcile` / `probeMount`（Context）、`isMetadataImport`（Task 3）
- Produces: 无新导出

---

- [ ] **Step 1: 引入依赖与局部状态**

`MountManager.tsx` 的 `lucide-react` 导入列表里**已经**有 `RefreshCw`、`Trash2`、`FileCheck`，只需新增增量同步用的 `RefreshCcw`：

```tsx
  RefreshCw,
  RefreshCcw,
```

（`RefreshCw` 原本只被「对账」按钮使用，该按钮在 Step 4 会被移除；`tsconfig.json` 未开 `noUnusedLocals`，留着不会导致 lint 失败，也可以顺手删掉。）

在同文件顶部加纯函数导入：

```tsx
import { isMetadataImport } from '../api/mounts';
```

组件内新增状态：

```tsx
  const [busyId, setBusyId] = useState<string | null>(null);
```

从 Context 解构处补上 `resyncMount`，并去掉 `triggerReconcile`（它走的 `reconcileMount` 仍返回 501，见「明确不做」）：

```tsx
  const {
    mounts,
    addMount,
    removeMount,
    probeMount,
    resyncMount,
    setIsNewMountOpen,
    navigateTo
  } = useFileStore();
```

若 `triggerReconcile` 去掉后 `useState` 之外还有未使用变量，`npm run lint` 会报错——按提示一并删除即可。

- [ ] **Step 2: 加删除与增量同步的处理函数**

在 `handleProbe` 之后插入：

```tsx
  const handleDelete = async (m: Mount) => {
    const ok = window.confirm(
      `从挂载表移除 ${m.name}: ？\n\n` +
        '只移除目录项，不会删除 JuiceFS 中已导入的文件（内容只读，删除需在挂载点用 rmr）。'
    );
    if (!ok) return;
    setBusyId(m.id);
    try {
      await removeMount(m.id);
    } finally {
      setBusyId(null);
    }
  };

  const handleResync = async (m: Mount) => {
    setBusyId(m.id);
    try {
      const res = await resyncMount(m.id);
      setProbeResult({ id: m.id, success: true });
      window.alert(`增量同步完成：新增 ${res.imported}，已存在跳过 ${res.skipped}，扫描 ${res.scanned}`);
    } catch {
      setProbeResult({ id: m.id, success: false });
    } finally {
      setBusyId(null);
      setTimeout(() => setProbeResult(null), 3000);
    }
  };
```

- [ ] **Step 3: 渲染只读徽标**

在挂载卡标题行（`<span className="font-mono font-bold text-sm text-slate-900">{m.name}:</span>` 之后、类型 pill 之后）插入：

```tsx
                        {isMetadataImport(m) && (
                          <span
                            className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-100 font-medium"
                            title="仅导入元数据：内容只读，删除只去元数据，不搬数据"
                          >
                            <FileCheck className="w-3 h-3" />
                            只读导入
                          </span>
                        )}
```

并把「已索引对象 / 占用空间」两格中，对元数据导入挂载补一行来源说明——在 metrics `grid` 之后插入：

```tsx
                {isMetadataImport(m) && (
                  <p className="text-[11px] text-slate-400 font-mono mb-3 truncate" title={m.spec.root}>
                    来源 {m.spec.root || '—'} → dest {m.spec.dest || `/${m.name}`}
                  </p>
                )}
```

- [ ] **Step 4: 底部操作区加按钮**

把底部 `{/* Bottom Actions */}` 区块里的右侧 `<div className="flex items-center gap-2">` 替换为：

```tsx
                <div className="flex items-center gap-2">
                  {isMetadataImport(m) && (
                    <button
                      onClick={() => handleResync(m)}
                      disabled={busyId === m.id}
                      className="flex items-center gap-1 text-slate-600 hover:text-emerald-600 font-medium disabled:text-slate-300"
                    >
                      <RefreshCcw className={`w-3.5 h-3.5 ${busyId === m.id ? 'animate-spin' : ''}`} />
                      <span>增量同步</span>
                    </button>
                  )}

                  <button
                    onClick={() => navigateTo(m.name, '/')}
                    className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors"
                  >
                    浏览文件
                  </button>

                  <button
                    onClick={() => handleDelete(m)}
                    disabled={busyId === m.id}
                    className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:text-slate-200 transition-colors"
                    title="从挂载表移除（不删除已导入文件）"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
```

注意：网关卷本身（`name === 'foyer'`）在 `m.spec` 里没有 `mode`，因此不会显示「只读导入」与「增量同步」，删除按钮对它也没有意义——若希望彻底隐藏，可在 `handleDelete` 里加 `if (m.name === 'foyer') return;` 并在按钮上包一层 `{m.name !== 'foyer' && …}`。

- [ ] **Step 5: 类型检查与手工验证**

```powershell
cd web
npm run lint
npm run dev
```

手工清单（对着真实栈）：
1. 以 `local` 挂载一张卡 → 卡片出现「只读导入」徽标与来源行。
2. 往宿主机目录新增一个文件 → 点「增量同步」→ 弹窗显示 `新增 1，已存在跳过 N`，进入该挂载的 `/` 能看到新文件。
3. 点删除 → 确认框文案含「不会删除 JuiceFS 中已导入的文件」→ 确认后卡片消失，`curl http://127.0.0.1:19002` 侧的文件仍可读（用 `aws s3 cp s3://foyer/photos/<file> -` 验证）。

- [ ] **Step 6（可选）: 提交**

```powershell
git add web/src/components/MountManager.tsx
git commit -m "feat(web): mount card read-only badge, resync and delete"
```

---

### Task 5: 新建挂载「预检 → 确认」两步
**Files:**
- Modify: `web/src/components/NewMountModal.tsx`

**Interfaces:**
- Consumes: `previewLocalImport(name, root)`（Context，Task 3）
- Produces: 无新导出

---

- [ ] **Step 1: 加预检状态与处理函数**

`NewMountModal.tsx` 顶部补 import：

```tsx
import { FileCheck, Loader2 } from 'lucide-react';
```

组件内新增状态（放在 `localRoot` 之后）：

```tsx
  const [preview, setPreview] = useState<{ scanned: number; objects: string[]; dest: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
```

从 Context 解构处补 `previewLocalImport`：

```tsx
  const { isNewMountOpen, setIsNewMountOpen, addMount, mounts, previewLocalImport } = useFileStore();
```

- [ ] **Step 2: 把提交拆成「预检」与「确认」两段**

`handleSubmit` 改为：本地元数据导入先预检，其余分支保持原样。把函数末尾 `try { await addMount(…) }` 之前的校验之后、`try` 之前插入：

```tsx
    // 本地「仅导入元数据」走两步：先预检，再确认。
    if (driverType === 'local' && ingestMode === 'metadata' && !preview) {
      setPreviewing(true);
      try {
        const res = await previewLocalImport(cleanName, localRoot.trim());
        setPreview({ scanned: res.scanned, objects: res.objects || [], dest: res.dest });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '预检失败，请检查路径与 JuiceFS 日志');
      } finally {
        setPreviewing(false);
      }
      return;
    }
```

并在同一函数开头的校验区（`setErrorMsg('');` 之后）加一行，防止用户改了路径后预检结果过期：

```tsx
    if (preview && driverType !== 'local') setPreview(null);
```

再给 `mountName` 与 `localRoot` 两个 input 的 `onChange` 各补一句 `setPreview(null);`，因为预检结果与「名称 + 路径」绑定，任一项变化都必须作废：

```tsx
                onChange={e => { setMountName(e.target.value); setPreview(null); }}
```

```tsx
                  onChange={e => { setLocalRoot(e.target.value); setPreview(null); }}
```

- [ ] **Step 3: 渲染预检面板**

在 `{driverType === 'local' && ( … )}` 表单块之后、`{/* Architecture Reminder */}` 之前插入：

```tsx
          {preview && driverType === 'local' && (
            <div className="bg-emerald-50/60 p-3.5 rounded-xl border border-emerald-200 space-y-2">
              <div className="flex items-center gap-1.5 text-emerald-800 font-medium">
                <FileCheck className="w-4 h-4" />
                <span>预检完成：将导入 {preview.scanned} 个对象到 {preview.dest}</span>
              </div>
              {preview.scanned === 0 ? (
                <p className="text-[11px] text-amber-700">
                  该目录下没有可导入的对象，请确认路径与容器挂载（当前盘符列表见上方提示）。
                </p>
              ) : (
                <>
                  <ul className="text-[11px] font-mono text-slate-600 space-y-0.5 max-h-32 overflow-y-auto">
                    {preview.objects.slice(0, 10).map(k => (
                      <li key={k} className="truncate">{`${preview.dest}/${k}`}</li>
                    ))}
                  </ul>
                  {preview.scanned > 10 && (
                    <p className="text-[11px] text-slate-400">…等共 {preview.scanned} 个（列表只显示前 10 个）</p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    确认后只写元数据，不复制文件内容；重复导入会跳过已存在的对象。
                  </p>
                </>
              )}
            </div>
          )}
```

- [ ] **Step 4: 按状态切换底部按钮**

把 `{/* Footer */}` 区块替换为：

```tsx
          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (preview) {
                  setPreview(null);
                  return;
                }
                setIsNewMountOpen(false);
              }}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              {preview ? '返回修改' : '取消'}
            </button>
            <button
              type="submit"
              disabled={previewing || (preview !== null && preview.scanned === 0)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
            >
              {previewing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>预检中…</span>
                </>
              ) : preview ? (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>确认导入 {preview.scanned} 个对象</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>预检并导入</span>
                </>
              )}
            </button>
          </div>
```

并在 `handleSubmit` 成功分支末尾加：`setPreview(null);`（关闭前复位，避免下次打开沿用旧结果）。

- [ ] **Step 5: 类型检查与手工验证**

```powershell
cd web
npm run lint
npm run dev
```

手工清单：
1. 选 `Local / NAS` + 「仅导入元数据」+ 已存在的目录（如 `E:\photos`）→ 点「预检并导入」→ 出现绿色面板，显示 `将导入 N 个对象到 /photos` 及前 10 条路径；按钮变为「确认导入 N 个对象」。
2. 点「返回修改」→ 回到表单；改路径后再次预检，计数随之变化。
3. 点「确认导入」→ 弹窗关闭，挂载表出现新卡片且带「只读导入」徽标。
4. 预检一个空目录 → 面板提示「没有可导入的对象」，确认按钮禁用。
5. 提交一个不存在的路径（如 `E:\nope`）→ 红色错误条显示 foyer 返回的原因，弹窗不关闭。

- [ ] **Step 6（可选）: 提交**

```powershell
git add web/src/components/NewMountModal.tsx
git commit -m "feat(web): two-step import with dry-run preview"
```

### Task 6: 导入保真源元数据（mtime / mode / 属主 / 目录时间）

**Files:**
- Modify: `overlays/juicefs/cmd/import.go`（`importSummary` 扩字段、`importObjects` 循环、`importOne` 签名、新增 `metadataFor` / `applyFileMetadata` / `applyDirMetadata` / `ImportDirPath` / `collectDirs`）
- Create: `overlays/juicefs/cmd/import_test.go`
- Modify: `scripts/apply-juicefs-overlay.ps1`、`scripts/apply-juicefs-overlay.sh`（新增 `cmd/import_test.go` 拷贝）
- Modify: `server/internal/foyer/import.go`、`server/internal/foyer/import_test.go`、`server/internal/foyer/exec_test.go`
- Modify: `web/src/api/jfs.ts`、`web/src/components/NewMountModal.tsx`、`web/src/components/MountManager.tsx`

**Interfaces:**
- Consumes: Task 1 的 `importSummary` / `importObjects` / `importOne` / `--json` / `importSampleLimit`；Task 3 的 `FoyerImportResult` 与 `previewLocalImport`
- Produces（foyer 与 Web 同名透传）: `mtime_kept`、`mtime_missing`、`dir_mtime_kept`、`mode_kept`、`owner_kept`

**为什么值得做（已核实的事实，不要凭直觉推翻）**

- 网关 `ListObjectsV2` 的 `LastModified` 就是元数据 mtime：`pkg/gateway/gateway.go:343-351` 把 `fi.ModTime()` 塞进 `minio.ObjectInfo`。所以**导入时写对 mtime，Web 文件列表就直接显示原始时间**；不写就是"导入时刻"。
- 源元数据可得性由接口决定，不是想不想拿的问题：

| 源元数据 | 接口来源 | 可得性 | 本任务处理 |
|---|---|---|---|
| mtime（含纳秒） | `object.Object.Mtime()`，见 `pkg/object/interface.go:27` | `file` 用 `fi.ModTime()`、`webdav` 用 `info.ModTime()`、`s3` 用 `*o.LastModified`（`pkg/object/s3.go:255-258`），主流后端都真实填充 | **写入**；零值与 epoch（`time.Unix(0,0)`，后端用来表示"没有时间"）都计入 `mtime_missing` |
| 目录 mtime | `store.Head(dir + "/")` | `file`/`sftp`/`nfs` 等有真实目录；S3 无目录对象，`Head` 报错 | **二遍回写**；取不到就跳过 |
| mode | `object.File.Mode()`，见 `pkg/object/object_storage.go:48` | 只有本地类后端实现 `File`（`toFile` 在 `pkg/object/file.go:94`）；S3 不实现 | **写入文件，剥掉写位**（`Perm() &^ 0222`）；目录保持 0755 |
| uid / gid | `object.File.Owner()` / `Group()`（是**名字**） | 同 mode；需 `utils.LookupUser` / `LookupGroup` 转 id，解析失败返回 -1 | 解析成功才 `chown`，best-effort |
| atime | 无 | `object.Object` 不暴露 atime | 不做（见「明确不做」） |

- `ListAllWithDelimiter` **不会把目录对象交给消费者**：`pkg/object/object_storage.go:218` 直接 `continue` 掉 `IsDir()` 项，只拿它继续递归。所以目录 mtime 必须另开一遍，不能指望循环里拿到。
- 计数有一处**已知的乐观偏差**：少数后端用当前时间兜底而不是零值（如 `pkg/object/redis.go:159` 的 `now`），这种"伪时间"会被算进 `mtime_kept`。源为 `redis`/`bos` 这类特殊后端时不要把 `mtime_kept` 当成真实校验；`file` / `webdav` / `s3` 三个本期会用到的源都没有这个问题。
- 属主写入不需要 root 之外的额外权限：`importObjects` 用的是 `meta.Background()`，其 uid=0（`pkg/meta/context.go:87-88`），而 `SetAttrUID|SetAttrGID` 只在 `ctx.Uid() != 0` 时才要求匹配（`pkg/meta/base.go:2912-2931`）。但仍按 best-effort 处理，避免 Windows/macOS 上 `LookupUser` 失败把整个导入带崩。
- 内容只读由 `FlagImmutable` 保证，与 mode 无关：写入路径在 `pkg/meta/tkv.go:2017` 直接 `EPERM`。因此保留源 mode 的**读/执行位**不会削弱只读保证，只需要剥掉写位（`&^ 0222`，见 Global Constraints）。
- **顺序是硬约束**：`SetAttrMtime` 必须早于 `SetAttrFlag(FlagImmutable)`。现有代码恰好是「先写时间、再置 flag」，改造时不要调换。

**不变式（写完用它自检）**

```text
dry-run:  mtime_kept + mtime_missing == scanned
真实导入: mtime_kept + mtime_missing == imported
dir_mtime_kept <= 目标目录数（S3 源通常为 0）
mode_kept + owner_kept <= imported
```

---

- [ ] **Step 1: 先写失败测试——保真推导是纯函数**

新建 `overlays/juicefs/cmd/import_test.go`：

```go
package cmd

import (
	"os"
	"testing"
	"time"

	"github.com/juicedata/juicefs/pkg/object"
)

// fakeFile 同时实现 object.Object 与 object.File，模拟本地文件源。
type fakeFile struct {
	key   string
	size  int64
	mtime time.Time
	mode  os.FileMode
	owner string
	group string
}

func (f fakeFile) Key() string          { return f.key }
func (f fakeFile) Size() int64          { return f.size }
func (f fakeFile) Mtime() time.Time     { return f.mtime }
func (f fakeFile) IsDir() bool          { return false }
func (f fakeFile) IsSymlink() bool      { return false }
func (f fakeFile) StorageClass() string { return "" }
func (f fakeFile) Owner() string        { return f.owner }
func (f fakeFile) Group() string        { return f.group }
func (f fakeFile) Mode() os.FileMode    { return f.mode }

// fakeObj 只实现 object.Object，模拟 S3 这类拿不到 mode/属主的源。
type fakeObj struct {
	key   string
	size  int64
	mtime time.Time
}

func (o fakeObj) Key() string          { return o.key }
func (o fakeObj) Size() int64          { return o.size }
func (o fakeObj) Mtime() time.Time     { return o.mtime }
func (o fakeObj) IsDir() bool          { return false }
func (o fakeObj) IsSymlink() bool      { return false }
func (o fakeObj) StorageClass() string { return "" }

// 断言假对象确实满足被测代码依赖的接口；写错方法签名时会在编译期暴露。
var (
	_ object.Object = fakeFile{}
	_ object.File   = fakeFile{}
	_ object.Object = fakeObj{}
)

var (
	uidOfRoot  = func(string) int { return 0 }
	gidOfRoot  = func(string) int { return 0 }
	uidUnknown = func(string) int { return -1 }
	gidUnknown = func(string) int { return -1 }
)

func TestMetadataForKeepsMtimeModeAndOwner(t *testing.T) {
	mt := time.Date(2026, 9, 1, 10, 20, 30, 123456789, time.UTC)
	o := fakeFile{key: "a.jpg", size: 3, mtime: mt, mode: 0644, owner: "root", group: "root"}

	got := metadataFor(o, uidOfRoot, gidOfRoot)
	if !got.Mtime.Equal(mt) {
		t.Fatalf("mtime = %s, want %s", got.Mtime, mt)
	}
	if got.Mode != 0444 {
		t.Fatalf("mode = %04o, want 0444 (源 0644 去掉写位)", got.Mode)
	}
	if !got.HasUid || got.Uid != 0 || !got.HasGid || got.Gid != 0 {
		t.Fatalf("owner = %+v, want uid/gid 0 marked present", got)
	}
}

func TestMetadataForZeroMtimeIsAbsent(t *testing.T) {
	got := metadataFor(fakeObj{key: "a.jpg", size: 3}, nil, nil)
	if !got.Mtime.IsZero() {
		t.Fatalf("mtime = %s, want zero", got.Mtime)
	}
	if got.Mode != 0 || got.HasUid || got.HasGid {
		t.Fatalf("unexpected metadata for plain object: %+v", got)
	}
}

func TestHasSourceMtimeRejectsZeroAndEpoch(t *testing.T) {
	cases := []struct {
		name string
		mt   time.Time
		want bool
	}{
		{"zero value", time.Time{}, false},
		// 多个后端的 CommonPrefixes 用 time.Unix(0,0) 表示"没有时间"。
		{"epoch", time.Unix(0, 0), false},
		{"epoch with nanos", time.Unix(0, 1), false},
		{"real time", time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC), true},
	}
	for _, c := range cases {
		if got := hasSourceMtime(c.mt); got != c.want {
			t.Fatalf("%s: hasSourceMtime(%s) = %v, want %v", c.name, c.mt, got, c.want)
		}
	}
}

func TestMetadataForTreatsEpochAsMissing(t *testing.T) {
	o := fakeFile{key: "a.jpg", mtime: time.Unix(0, 0), mode: 0644}

	if got := metadataFor(o, nil, nil); !got.Mtime.IsZero() {
		t.Fatalf("mtime = %s, want zero (epoch 视为缺失)", got.Mtime)
	}
}

func TestMetadataForUnresolvableOwnerSkipsChown(t *testing.T) {
	o := fakeFile{key: "a.jpg", mtime: time.Unix(100, 0), mode: 0600, owner: "nobody", group: "nogroup"}

	got := metadataFor(o, uidUnknown, gidUnknown)
	if got.HasUid || got.HasGid {
		t.Fatalf("owner should be absent when lookup fails: %+v", got)
	}
	if got.Mode != 0400 {
		t.Fatalf("mode = %04o, want 0400 (源 0600 去掉写位)", got.Mode)
	}
}

func TestMetadataForStripsWriteAndSpecialBits(t *testing.T) {
	o := fakeFile{key: "run.sh", mode: os.ModeDir | os.ModeSetuid | 0777}

	// 0777 -> 0555：写位（0222）剥掉，setuid/sticky 等特殊位与 ModeDir 不参与 Perm()。
	if got := metadataFor(o, nil, nil); got.Mode != 0555 {
		t.Fatalf("mode = %04o, want 0555", got.Mode)
	}
}

func TestImportDirPathTrimsTrailingSlash(t *testing.T) {
	cases := []struct{ dest, key, want string }{
		{"/photos", "a/b/", "/photos/a/b"},
		{"/", "a/", "/a"},
		{"/photos", "a", "/photos/a"},
	}
	for _, c := range cases {
		if got := ImportDirPath(c.dest, c.key); got != c.want {
			t.Fatalf("ImportDirPath(%q, %q) = %q, want %q", c.dest, c.key, got, c.want)
		}
	}
}

func TestIsInternalKeyDoesNotSkipUserDirs(t *testing.T) {
	cases := []struct {
		key, volume string
		want        bool
	}{
		{"chunks/0/1/", "", true},
		{"foyer/", "foyer", true},
		{"foyer/chunks/0/", "foyer", true},
		{"photos/", "foyer", false},
		{"photos/a.jpg", "foyer", false},
	}
	for _, c := range cases {
		if got := isInternalKey(c.key, c.volume); got != c.want {
			t.Fatalf("isInternalKey(%q, %q) = %v, want %v", c.key, c.volume, got, c.want)
		}
	}
}

func TestCollectDirsWalksAncestors(t *testing.T) {
	got := make(map[string]struct{})
	collectDirs("a/b/c/d.jpg", got)
	want := []string{"a", "a/b", "a/b/c"}
	if len(got) != len(want) {
		t.Fatalf("dirs = %v, want %v", got, want)
	}
	for _, w := range want {
		if _, ok := got[w]; !ok {
			t.Fatalf("missing %q in %v", w, got)
		}
	}
}
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd third_party/juicefs
go test ./cmd/ -run "TestMetadataFor|TestHasSourceMtime|TestImportDirPath|TestIsInternalKey|TestCollectDirs" -count=1
```

期望：`undefined: metadataFor`、`undefined: hasSourceMtime`、`undefined: ImportDirPath`、`undefined: isInternalKey`、`undefined: collectDirs`。

注意：此时 overlay 还没同步到 submodule，所以先执行 Step 7 的脚本改动再跑也行；顺序不强制，但**测试必须在实现之前看到失败**（否则无法确认测试真的在测东西）。

- [ ] **Step 3: 实现保真推导与路径工具**

编辑 `overlays/juicefs/cmd/import.go`。需要在 import 块补两行：`time` 与 `github.com/juicedata/juicefs/pkg/utils`（当前是 `encoding/json`、`fmt`、`path`、`strings`、`syscall`、`meta`、`object`、`vfs`、`cli`；`os` 不必加，`Mode().Perm()` 是方法调用，不需要引用 `os` 包名）。

把 `overlays/juicefs/pkg/vfs/compat.go` 里的 `SkipInternalKey` 拆成两部分（保持原有行为不变，`compat_test.go` 的现有断言必须继续通过）：

```go
// isInternalKey 判断对象键是否属于卷自身的前缀或 chunks 目录。
// 与 SkipInternalKey 的区别：这里不因为键以 "/" 结尾（目录）而返回 true。
func isInternalKey(key, volume string) bool {
	if volume != "" && (key == volume || strings.HasPrefix(key, volume+"/")) {
		return true
	}
	return strings.HasPrefix(key, "chunks/")
}

func SkipInternalKey(key, volume string) bool {
	if key == "" || strings.HasSuffix(key, "/") {
		return true
	}
	return isInternalKey(key, volume)
}
```

在 `cmd/import.go` 中新增（放在 `importOne` 之前）：

```go
// fileMeta 是源对象能提供的元数据；零值表示源没有提供该项。
type fileMeta struct {
	Mtime  time.Time
	Mode   uint16
	Uid    uint32
	Gid    uint32
	HasUid bool
	HasGid bool
}

// hasSourceMtime 判断源时间是否可信。零值与 epoch 都要当成缺失：
// 多个对象存储后端用 time.Unix(0, 0) 表示"没有时间"（如 CommonPrefixes），
// 它不满足 IsZero()，直接写下去会把文件变成 1970 年。
func hasSourceMtime(mt time.Time) bool {
	return !mt.IsZero() && mt.Unix() > 0
}

// metadataFor 从源对象推导可保留的元数据。
// lookupUser / lookupGroup 为 nil 时跳过属主解析（dry-run 不需要）。
func metadataFor(obj object.Object, lookupUser, lookupGroup func(string) int) fileMeta {
	var fm fileMeta
	if mt := obj.Mtime(); hasSourceMtime(mt) {
		fm.Mtime = mt
	}
	f, ok := obj.(object.File)
	if !ok {
		return fm
	}
	fm.Mode = uint16(f.Mode().Perm() &^ 0222) // 写位必然无法生效（FlagImmutable），不留假象
	if lookupUser != nil {
		if uid := lookupUser(f.Owner()); uid >= 0 {
			fm.Uid, fm.HasUid = uint32(uid), true
		}
	}
	if lookupGroup != nil {
		if gid := lookupGroup(f.Group()); gid >= 0 {
			fm.Gid, fm.HasGid = uint32(gid), true
		}
	}
	return fm
}

// ImportDirPath 把源目录键（可能带尾部 "/"）映射为目标卷的绝对路径。
func ImportDirPath(dest, key string) string {
	return path.Clean(vfs.JoinImportPath(dest, strings.TrimSuffix(key, "/")))
}

// collectDirs 记录相对键路径上的全部祖先目录，供目录 mtime 回写使用。
func collectDirs(rel string, into map[string]struct{}) {
	for d := path.Dir(rel); d != "." && d != "/" && d != ""; d = path.Dir(d) {
		into[d] = struct{}{}
	}
}
```

- [ ] **Step 4: `importOne` 写入元数据并计数**

把 `importOne` 替换为下面的版本（`mkdirParents` 不动），并新增 `applyFileMetadata`：

```go
func importOne(m meta.Meta, ctx meta.Context, jpath string, obj object.Object, blobJSON []byte, summary *importSummary) syscall.Errno {
	parent, st := mkdirParents(m, ctx, path.Dir(jpath))
	if st != 0 {
		return st
	}
	fm := metadataFor(obj, utils.LookupUser, utils.LookupGroup)
	mode := uint16(0444) // 源没有 mode（对象存储）时的回退
	if fm.Mode != 0 {
		mode = fm.Mode
	}
	name := path.Base(jpath)
	var inode meta.Ino
	var attr meta.Attr
	st = m.Create(ctx, parent, name, mode, 0000, syscall.O_EXCL, &inode, &attr)
	if st == syscall.EEXIST {
		return syscall.EEXIST
	}
	if st != 0 {
		return st
	}
	if fm.Mode != 0 {
		summary.ModeKept++
	}
	_ = m.Close(ctx, inode)
	if st = m.Truncate(ctx, inode, 0, uint64(obj.Size()), &attr, true); st != 0 {
		return st
	}
	// 时间必须写在 FlagImmutable 之前：immutable 之后写操作会被 meta 直接拒绝。
	applyFileMetadata(m, ctx, inode, fm, summary)
	if st = m.SetXattr(ctx, inode, vfs.ObjectXattr, []byte(obj.Key()), 0); st != 0 {
		return st
	}
	if st = m.SetXattr(ctx, inode, vfs.BlobXattr, blobJSON, 0); st != 0 {
		return st
	}
	attr.Flags = meta.FlagImmutable
	return m.SetAttr(ctx, inode, meta.SetAttrFlag, 0, &attr)
}

// applyFileMetadata 逐项 best-effort 写入源元数据：任何一项失败都只影响计数，不中断导入。
// 内容是只读的（FlagImmutable），元数据丢失不该让整个对象失败。
func applyFileMetadata(m meta.Meta, ctx meta.Context, inode meta.Ino, fm fileMeta, summary *importSummary) {
	if fm.Mtime.IsZero() {
		summary.MtimeMissing++
	} else {
		attr := meta.Attr{Mtime: fm.Mtime.Unix(), Mtimensec: uint32(fm.Mtime.Nanosecond())}
		if st := m.SetAttr(ctx, inode, meta.SetAttrMtime, 0, &attr); st == 0 {
			summary.MtimeKept++
		} else {
			logger.Debugf("keep mtime of inode %d: %s", inode, st)
			summary.MtimeMissing++
		}
	}
	if !fm.HasUid && !fm.HasGid {
		return
	}
	set := uint16(0)
	if fm.HasUid {
		set |= meta.SetAttrUID
	}
	if fm.HasGid {
		set |= meta.SetAttrGID
	}
	attr := meta.Attr{Uid: fm.Uid, Gid: fm.Gid}
	if st := m.SetAttr(ctx, inode, set, 0, &attr); st == 0 {
		summary.OwnerKept++
	} else {
		logger.Debugf("keep owner of inode %d: %s", inode, st)
	}
}
```

- [ ] **Step 5: 目录 mtime 二遍回写**

新增（放在 `importOne` 之后）：

```go
// applyDirMetadata 在文件全部创建后回写源目录的 mtime。
// 必须晚于文件创建：新建子项会把父目录的 mtime 刷成当前时间。
// 同时也把目录 mode 保持为 mkdirParents 的 0755，不改动源目录权限位
// （源目录若是 0700，改过去会让网关/挂载点整体不可读）。
func applyDirMetadata(m meta.Meta, ctx meta.Context, store object.ObjectStorage, dest string, dirs map[string]struct{}, summary *importSummary) {
	for key := range dirs {
		o, err := store.Head(key + "/")
		if err != nil || o == nil || !hasSourceMtime(o.Mtime()) {
			continue
		}
		inode, st := lookupImportPath(m, ctx, ImportDirPath(dest, key))
		if st != 0 {
			continue
		}
		attr := meta.Attr{Mtime: o.Mtime().Unix(), Mtimensec: uint32(o.Mtime().Nanosecond())}
		if st := m.SetAttr(ctx, inode, meta.SetAttrMtime, 0, &attr); st == 0 {
			summary.DirMtimeKept++
		}
	}
}

// lookupImportPath 在目标卷里按绝对路径查找 inode。
func lookupImportPath(m meta.Meta, ctx meta.Context, p string) (meta.Ino, syscall.Errno) {
	cur := meta.RootInode
	for _, name := range strings.Split(strings.Trim(path.Clean(p), "/"), "/") {
		if name == "" {
			continue
		}
		var inode meta.Ino
		var attr meta.Attr
		if st := m.Lookup(ctx, cur, name, &inode, &attr, false); st != 0 {
			return 0, st
		}
		cur = inode
	}
	return cur, 0
}
```

`importSummary` 定义（`importSummary` 是 Task 1 建立的，这里是**最终形态**，保真计数直接由 `importOne` / `applyDirMetadata` 累加）：

```go
// importSummary is the machine-readable form of one import run.
// Scanned counts candidate objects (directories and internal keys excluded).
// MtimeKept/MtimeMissing/ModeKept/OwnerKept apply to imported files only;
// DirMtimeKept counts directories whose source mtime could be restored.
type importSummary struct {
	DryRun       bool     `json:"dry_run"`
	Dest         string   `json:"dest"`
	Scanned      int      `json:"scanned"`
	Imported     int      `json:"imported"`
	Skipped      int      `json:"skipped"`
	MtimeKept    int      `json:"mtime_kept"`
	MtimeMissing int      `json:"mtime_missing"`
	ModeKept     int      `json:"mode_kept"`
	OwnerKept    int      `json:"owner_kept"`
	DirMtimeKept int      `json:"dir_mtime_kept"`
	Objects      []string `json:"objects,omitempty"`
}
```

新增 `--dir-mtime` 开关（`Value: true` 表示默认开启，关闭用 `--dir-mtime=false`）：

```go
			&cli.BoolFlag{
				Name:  "dir-mtime",
				Usage: "restore source directory mtime after import (default true)",
				Value: true,
			},
```

- [ ] **Step 6: 改造 `importObjects` 的循环**

把 Task 1 建立的循环替换为（前置的 store / spec / blobJSON 逻辑不变）：

```go
	ctx := meta.Background()
	summary := importSummary{DryRun: c.Bool("dry-run"), Dest: dest}
	sample := make([]string, 0, importSampleLimit)
	asJSON := c.Bool("json")
	dirs := make(map[string]struct{})
	ch, err := object.ListAllWithDelimiter(store, "", "", "", true)
	if err != nil {
		return fmt.Errorf("list source: %w", err)
	}
	for obj := range ch {
		if obj == nil || obj.IsDir() || vfs.SkipInternalKey(obj.Key(), skipVolume) {
			continue
		}
		summary.Scanned++
		jp := vfs.JoinImportPath(dest, obj.Key())
		if summary.DryRun {
			// dry-run 只能预判源是否提供 mtime，不能预判写入是否成功。
			if hasSourceMtime(obj.Mtime()) {
				summary.MtimeKept++
			} else {
				summary.MtimeMissing++
			}
			if len(sample) < importSampleLimit {
				sample = append(sample, obj.Key())
			}
			if !asJSON {
				fmt.Println(obj.Key(), "->", jp)
			}
			continue
		}
		st := importOne(m, ctx, jp, obj, blobJSON, &summary)
		switch st {
		case 0:
			summary.Imported++
			collectDirs(obj.Key(), dirs)
		case syscall.EEXIST:
			summary.Skipped++
		default:
			return fmt.Errorf("import %s: %s", jp, st)
		}
	}
	if !summary.DryRun && c.Bool("dir-mtime") && len(dirs) > 0 {
		applyDirMetadata(m, ctx, store, dest, dirs, &summary)
	}
```

后面的收尾（`--json` 打印）保持 Task 1 的形态不动；Task 1 的纯文本分支已经是 `summary.*` 版本，只把保真摘要追加进去：

```go
	fmt.Printf("imported %d, skipped %d, scanned %d -> %s (mtime kept %d, missing %d, dirs %d)\n",
		summary.Imported, summary.Skipped, summary.Scanned, dest,
		summary.MtimeKept, summary.MtimeMissing, summary.DirMtimeKept)
```

- [ ] **Step 7: 两个 overlay 脚本同步拷贝测试文件**

`scripts/apply-juicefs-overlay.ps1` 在 `Copy-Item ... cmd\import.go ...` 之后追加：

```powershell
Copy-Item -Path (Join-Path $src "cmd\import_test.go") -Destination (Join-Path $dst "cmd\import_test.go") -Force
```

`scripts/apply-juicefs-overlay.sh` 在 `cp "$SRC/cmd/import.go" "$DST/cmd/import.go"` 之后追加：

```sh
cp "$SRC/cmd/import_test.go" "$DST/cmd/import_test.go"
```

- [ ] **Step 8: 应用 overlay 并跑测试**

```powershell
./scripts/apply-juicefs-overlay.ps1
cd third_party/juicefs
go test ./cmd/ -run "TestMetadataFor|TestHasSourceMtime|TestImportDirPath|TestIsInternalKey|TestCollectDirs" -count=1
go test ./pkg/vfs/ -run TestSkipInternalKey -count=1
go build ./...
```

期望：保真单测全绿，`TestSkipInternalKey` 保持原有断言不变（拆分后行为等价），`go build ./...` 通过。把结果贴进报告。

- [ ] **Step 9: foyer 透传保真计数**

`server/internal/foyer/import.go` 的 `ImportResult` 追加字段（放在 `Skipped` 与 `Objects` 之间，`Objects` 保持最后以便 `omitempty` 语义清晰）：

```go
	MtimeKept    int      `json:"mtime_kept"`
	MtimeMissing int      `json:"mtime_missing"`
	ModeKept     int      `json:"mode_kept"`
	OwnerKept    int      `json:"owner_kept"`
	DirMtimeKept int      `json:"dir_mtime_kept"`
```

`parseImportSummary` 无需改动（整体 `json.Unmarshal` 已覆盖）。在 `server/internal/foyer/import_test.go` 的解析用例里，把样例 JSON 换成含新字段的版本并断言：

```go
	input := `{"dry_run":false,"dest":"/photos","scanned":3,"imported":2,"skipped":1,"mtime_kept":2,"mtime_missing":0,"mode_kept":2,"owner_kept":1,"dir_mtime_kept":1}`
	// ...
	if got.MtimeKept != 2 || got.MtimeMissing != 0 || got.ModeKept != 2 || got.OwnerKept != 1 || got.DirMtimeKept != 1 {
		t.Fatalf("fidelity = %+v, want mtime 2/0 mode 2 owner 1 dir 1", got)
	}
```

`server/internal/foyer/exec_test.go` 与 `server/internal/foyer/health_test.go` 里 `writeFakeJuice` / `writeFakeImport` 打印的假摘要必须补上这 5 个字段（两个平台分支都要改：Windows 的 Go 小程序与 POSIX 的 shell 分支），否则新断言会失败。

- [ ] **Step 10: Web 展示保真度**

`web/src/api/jfs.ts` 的 `FoyerImportResult` 追加同名字段，最终形态：

```ts
export type FoyerImportResult = {
  dry_run: boolean;
  dest: string;
  scanned: number;
  imported: number;
  skipped: number;
  mtime_kept: number;
  mtime_missing: number;
  mode_kept: number;
  owner_kept: number;
  dir_mtime_kept: number;
  objects?: string[];
};
```

`web/src/components/NewMountModal.tsx`：Task 5 的 `preview` 状态是**扁平**结构（不是 `preview.result`），所以先扩状态类型，再把新字段塞进 `setPreview`：

```tsx
  const [preview, setPreview] = useState<{
    scanned: number;
    objects: string[];
    dest: string;
    mtime_kept: number;
    mtime_missing: number;
  } | null>(null);
```

```tsx
        setPreview({
          scanned: res.scanned,
          objects: res.objects || [],
          dest: res.dest,
          mtime_kept: res.mtime_kept,
          mtime_missing: res.mtime_missing,
        });
```

然后在预检面板的非空分支里，插到「确认后只写元数据…」那段之前：

```tsx
                  <p className="text-[11px] text-slate-500">
                    其中 {preview.mtime_kept} 个对象可保留原始修改时间
                    {preview.mtime_missing > 0 && `，${preview.mtime_missing} 个源未提供时间（将显示为导入时刻）`}
                  </p>
```

`web/src/components/MountManager.tsx`：Task 4 的 `handleResync` 用的是 `window.alert`，`res` 的类型就是 `jfs.FoyerImportResult`，扩类型后可直接加一句保真回执：

```tsx
      window.alert(
        `增量同步完成：新增 ${res.imported}，已存在跳过 ${res.skipped}，扫描 ${res.scanned}\n` +
        `保留原始修改时间 ${res.mtime_kept} 个（缺失 ${res.mtime_missing}），目录时间 ${res.dir_mtime_kept} 个，` +
        `权限 ${res.mode_kept} 个，属主 ${res.owner_kept} 个`
      );
```

不要把保真信息塞进徽标或 tooltip：它是**结果**，不是状态，必须出现在同步回执这一条里，且不依赖颜色也能读全。

- [ ] **Step 11: 端到端验证保真真的生效**

先用 PowerShell 记下源目录的原始时间（作为断言基线）：

```powershell
Get-Item E:\photos\hello.jpg | Select-Object LastWriteTime
```

启动 stack（`docker compose -f deploy/compose.yml --profile juicefs up --build`），在 Web 中选 `Local / NAS` + 「仅导入元数据」+ `E:\photos`，先「预检」再「确认导入」，然后：

1. 文件列表里 `hello.jpg` 的「修改时间」应等于 Step 11 打印的 `LastWriteTime`（**不是**刚才导入的时间）。这是本任务的核心验收点——网关的 `LastModified` 就来自元数据 mtime。
2. 预检面板应显示「N 个对象可保留原始修改时间」且 N 等于目录中文件数。
3. 挂载卡的增量同步回执应显示 `保留原始修改时间 N（缺失 0）`。
4. 反例对照：`docker compose exec` 进容器后对同一目录再导一次到另一个 dest，用 `aws s3api head-object` 或 Web 列表确认第二次导入的 dest 也显示原始时间（说明 `importOne` 的写入顺序没被 immutable 挡住）。
5. 若源是 S3 前缀（二期未开放，可手工 `juicefs import` 验证）：`mtime_missing` 应为 0（S3 有 `LastModified`），`mode_kept` / `owner_kept` 应为 0（S3 不实现 `object.File`），`dir_mtime_kept` 应为 0。
6. 权限位：源里放一个 `run.sh`（0755）和一个 `data.txt`（0644），导入后 `ls -l` 应看到 `r-xr-xr-x` / `r--r--r--`——执行位保留、写位消失。再试 `echo x > /photos/run.sh`，应得到明确的权限错误（而不是"看起来能写但 EPERM"）。

把「源 `LastWriteTime`」与「Web 列表显示的修改时间」两条实际输出贴在报告里，不要只写"验证通过"。

- [ ] **Step 12（可选）: 提交**

```powershell
git add overlays/juicefs/cmd/import.go overlays/juicefs/cmd/import_test.go overlays/juicefs/pkg/vfs/compat.go `
        scripts/apply-juicefs-overlay.ps1 scripts/apply-juicefs-overlay.sh `
        server/internal/foyer/import.go server/internal/foyer/import_test.go server/internal/foyer/exec_test.go `
        web/src/api/jfs.ts web/src/components/NewMountModal.tsx web/src/components/MountManager.tsx
git commit -m "feat(import): preserve source mtime, mode and owner on metadata import"
```

---

## 明确不做（本期）

- **`对账`（reconcile）**：`client.reconcileMount` 仍返回 501，本轮把挂载卡上那个必然报错的按钮移除；它应由后续的 `fsck` 端点取代（`juicefs fsck META --path /photos --repair`）。
- 对象 URI 源导入（放开 `webdav://` / `s3://` / `minio://` 直传）：会让 s3/oss 表单真正可用，但需要先在 foyer 落盘 accessKey/secretKey，属于凭据管理问题，单独一期。
- foyer 管理面鉴权：`gc --delete`、`load`、`restore` 等危险动词的前置条件，单独一期。
- `gc` / `fsck` / `status` / `sync` / `quota` / `dump` / `restore` / `config` 端点与异步 job 框架。
- FastDFS `ObjectStorage` 真实实现（当前 overlay 只有 `Register` 骨架，构造返回 not implemented）。
- 内容层去重与硬链接（每次导入按对象名各建一个 inode，同一对象重复导入到不同 dest 会各占一条元数据）。
- Web 端对导入挂载的写保护拦截（本轮只给徽标与文案提示；是否禁止 upload/覆盖留待与产品确认）。
- **atime 保真**：`object.Object` 接口不暴露 atime（只有 `Key/Size/Mtime/IsDir/IsSymlink/StorageClass`，见 `pkg/object/interface.go:24`），要拿只能对各后端做类型断言 + 平台相关 syscall，收益远小于成本。文件被读取后 JuiceFS 的 atime 会自己更新，不会影响用户对"原始时间"的感知。
- **ctime 保真**：`SetAttrCtime` 存在，但 ctime 语义是"元数据变更时间"，导入本身就是一次变更，强行回写只会制造假象。
- **目录 mode / 属主保真**：目录只回写 mtime，权限位保持 `mkdirParents` 的 0755。源目录若是 0700，照搬会让网关与挂载点整体不可读，收益（无人看目录权限）不抵风险。
- **xattr / ACL 保真**：不迁移源对象的扩展属性与 ACL，只写 `jfs.object` / `jfs.blob` 两个自用 xattr；setuid/setgid/sticky 位也不保留（`Mode().Perm()` 只取 0777，写位再按约束剥掉）。
- **保真的可回滚性**：不提供"重新导入以修正元数据"的单独命令。already-imported 的文件（`EEXIST`）会被跳过，连 mtime 都不会补——需要修正时先删除再重导。

## Spec 覆盖对照

| 来源 | 条目 | 任务 |
|------|------|------|
| 上一轮评估 · 第一梯队 | 导入预检 + 计数回执 | 1 |
| 上一轮评估 · 第一梯队 | 增量重导 | 2（端点）+ 4（UI） |
| 上一轮评估 · 第一梯队 | 只读 / 来源可见 | 4 |
| 上一轮评估 · 顺手补 | foyer 暴露 DELETE/PATCH mounts | 2 + 3 |
| 上一轮评估 · 第一梯队 | 对象 URI 源导入 | 不做（见上） |
| 上一轮评估 · 前置条件 | foyer 鉴权 | 不做（见上） |
| 本轮补充 · 元数据保真 | 导入时沿用源 mtime（Web 列表显示原始时间） | 6 |
| 本轮补充 · 元数据保真 | 源 mode / 属主 best-effort 保留 | 6 |
| 本轮补充 · 元数据保真 | 目录 mtime 二遍回写 + 保真计数回执 | 6 |
| 本轮补充 · 元数据保真 | atime / ctime / 目录权限 / ACL | 不做（见上） |

## Handoff

计划保存于 `docs/superpowers/plans/2026-09-18-foyer-mount-lifecycle-import.md`。

执行方式二选一：

1. **Subagent-Driven（推荐）** — 每个任务派一个新的 subagent，任务之间我做两阶段审查，迭代快、上下文干净。
2. **Inline Execution** — 在当前会话里按 `executing-plans` 批量执行，带检查点。

补充建议：Task 1 与 Task 3 改动文件不重叠，可以并行开工（Task 3 按 Task 1 约定的 `{ok, result:{dry_run,dest,scanned,imported,skipped,objects}}` 形状先写，联调时再对齐真实响应）；Task 2 依赖 Task 1 的 `ImportResult`；Task 4、5 依赖 Task 3 暴露到 Context 的两个函数；Task 6 依赖 Task 1 的 `importSummary`/`importObjects`/`importOne` 与 Task 3 的 `FoyerImportResult`，因此**必须最后做**，且它的 Step 6 会重写 Task 1 建立的循环——执行 Task 6 前先读一遍 Task 1 落地后的实际代码，不要照抄计划里的片段。每个任务都有独立的测试循环，可以在任一步停下而不留半成品。

关于 Task 6 的范围提醒：它改的是 overlay 的 Go 代码，而 `third_party/juicefs` 是 submodule——所有编辑都必须落在 `overlays/juicefs/`，再靠 Step 7 的脚本同步过去；直接改 submodule 内的文件会在下次 apply 时被覆盖，也会污染 submodule 工作区。
