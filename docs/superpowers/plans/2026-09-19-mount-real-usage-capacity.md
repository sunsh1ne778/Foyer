# 挂载源真实用量与容量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「存储挂载源」列表显示每个挂载的真实已用大小/节点数，并让容量进度条基于真实物理数据盘容量，而不是硬编码的 2TB。

**Architecture:** 三处改动。`overlays/juicefs/cmd/usage.go` 新增 `juicefs usage` 机器可读命令，用元数据 `GetSummary`（`DirStats` 快路径）读每个挂载子树的真实 size/inodes，用 `StatFS` + `Format.Capacity` 读卷用量与配额真值。`server/internal/foyer` 把它包装成 `Runner.Usage` 与 `GET /foyer/usage`，并读物理数据盘 `statfs`，按「配额优先、否则物理盘总量」解析出容量分母；启动时读物理盘总量并设一次容量配额（带硬限制安全闸）。`web/src` 把真实 stats/capacity 透传到 `Sidebar`/`MountManager`，删掉 `2TB simulated` 与 `Math.max(pct,4)` 假下限。

**Tech Stack:** Go 1.25（server）、Go 1.23（juicefs overlay，CGO）、React 18 + TypeScript + vitest（web）、Docker Compose。

## Global Constraints

- 不重写 VFS、不改 FUSE、不改 juicefs 内核行为（沿用 `docs/superpowers/plans/2026-09-18-juicefs-distro.md` 的约束）。
- 平台隔离：`syscall.Statfs` 只在 `//go:build linux` 文件里；非 linux 走 fallback 返回错误。`go test ./internal/foyer` 必须在 Windows 开发机上能编译通过。
- overlay 测试只能在 Linux 容器里跑：`third_party/juicefs` 的 cmd 包在 Windows 上编译不了（`CGO_ENABLED=0`，sqlite3/lz4/zstd 的 build constraints 排除全部文件）。统一用 Docker `golang:1.23-bookworm` + `gcc` + `libfuse3-dev` + `CGO_ENABLED=1`，并挂 `foyer-gomodcache`/`foyer-gocache` 两个卷复用缓存。
- 本机 `bash` 指向未配置的 WSL，`sh` 不可用。overlay 用 `scripts/apply-juicefs-overlay.ps1` 落地，`.sh` 版本同步维护供 Dockerfile 构建期使用。
- `format.Capacity` 是**硬限制**（`third_party/juicefs/pkg/meta/quota.go:262`：写入把 used 推过 Capacity 即 ENOSPC）。**绝不**把配额设到低于卷当前已用；宁可跳过也不要把卷写死。
- 「仅导入元数据」会让卷逻辑已用远超物理盘（实测 1.7 TiB vs 物理 1 TiB）。逻辑用量与物理占用是两个量纲，任何地方都不许混用。
- `DirStats` 已在本卷启用（`juicefs config` 显示 `"DirStats": true`）。未启用时 `GetSummary(strict=false)` 会回退到 `doReaddir` 全树遍历并写 warn（慢但正确），不得因此改成 strict。
- 前端 vitest 为 node 环境且只 include `*.test.ts`，组件无 DOM 测试；能测的只有纯函数。
- 控制面 8092 端口当前无鉴权，与既有 `/foyer/stat`、`/foyer/mounts` 一致；本计划不新增鉴权（沿用现状）。
- 新配额/磁盘路径一律走配置项，不硬编码。

---

### Task 1: overlay 新增 `juicefs usage` 命令

**Files:**
- Create: `overlays/juicefs/cmd/usage.go`
- Create: `overlays/juicefs/cmd/usage_test.go`
- Modify: `scripts/apply-juicefs-overlay.sh`（拷贝 + 注册进 `main.go` 的 `Commands`）

**Interfaces:**
- Consumes: `overlays/juicefs/cmd/stat.go` 里已有的 `lookupPathAttr(m, ctx, p) (meta.Ino, meta.Attr, error)` 与 `normalizeVolumePath(p string) string`；`third_party/juicefs/cmd/main.go` 的 `setup0(c, min, max int)` 与 `removePassword(uris ...string)`。
- Produces: 命令 `juicefs usage META-URL [PATH...]`，stdout 一行 JSON，形状见下方 `usageResult`。字段名即接口，server 侧按名解析。

- [ ] **Step 1: 写失败测试**

创建 `overlays/juicefs/cmd/usage_test.go`：

```go
package cmd

import (
	"encoding/json"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

// Inodes 必须与 `juicefs quota get` 的 IUsed 同口径：目录本身也算一个 inode。
func TestPathUsageOfCountsDirsAsInodes(t *testing.T) {
	got := pathUsageOf("/photos/", meta.Summary{Size: 2048000, Length: 1999000, Files: 12, Dirs: 3})
	if got.Path != "/photos" {
		t.Fatalf("path = %q, want /photos", got.Path)
	}
	if got.Inodes != 15 {
		t.Fatalf("inodes = %d, want 15 (files+dirs)", got.Inodes)
	}
	if got.Size != 2048000 || got.Files != 12 || got.Dirs != 3 {
		t.Fatalf("%+v", got)
	}
}

// Capacity 的真值只能来自 Format.Capacity。StatFS 的 totalspace 在未设配额时是
// 合成值（1<<50 起翻倍），拿它当容量会让进度条分母变成一个假的大数。
func TestVolumeUsageOfUsesFormatCapacityNotStatFS(t *testing.T) {
	// total=1<<50 是 StatFS 在未设配额时合成的量，used 由 total-avail 反推。
	got := volumeUsageOf(meta.Format{Capacity: 0}, 1<<50, (1<<50)-1024, 7, 10)
	if got.Capacity != 0 || got.CapacitySet {
		t.Fatalf("未设配额时应报 capacity=0/capacity_set=false: %+v", got)
	}
	if got.Used != 1024 || got.UsedInodes != 7 {
		t.Fatalf("used/used_inodes 必须来自 StatFS 计数: %+v", got)
	}

	set := volumeUsageOf(meta.Format{Capacity: 2 << 40}, 2<<40, (2<<40)-4096, 9, 11)
	if set.Capacity != 2<<40 || !set.CapacitySet {
		t.Fatalf("设了配额应原样带出: %+v", set)
	}
	if set.Avail != (2<<40)-4096 || set.AvailInodes != 11 {
		t.Fatalf("设了配额时 avail 才有意义: %+v", set)
	}
}

func TestUsageResultJSONKeysAreStable(t *testing.T) {
	b, err := json.Marshal(usageResult{
		Volume:    volumeUsageOf(meta.Format{Capacity: 1 << 40}, 1<<40, 1<<39, 5, 6),
		Summaries: []pathUsage{pathUsageOf("/a", meta.Summary{Size: 1, Files: 1})},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"volume", "summaries"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %s", k, b)
		}
	}
	var vol map[string]json.RawMessage
	if err := json.Unmarshal(m["volume"], &vol); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"capacity", "capacity_set", "used", "avail", "used_inodes", "avail_inodes"} {
		if _, ok := vol[k]; !ok {
			t.Fatalf("missing volume key %q in %s", k, b)
		}
	}
}
```

- [ ] **Step 2: 运行测试确认失败（RED）**

overlay 目录不是独立 module，只能先把它当补丁打进 `third_party/juicefs` 做一次红：**只拷测试文件，不拷实现**。

本机 `sh` 指向未配置的 WSL，用 PowerShell 直接拷；`third_party/juicefs` 的 cmd 包在 Windows 编译不了（`CGO_ENABLED=0`，sqlite3/lz4/zstd 的 build constraints 排除全部文件），所以测试一律在 Linux 容器里跑：

```powershell
Copy-Item overlays/juicefs/cmd/usage_test.go third_party/juicefs/cmd/usage_test.go -Force
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go test ./cmd/ -run 'TestPathUsageOf|TestVolumeUsageOf|TestUsageResultJSONKeys' -count=1"
```
Expected: 编译失败 —— `undefined: pathUsageOf`、`undefined: volumeUsageOf`、`undefined: usageResult`。这就是实现缺失的证据（不是笔误造成的失败）。

> 首次运行 apt-get + 依赖下载约 1–3 分钟；`foyer-gomodcache`/`foyer-gocache` 两个卷会让后续运行快很多。

- [ ] **Step 3: 写最小实现**

创建 `overlays/juicefs/cmd/usage.go`：

```go
package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/urfave/cli/v2"
)

// volumeUsage 是卷级用量。Capacity 取 Format.Capacity（配额真值），为 0 表示未设
// 配额——此时 StatFS 的 totalspace 是合成值，绝不能当容量用。
type volumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
}

// pathUsage 是一个卷内路径的真实用量。Size/Inodes 直接来自元数据 DirStats 计数，
// 与 `juicefs quota get` 同源，不需要先设置配额就能读到。
type pathUsage struct {
	Path   string `json:"path"`
	Error  string `json:"error,omitempty"`
	Size   uint64 `json:"size"`
	Length uint64 `json:"length"`
	Files  uint64 `json:"files"`
	Dirs   uint64 `json:"dirs"`
	Inodes uint64 `json:"inodes"`
}

type usageResult struct {
	Volume    volumeUsage `json:"volume"`
	Summaries []pathUsage `json:"summaries"`
}

func cmdUsage() *cli.Command {
	return &cli.Command{
		Name:      "usage",
		Action:    usagePaths,
		Category:  "INSPECTOR",
		Usage:     "Print real space and inode usage of volume paths as JSON",
		ArgsUsage: "META-URL [PATH...]",
		Description: `
Report real used space and inodes, per path, plus the volume-level usage.

Space is read from the metadata DirStats counters (the same counters
`+"`juicefs quota get`"+` reports), so it is instant on huge trees — no data plane
scan. No quota needs to be set beforehand.

Capacity is only reported when a quota is actually configured; an unset quota
prints capacity 0 with capacity_set=false, because the filesystem reports a
synthesized total in that case rather than a real limit.

Output is a single line of JSON so callers can parse it directly.

Examples:
$ juicefs usage redis://localhost
$ juicefs usage redis://localhost /photos /av_20260619`,
	}
}

func usagePaths(c *cli.Context) error {
	// 至少 META-URL；PATH 可为空（只要卷级用量）。
	setup0(c, 1, 0)
	metaURL := c.Args().Get(0)
	paths := c.Args().Slice()[1:]
	removePassword(metaURL)

	conf := meta.DefaultConf()
	conf.NoBGJob = true
	m := meta.NewClient(metaURL, conf)
	format, err := m.Load(true)
	if err != nil {
		return err
	}
	if err := m.NewSession(false); err != nil {
		return err
	}
	defer func() { _ = m.CloseSession() }()

	ctx := meta.Background()
	var total, avail, iused, iavail uint64
	if st := m.StatFS(ctx, meta.RootInode, &total, &avail, &iused, &iavail); st != 0 {
		return fmt.Errorf("statfs: %s", st)
	}

	res := usageResult{
		Volume:    volumeUsageOf(format, total, avail, iused, iavail),
		Summaries: make([]pathUsage, 0, len(paths)),
	}
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		inode, _, err := lookupPathAttr(m, ctx, p)
		if err != nil {
			res.Summaries = append(res.Summaries, pathUsage{Path: normalizeVolumePath(p), Error: err.Error()})
			continue
		}
		var sum meta.Summary
		if st := m.GetSummary(ctx, inode, &sum, true, false); st != 0 {
			res.Summaries = append(res.Summaries, pathUsage{Path: normalizeVolumePath(p), Error: st.Error()})
			continue
		}
		res.Summaries = append(res.Summaries, pathUsageOf(p, sum))
	}

	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(res)
}

// pathUsageOf 把 meta.Summary 折成可序列化快照。Inodes = files + dirs，
// 与 `juicefs quota get` 的 IUsed 同口径。
func pathUsageOf(p string, sum meta.Summary) pathUsage {
	return pathUsage{
		Path:   normalizeVolumePath(p),
		Size:   sum.Size,
		Length: sum.Length,
		Files:  sum.Files,
		Dirs:   sum.Dirs,
		Inodes: sum.Files + sum.Dirs,
	}
}

// volumeUsageOf 折 StatFS 计数与 Format.Capacity。只有 Capacity>0 时 avail 才有
// 意义：未设配额时 StatFS 的 totalspace 是 1<<50 起的合成值。
func volumeUsageOf(format *meta.Format, total, avail, iused, iavail uint64) volumeUsage {
	used := uint64(0)
	if total > avail {
		used = total - avail
	}
	v := volumeUsage{
		Capacity:    format.Capacity,
		CapacitySet: format.Capacity > 0,
		Used:        used,
		UsedInodes:  iused,
	}
	if format.Capacity > 0 {
		v.Avail = avail
		v.AvailInodes = iavail
	}
	return v
}
```

- [ ] **Step 4: 在两个 apply 脚本里注册命令**

先改脚本再应用：apply 脚本负责拷贝 `usage.go` 并把 `cmdUsage()` 注册进 `main.go`，不先改脚本就应用，命令不会被注册。

修改 `scripts/apply-juicefs-overlay.ps1`（本机实际使用的是这个），在 `cmd\stat_test.go` 那两行之后追加：

```powershell
Copy-Item -Path (Join-Path $src "cmd\usage.go") -Destination (Join-Path $dst "cmd\usage.go") -Force
Copy-Item -Path (Join-Path $src "cmd\usage_test.go") -Destination (Join-Path $dst "cmd\usage_test.go") -Force
```

并在 `[IO.File]::WriteAllText($main, $m, $utf8)` **之前**追加（`$m` 是累积变量，顺序不能颠倒）：

```powershell
if ($m -notmatch 'cmdUsage\(\),') {
  $m2 = [regex]::Replace($m, '\t\t\tcmdStat\(\),\r?\n', "`t`t`tcmdStat(),`n`t`t`tcmdUsage(),`n", 1)
  if ($m2 -eq $m) { throw "main.go cmdStat() hook site not found" }
  $m = $m2
}
```

同步修改 `scripts/apply-juicefs-overlay.sh`（Dockerfile 构建期用的是这个）。在文件拷贝段追加两行：

```sh
cp "$SRC/cmd/usage.go" "$DST/cmd/usage.go"
cp "$SRC/cmd/usage_test.go" "$DST/cmd/usage_test.go"
```

在 heredoc 的 python 段，`cmdStat()` 注册之后追加：

```python
if "cmdUsage()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdStat\(\),\r?\n", "\t\t\tcmdStat(),\n\t\t\tcmdUsage(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdStat() hook site not found")
    changed = True
```

- [ ] **Step 5: 应用 overlay 并在容器里跑测试（GREEN）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-juicefs-overlay.ps1
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go test ./cmd/ -run 'TestPathUsageOf|TestVolumeUsageOf|TestUsageResultJSONKeys' -count=1 -v"
```
Expected: PASS（3 个测试），且输出无 stray warning。

- [ ] **Step 6: 验证命令真的能跑起来**

```powershell
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -w /src/third_party/juicefs `
  golang:1.23-bookworm bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null 2>&1 && CGO_ENABLED=1 go build -o /tmp/juicefs-usage . && /tmp/juicefs-usage usage --help"
```
Expected: 输出 `usage` 的 NAME/USAGE/ARGS 段，退出码 0。

- [ ] **Step 7: 提交**

```bash
git add overlays/juicefs/cmd/usage.go overlays/juicefs/cmd/usage_test.go scripts/apply-juicefs-overlay.sh scripts/apply-juicefs-overlay.ps1
git commit -m "feat(juicefs): add usage command reading DirStats counters"
```

---

### Task 2: server 侧 `Runner.Usage`

**Files:**
- Create: `server/internal/foyer/usage.go`
- Create: `server/internal/foyer/usage_test.go`
- Modify: `server/internal/foyer/exec_test.go`（给 `writeFakeJuice` 增加 `usage` 分支）

**Interfaces:**
- Consumes: Task 1 的 `juicefs usage` JSON；`server/internal/foyer/import.go` 的 `parseJSONLine[T](text string) (T, error)`、`truncate(s string, n int) string`；`server/internal/foyer/exec.go` 的 `Runner.cmd`、`lastLine`。
- Produces: `UsageArgs(cfg Config, paths []string) []string`、`(Runner) Usage(cfg Config, paths []string) (UsageResult, error)`、类型 `UsageResult`/`VolumeUsage`/`PathUsage`、`BuildUsageResponse(vol VolumeUsage, disk DiskSpace, diskOK bool, summaries []PathUsage) UsageResponse`、类型 `DiskSpace`/`UsageResponse`/`UsageVolume`。

- [ ] **Step 1: 写失败测试**

创建 `server/internal/foyer/usage_test.go`：

```go
package foyer

import (
	"strings"
	"testing"
)

func TestUsageArgsOmitsPathsWhenNone(t *testing.T) {
	got := strings.Join(UsageArgs(Config{MetaURL: "redis://redis:6379/1"}, nil), " ")
	if got != "usage redis://redis:6379/1" {
		t.Fatalf("got %q", got)
	}
	got = strings.Join(UsageArgs(Config{MetaURL: "redis://x"}, []string{"/a", "/b"}), " ")
	if got != "usage redis://x /a /b" {
		t.Fatalf("got %q", got)
	}
}

func TestParseUsageSkipsLogLines(t *testing.T) {
	text := "2026/09/19 08:33:31 juicefs[656] <INFO>: Ping redis latency: 51.779µs\n" +
		`{"volume":{"capacity":0,"capacity_set":false,"used":1919472140288,"used_inodes":2538,"avail":0,"avail_inodes":0},` +
		`"summaries":[{"path":"/dtest2","size":24576,"length":20480,"files":4,"dirs":2,"inodes":6}]}` + "\n"
	got, err := parseUsage(text)
	if err != nil {
		t.Fatal(err)
	}
	if got.Volume.Used != 1919472140288 || got.Volume.CapacitySet {
		t.Fatalf("volume: %+v", got.Volume)
	}
	if len(got.Summaries) != 1 || got.Summaries[0].Inodes != 6 || got.Summaries[0].Size != 24576 {
		t.Fatalf("summaries: %+v", got.Summaries)
	}
}

func TestParseUsageFailsWithoutJSON(t *testing.T) {
	if _, err := parseUsage("lookup nope: no such file or directory"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunnerUsageParsesFakeBin(t *testing.T) {
	r := Runner{Bin: writeFakeJuice(t, true)}
	res, err := r.Usage(Config{MetaURL: "redis://x"}, []string{"/photos/a"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Volume.Used != 1919472140288 {
		t.Fatalf("volume: %+v", res.Volume)
	}
	if len(res.Summaries) != 1 || res.Summaries[0].Path != "/photos/a" {
		t.Fatalf("%+v", res.Summaries)
	}
}

// 容量解析规则只应有一处：配额优先，否则物理盘总量。
func TestBuildUsageResponsePrefersQuotaOverDisk(t *testing.T) {
	disk := DiskSpace{Total: 1000, Used: 400, Free: 600}

	// 未设配额 -> 用物理盘总量当分母，但 capacity_set 仍须为 false：它报告的是
	// 「卷配置了配额吗」，不是「分母解析出来了吗」。分母可用与否看 Capacity != 0。
	unset := BuildUsageResponse(VolumeUsage{Used: 10, UsedInodes: 3}, disk, true, nil)
	if unset.Volume.CapacitySet {
		t.Fatalf("未设配额时 capacity_set 必须为 false: %+v", unset.Volume)
	}
	if unset.Volume.Capacity != 1000 {
		t.Fatalf("未设配额应回退物理盘总量: %+v", unset.Volume)
	}
	if unset.Volume.DiskTotal != 1000 || unset.Volume.DiskUsed != 400 {
		t.Fatalf("物理盘数字必须原样带出: %+v", unset.Volume)
	}

	// 设了配额 -> 配额优先，且 capacity_set 为真。
	set := BuildUsageResponse(VolumeUsage{Capacity: 2048, CapacitySet: true, Used: 10}, disk, true, nil)
	if !set.Volume.CapacitySet || set.Volume.Capacity != 2048 {
		t.Fatalf("设了配额应优先: %+v", set.Volume)
	}
}

// 物理盘读不到时不能编一个分母。
func TestBuildUsageResponseWithoutDiskLeavesCapacityZero(t *testing.T) {
	got := BuildUsageResponse(VolumeUsage{Used: 10}, DiskSpace{}, false, nil)
	if got.Volume.Capacity != 0 || got.Volume.CapacitySet {
		t.Fatalf("读不到物理盘时应诚实报 0: %+v", got.Volume)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestUsageArgs|TestParseUsage|TestRunnerUsage|TestBuildUsageResponse' -v`
Expected: 编译失败 —— `undefined: UsageArgs`、`undefined: BuildUsageResponse`、`undefined: DiskSpace`。

- [ ] **Step 3: 写最小实现**

创建 `server/internal/foyer/usage.go`：

```go
package foyer

import (
	"fmt"
	"strings"
)

// UsageResult mirrors the JSON printed by `juicefs usage` (overlays/juicefs/cmd/usage.go).
type UsageResult struct {
	Volume    VolumeUsage `json:"volume"`
	Summaries []PathUsage `json:"summaries"`
}

type VolumeUsage struct {
	Capacity    uint64 `json:"capacity"`
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	Avail       uint64 `json:"avail"`
	UsedInodes  uint64 `json:"used_inodes"`
	AvailInodes uint64 `json:"avail_inodes"`
}

type PathUsage struct {
	Path   string `json:"path"`
	Error  string `json:"error,omitempty"`
	Size   uint64 `json:"size"`
	Length uint64 `json:"length"`
	Files  uint64 `json:"files"`
	Dirs   uint64 `json:"dirs"`
	Inodes uint64 `json:"inodes"`
}

// DiskSpace 是物理数据盘的容量快照。Total=0 且 err!=nil 表示这台机器读不到。
type DiskSpace struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// UsageVolume 是 GET /foyer/usage 里的卷级用量，已把「分母」解析好。
type UsageVolume struct {
	// Capacity 是进度条分母：设了配额用配额，否则用物理数据盘总量；都没有则 0。
	Capacity uint64 `json:"capacity"`
	// CapacitySet 报告「卷配置了容量配额吗」，与 CLI 契约同义；**不是**「分母解析出来了
	// 吗」——那看 Capacity != 0 即可。与 VolumeUsage 的同名字段同名不同义：VolumeUsage 是
	// `juicefs usage` 的原始输出，本类型是加工后的 API 载荷，两者不能混用。
	CapacitySet bool   `json:"capacity_set"`
	Used        uint64 `json:"used"`
	UsedInodes  uint64 `json:"used_inodes"`
	DiskTotal   uint64 `json:"disk_total"`
	DiskUsed    uint64 `json:"disk_used"`
	DiskFree    uint64 `json:"disk_free"`
}

type UsageResponse struct {
	Volume    UsageVolume `json:"volume"`
	Summaries []PathUsage `json:"summaries"`
}

// UsageArgs builds `juicefs usage META [PATH...]`. 没有 PATH 时只回报卷级用量。
func UsageArgs(cfg Config, paths []string) []string {
	return append([]string{"usage", cfg.MetaURL}, paths...)
}

func (r Runner) Usage(cfg Config, paths []string) (UsageResult, error) {
	c := r.cmd(UsageArgs(cfg, paths)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return UsageResult{}, fmt.Errorf("juicefs usage: %s", lastLine(msg))
		}
		return UsageResult{}, fmt.Errorf("juicefs usage: %w", err)
	}
	res, perr := parseUsage(text)
	if perr != nil {
		return UsageResult{}, fmt.Errorf("juicefs usage: %w", perr)
	}
	return res, nil
}

func parseUsage(text string) (UsageResult, error) {
	res, err := parseJSONLine[UsageResult](text)
	if err != nil {
		return UsageResult{}, fmt.Errorf("no JSON usage in juicefs output: %s", truncate(text, 200))
	}
	return res, nil
}

// BuildUsageResponse 合并卷用量与物理盘容量。纯函数：容量解析规则（配额优先、
// 否则物理盘、都没有就诚实报 0）只在这一处，别在 handler 里再写一遍。
func BuildUsageResponse(vol VolumeUsage, disk DiskSpace, diskOK bool, summaries []PathUsage) UsageResponse {
	out := UsageResponse{
		Volume: UsageVolume{
			CapacitySet: vol.CapacitySet,
			Used:        vol.Used,
			UsedInodes:  vol.UsedInodes,
			Capacity:    vol.Capacity,
		},
		Summaries: summaries,
	}
	if diskOK {
		out.Volume.DiskTotal = disk.Total
		out.Volume.DiskUsed = disk.Used
		out.Volume.DiskFree = disk.Free
	}
	if out.Volume.Capacity == 0 && diskOK {
		out.Volume.Capacity = disk.Total
	}
	if out.Summaries == nil {
		out.Summaries = []PathUsage{}
	}
	return out
}
```

- [ ] **Step 4: 给 fake juicefs 增加 `usage` 分支**

修改 `server/internal/foyer/exec_test.go` 的 `writeFakeJuice`。`usage` 必须对每个传入路径各产出一条 summary（这样 `TestRunnerUsageParsesFakeBin` 的断言才稳定），卷用量固定为「未设配额」。

POSIX 分支在 `stat` 那行之后插入：

```go
	script += "if [ \"$1\" = usage ]; then shift 2; printf '%s' '{\"volume\":{\"capacity\":0,\"capacity_set\":false,\"used\":1919472140288,\"used_inodes\":2538,\"avail\":0,\"avail_inodes\":0},\"summaries\":['; first=1; for p in \"$@\"; do if [ $first -eq 0 ]; then printf ','; fi; first=0; printf '{\"path\":\"%s\",\"size\":24576,\"length\":20480,\"files\":4,\"dirs\":2,\"inodes\":6}' \"$p\"; done; printf ']}\\n'; exit 0; fi\n"
```

Windows 分支在 `case "stat":` 之后插入：

```go
	case "usage":
		fmt.Print(`{"volume":{"capacity":0,"capacity_set":false,"used":1919472140288,"used_inodes":2538,"avail":0,"avail_inodes":0},"summaries":[`)
		for i, p := range os.Args[3:] {
			if i > 0 {
				fmt.Print(",")
			}
			fmt.Printf(`{"path":"%s","size":24576,"length":20480,"files":4,"dirs":2,"inodes":6}`, p)
		}
		fmt.Println(`]}`)
		os.Exit(0)
```

> `shift 2` 去掉 `usage` 与 META-URL，剩下的才是路径；`os.Args[3:]` 同理。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && go test ./internal/foyer/ -run 'TestUsageArgs|TestParseUsage|TestRunnerUsage|TestBuildUsageResponse' -v`
Expected: PASS（6 个测试）。再跑全包确认没回归：

Run: `cd server && go test ./internal/foyer/`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add server/internal/foyer/usage.go server/internal/foyer/usage_test.go server/internal/foyer/exec_test.go
git commit -m "feat(foyer): parse juicefs usage into Runner.Usage"
```

---

### Task 3: 物理数据盘读取与 `/foyer/usage` 端点

**Files:**
- Create: `server/internal/foyer/disk_linux.go`
- Create: `server/internal/foyer/disk_other.go`
- Create: `server/internal/foyer/disk_linux_test.go`
- Modify: `server/internal/foyer/usage_test.go`（新增 handler 测试）
- Modify: `server/internal/foyer/health.go`（注册 `/foyer/usage`）

**Interfaces:**
- Consumes: Task 2 的 `Runner.Usage`、`BuildUsageResponse`、`DiskSpace`。
- Produces: `StatDisk(path string) (DiskSpace, error)`（linux 真实现，非 linux 返回错误）；`GET /foyer/usage?path=/a&path=/b` → Task 2 的 `UsageResponse` JSON。

- [ ] **Step 1: 写失败测试**

创建 `server/internal/foyer/disk_linux_test.go`：

```go
//go:build linux

package foyer

import (
	"testing"
)

func TestStatDiskReportsRealCapacity(t *testing.T) {
	got, err := StatDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.Total == 0 {
		t.Fatal("total must be non-zero on a mounted filesystem")
	}
	if got.Used > got.Total || got.Free > got.Total {
		t.Fatalf("used/free must fit inside total: %+v", got)
	}
}

func TestStatDiskRejectsMissingPath(t *testing.T) {
	if _, err := StatDisk("/definitely/not/here/foyer"); err == nil {
		t.Fatal("expected error for missing path")
	}
}
```

在 `server/internal/foyer/usage_test.go` 追加 handler 测试。文件头 import 需要补 `encoding/json`、`net/http`、`net/http/httptest`、`runtime`：

```go
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

func TestUsageRouteReturnsResolvedCapacity(t *testing.T) {
	if runtime.GOOS != "linux" {
		// StatDisk 在非 linux 上失败关闭；这条断言只在 Linux CI/容器里真跑。
		t.Skip("statfs assertions are linux-only")
	}
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true), DataDisk: t.TempDir()}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/usage?path=/photos/a&path=/photos/b", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got UsageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Volume.Used != 1919472140288 {
		t.Fatalf("volume used: %+v", got.Volume)
	}
	// 物理盘可读 -> 分母必须非 0。本卷未设配额，所以 capacity_set 仍为 false。
	if got.Volume.Capacity == 0 || got.Volume.DiskTotal == 0 {
		t.Fatalf("物理盘可读时 capacity 必须是真实分母: %+v", got.Volume)
	}
	if len(got.Summaries) != 2 || got.Summaries[0].Path != "/photos/a" {
		t.Fatalf("summaries: %+v", got.Summaries)
	}
}

// 非 linux 上物理盘读不到，端点必须诚实报 capacity=0 而不是编一个数。
func TestUsageRouteWithoutDiskReportsZeroCapacity(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true), DataDisk: ""}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/usage", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got UsageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Volume.Capacity != 0 || got.Volume.CapacitySet {
		t.Fatalf("读不到物理盘时必须报 0: %+v", got.Volume)
	}
}

func TestUsageRouteRejectsNonGet(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true), DataDisk: "/"}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/usage", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rr.Code)
	}
}
```

> `DataDisk: ""` 让 `StatDisk` 必然报错（空路径），因此第二条测试在 Windows 与 Linux 上都能真跑，覆盖「读不到就不编分母」这条分支。第一条用 `runtime.GOOS` 门控，保证 Windows 上仍能编译并跑通其余断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestStatDisk|TestUsageRoute' -v`
Expected: 编译失败 —— `undefined: StatDisk`，以及 `/foyer/usage` 未注册时 404。

- [ ] **Step 3: 写最小实现**

创建 `server/internal/foyer/disk_linux.go`：

```go
//go:build linux

package foyer

import "syscall"

// StatDisk 读物理数据盘的真实容量。挂载源是「仅导入元数据」时，卷的逻辑已用
// （DirStats 按文件长度累加）会远超物理占用，所以分母只能来自真实文件系统。
func StatDisk(path string) (DiskSpace, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskSpace{}, err
	}
	bs := uint64(st.Bsize)
	total := uint64(st.Blocks) * bs
	free := uint64(st.Bavail) * bs
	return DiskSpace{Total: total, Used: total - free, Free: free}, nil
}
```

创建 `server/internal/foyer/disk_other.go`：

```go
//go:build !linux

package foyer

import (
	"errors"
	"runtime"
)

// StatDisk 在非 linux 上不可用。生产容器是 Linux；Windows 只是开发机，
// 需要能编译与跑其余测试，所以这里失败关闭而不是编一个数字。
func StatDisk(string) (DiskSpace, error) {
	return DiskSpace{}, errors.New("statfs unavailable on " + runtime.GOOS)
}
```

- [ ] **Step 4: 注册 `/foyer/usage`**

修改 `server/internal/foyer/health.go`，在 `/foyer/stat` handler 之后插入：

```go
	mux.HandleFunc("/foyer/usage", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var paths []string
		for _, p := range r.URL.Query()["path"] {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
		res, err := run.Usage(cfg, paths)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		disk, derr := StatDisk(cfg.DataDisk)
		writeJSON(w, http.StatusOK, BuildUsageResponse(res.Volume, disk, derr == nil, res.Summaries))
	})
```

- [ ] **Step 5: 加配置项**

修改 `server/internal/foyer/config.go`：在 `Config` 结构体加两个字段。

```go
	MountsFile      string
	// DataDisk 是物理数据盘的挂载路径，用于读真实容量（容器里通常是 "/"）。
	DataDisk string
	// VolumeCapacityGB 非 0 时覆盖自动推导的容量配额（GiB）。
	VolumeCapacityGB uint64
```

在 `LoadConfig` 里加：

```go
		DataDisk:        envOr("FOYER_DATA_DISK_PATH", "/"),
		VolumeCapacityGB: envUint64("FOYER_VOLUME_CAPACITY_GB", 0),
```

并追加 helper：

```go
// envUint64 解析非负整型环境变量；非法或负数一律回退默认值，不让配置错误
// 变成启动期 panic。
func envUint64(key string, def uint64) uint64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
	if err != nil {
		return def
	}
	return n
}
```

> `config.go` 需要补 `strconv`、`strings` 两个 import。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd server && go test ./internal/foyer/ -v`
Expected: 全 PASS（Windows 上 disk/usage-route 两条 linux 断言按 Skip 处理，其余真跑）。

- [ ] **Step 7: 提交**

```bash
git add server/internal/foyer/disk_linux.go server/internal/foyer/disk_other.go server/internal/foyer/disk_linux_test.go server/internal/foyer/usage_test.go server/internal/foyer/health.go server/internal/foyer/config.go
git commit -m "feat(foyer): read physical data disk and serve /foyer/usage"
```

---

### Task 4: 启动时按物理盘设容量配额（安全闸）

**Files:**
- Create: `server/internal/foyer/capacity.go`
- Create: `server/internal/foyer/capacity_test.go`
- Modify: `server/internal/foyer/exec.go`（加 `ConfigArgs` / `Runner.Config`）
- Modify: `server/cmd/foyer/main.go`
- Modify: `deploy/compose.yml`

**Interfaces:**
- Consumes: Task 2 的 `Runner.Usage`；Task 3 的 `StatDisk`、`Config.DataDisk`、`Config.VolumeCapacityGB`。
- Produces: `ConfigArgs(cfg Config, gb uint64) []string`、`(Runner) Config(cfg Config, gb uint64) error`、`EnsureCapacity(cfg Config, r Runner, desiredGB uint64) (CapacityOutcome, error)`、`EnsureVolumeCapacity(cfg Config, r Runner)`。

- [ ] **Step 1: 写失败测试**

创建 `server/internal/foyer/capacity_test.go`：

```go
package foyer

import (
	"strings"
	"testing"
)

func TestConfigArgsPassesGiBAndYes(t *testing.T) {
	got := strings.Join(ConfigArgs(Config{MetaURL: "redis://redis:6379/1"}, 1024), " ")
	want := "config redis://redis:6379/1 --capacity 1024 --yes"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// 已设配额时不许覆盖：运维手动调过的值优先。
func TestEnsureCapacityLeavesExistingQuotaAlone(t *testing.T) {
	bin := writeFakeJuiceUsage(t, 1024, true, 4096)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if out.Applied {
		t.Fatalf("已有配额不应被覆盖: %+v", out)
	}
	if !strings.Contains(out.Skipped, "已设配额") {
		t.Fatalf("skipped reason: %q", out.Skipped)
	}
}

// 硬限制安全闸：目标低于卷当前已用会让全卷写入 ENOSPC，必须只告警不设。
func TestEnsureCapacityRefusesToBrickVolume(t *testing.T) {
	// 已用 2 GiB，目标只给 1 GiB —— 元数据导入场景的典型形状。
	bin := writeFakeJuiceUsage(t, 2<<30, false, 0)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 1)
	if err != nil {
		t.Fatal(err)
	}
	if out.Applied {
		t.Fatalf("目标低于当前已用时绝不能设: %+v", out)
	}
	if !strings.Contains(out.Skipped, "低于当前已用") {
		t.Fatalf("skipped reason: %q", out.Skipped)
	}
}

func TestEnsureCapacityAppliesWhenSafe(t *testing.T) {
	bin := writeFakeJuiceUsage(t, 1024, false, 0)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Applied || out.CapacityGB != 4096 {
		t.Fatalf("%+v", out)
	}
}
```

在 `exec_test.go` 追加一个可参数化卷用量的 fake（`capacitySet` 用来覆盖「已有配额」分支），并给 `exec_test.go` 的 import 补上 `fmt`：

```go
// writeFakeJuiceUsage 让 fake 回指定的卷用量与配额状态，并把 config 调用记到 config.txt。
func writeFakeJuiceUsage(t *testing.T, used uint64, capacitySet bool, capacity uint64) string {
	t.Helper()
	dir := t.TempDir()
	usageJSON := fmt.Sprintf(
		`{"volume":{"capacity":%d,"capacity_set":%t,"used":%d,"used_inodes":3,"avail":0,"avail_inodes":0},"summaries":[]}`,
		capacity, capacitySet, used)
	if runtime.GOOS == "windows" {
		src := `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	switch os.Args[1] {
	case "usage":
		fmt.Println(` + "`" + usageJSON + "`" + `)
	case "config":
		out := filepath.Join(filepath.Dir(os.Args[0]), "config.txt")
		_ = os.WriteFile(out, []byte(strings.Join(os.Args[1:], " ")), 0644)
	}
	os.Exit(0)
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
	path := filepath.Join(dir, "juicefs")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = usage ]; then printf '%s\\n' '" + usageJSON + "'; exit 0; fi\n" +
		"if [ \"$1\" = config ]; then echo \"$@\" > \"$(dirname \"$0\")/config.txt\"; exit 0; fi\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/foyer/ -run 'TestConfigArgs|TestEnsureCapacity' -v`
Expected: 编译失败 —— `undefined: ConfigArgs`、`undefined: EnsureCapacity`、`undefined: writeFakeJuiceUsage`。

- [ ] **Step 3: 写最小实现**

在 `server/internal/foyer/exec.go` 追加：

```go
// ConfigArgs builds `juicefs config META --capacity <GiB> --yes`.
// --capacity 的单位是 GiB（实测 `--capacity 4096` 得到 4 TiB）。
func ConfigArgs(cfg Config, gb uint64) []string {
	return []string{"config", cfg.MetaURL, "--capacity", strconv.FormatUint(gb, 10), "--yes"}
}

func (r Runner) Config(cfg Config, gb uint64) error {
	if err := r.cmd(ConfigArgs(cfg, gb)...).Run(); err != nil {
		return fmt.Errorf("juicefs config: %w", err)
	}
	return nil
}
```

> `exec.go` 需要补 `strconv` import。

创建 `server/internal/foyer/capacity.go`：

```go
package foyer

import (
	"fmt"
	"log"
)

// CapacityOutcome 说明一次容量对齐的结果。Skipped 非空表示没动配额，且为何。
type CapacityOutcome struct {
	Applied    bool
	Skipped    string
	CapacityGB uint64
}

// EnsureCapacity 在卷未设配额时把容量设成 desiredGB（GiB），让 df/StatFS 反映真实
// 磁盘容量而不是合成值。
//
// 安全闸（关键）：format.Capacity 是硬限制——写入把 used 推过 Capacity 会直接
// ENOSPC（third_party/juicefs/pkg/meta/quota.go:262）。「仅导入元数据」会让卷的
// 逻辑已用远超物理盘（实测 1.7 TiB vs 1 TiB），所以目标低于当前已用时必须跳过。
// 宁可不设配额，也不能把卷写死。
func EnsureCapacity(cfg Config, r Runner, desiredGB uint64) (CapacityOutcome, error) {
	if desiredGB == 0 {
		return CapacityOutcome{Skipped: "目标容量为 0"}, nil
	}
	res, err := r.Usage(cfg, nil)
	if err != nil {
		return CapacityOutcome{}, err
	}
	if res.Volume.CapacitySet {
		return CapacityOutcome{Skipped: "卷已设配额，保持运维手动值"}, nil
	}
	if res.Volume.Used > desiredGB<<30 {
		return CapacityOutcome{
			Skipped: fmt.Sprintf("目标 %d GiB 低于当前已用 %d GiB（元数据导入会让逻辑用量远超物理盘）",
				desiredGB, res.Volume.Used>>30),
		}, nil
	}
	if err := r.Config(cfg, desiredGB); err != nil {
		return CapacityOutcome{}, err
	}
	return CapacityOutcome{Applied: true, CapacityGB: desiredGB}, nil
}

// EnsureVolumeCapacity 是启动期入口：读物理数据盘总量推导目标值，失败一律只告警。
// 配额问题不能挡住网关启动。
func EnsureVolumeCapacity(cfg Config, r Runner) {
	desired := cfg.VolumeCapacityGB
	if desired == 0 {
		disk, err := StatDisk(cfg.DataDisk)
		if err != nil {
			log.Printf("capacity: 跳过，读取物理盘 %s 失败: %v", cfg.DataDisk, err)
			return
		}
		desired = disk.Total >> 30
		log.Printf("capacity: 物理盘 %s 总量 %d GiB", cfg.DataDisk, desired)
	}
	out, err := EnsureCapacity(cfg, r, desired)
	if err != nil {
		log.Printf("capacity: 告警: %v", err)
		return
	}
	switch {
	case out.Applied:
		log.Printf("capacity: 已设为 %d GiB", out.CapacityGB)
	case out.Skipped != "":
		log.Printf("capacity: 跳过: %s", out.Skipped)
	}
}
```

- [ ] **Step 4: 接到启动流程**

修改 `server/cmd/foyer/main.go`，在 `EnsureVolume` 之后：

```go
	if err := r.EnsureVolume(cfg); err != nil {
		log.Fatal(err)
	}
	// 音量配额只是让 df/StatFS 反映真实磁盘；失败只告警，不挡网关。
	foyer.EnsureVolumeCapacity(cfg, r)
```

- [ ] **Step 5: compose 接线**

修改 `deploy/compose.yml` 的 `foyer.environment`：

```yaml
      FOYER_MOUNTS_FILE: /var/lib/foyer/mounts.json
      # 物理数据盘路径：容器根即底层磁盘（rustfs 数据卷同一块盘）。
      FOYER_DATA_DISK_PATH: /
      # 容量配额（GiB）。留空/0 = 用 FOYER_DATA_DISK_PATH 的总量自动推导。
      FOYER_VOLUME_CAPACITY_GB: ${FOYER_VOLUME_CAPACITY_GB:-0}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd server && go test ./internal/foyer/ -v`
Expected: 全 PASS。

- [ ] **Step 7: 提交**

```bash
git add server/internal/foyer/capacity.go server/internal/foyer/capacity_test.go server/internal/foyer/exec.go server/cmd/foyer/main.go deploy/compose.yml
git commit -m "feat(foyer): align volume capacity quota to physical data disk at startup"
```

---

### Task 5: 前端取数 —— `foyerUsage` 与 stats 透传

**Files:**
- Modify: `web/src/api/jfs.ts`
- Modify: `web/src/api/mounts.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/mappers.ts`
- Modify: `web/src/api/mounts.test.ts`
- Create: `web/src/api/mappers.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `GET /foyer/usage` JSON。
- Produces: `jfs.foyerUsage(paths?: string[]): Promise<FoyerUsage>`；`mountVolumePath(m: ApiMount): string`；`applyUsage(mounts: ApiMount[], usage: FoyerUsage): void`；`ApiMount.stats?: { total_bytes: number; node_count: number; capacity_bytes: number }`；`mapMount` 透传 `stats`。

- [ ] **Step 1: 写失败测试**

在 `web/src/api/mounts.test.ts` 追加（import 段补 `applyUsage, mountVolumePath` 与 `import type { FoyerUsage } from './jfs'`）：

```ts
import { applyUsage, mountVolumePath } from './mounts';
import type { FoyerUsage } from './jfs';

// 数值取自真实环境实测：卷逻辑已用 ≈ 1.75 TiB、物理盘 1 TiB、/av_20260619 = 596 GiB/822 inodes。
const usageFixture: FoyerUsage = {
  volume: {
    capacity: 1099511627776,
    capacity_set: false,
    used: 1919472140288,
    used_inodes: 2538,
    disk_total: 1099511627776,
    disk_used: 16106127360,
    disk_free: 1083405500416,
  },
  summaries: [
    { path: '/photos', size: 596, length: 590, files: 800, dirs: 22, inodes: 822 },
    {
      path: '/ghost',
      error: 'lookup ghost: no such file or directory',
      size: 0,
      length: 0,
      files: 0,
      dirs: 0,
      inodes: 0,
    },
  ],
};

describe('mountVolumePath', () => {
  it('prefers spec.dest and falls back to /name', () => {
    expect(mountVolumePath({ id: 'a', name: 'a', spec: { dest: '/photos' } })).toBe('/photos');
    expect(mountVolumePath({ id: 'b', name: 'b' })).toBe('/b');
    expect(mountVolumePath({ id: 'c', name: 'c', spec: { dest: '  ' } })).toBe('/c');
  });
});

describe('applyUsage', () => {
  it('attaches real bytes and inodes per mount', () => {
    const list = mergeMounts([{ id: 'photos', name: 'photos', type: 'local', spec: { dest: '/photos' } }]);
    applyUsage(list, usageFixture);

    const photos = list.find(m => m.name === 'photos');
    expect(photos?.stats).toEqual({ total_bytes: 596, node_count: 822, capacity_bytes: 1099511627776 });
  });

  it('gives the volume mount the volume-level numbers', () => {
    const list = mergeMounts([]);
    applyUsage(list, usageFixture);

    expect(list[0].stats).toEqual({
      total_bytes: 1919472140288,
      node_count: 2538,
      capacity_bytes: 1099511627776,
    });
  });

  it('leaves stats absent when the control plane reported an error', () => {
    const list = mergeMounts([{ id: 'ghost', name: 'ghost', type: 'local', spec: { dest: '/ghost' } }]);
    applyUsage(list, usageFixture);
    expect(list.find(m => m.name === 'ghost')?.stats).toBeUndefined();
  });
});
```

创建 `web/src/api/mappers.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mapMount } from './mappers';

describe('mapMount', () => {
  it('carries real stats through so the UI never shows a hardcoded zero', () => {
    const got = mapMount({
      id: 'photos',
      name: 'photos',
      type: 'local',
      status: 'mounted',
      stats: { total_bytes: 596, node_count: 822, capacity_bytes: 4096 },
    });
    expect(got.stats).toEqual({ total_bytes: 596, node_count: 822, capacity_bytes: 4096 });
  });

  it('leaves stats undefined when the control plane gave none', () => {
    expect(mapMount({ id: 'x', name: 'x', type: 'local' }).stats).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/api/mounts.test.ts src/api/mappers.test.ts`
Expected: FAIL —— `applyUsage`/`mountVolumePath` 未导出，`mapMount` 返回的 `stats` 为 undefined。

- [ ] **Step 3: 实现 `foyerUsage`**

在 `web/src/api/jfs.ts` 追加：

```ts
export type FoyerUsageVolume = {
  capacity: number;
  capacity_set: boolean;
  used: number;
  used_inodes: number;
  disk_total: number;
  disk_used: number;
  disk_free: number;
};

export type FoyerUsageSummary = {
  path: string;
  error?: string;
  size: number;
  length: number;
  files: number;
  dirs: number;
  inodes: number;
};

export type FoyerUsage = {
  volume: FoyerUsageVolume;
  summaries: FoyerUsageSummary[];
};

/**
 * 读卷与各挂载子树的真实用量。一次请求带上全部路径：控制面要为每个 `juicefs usage`
 * 起一个进程，逐个请求会把进程启动开销乘上去。
 *
 * 用 URLSearchParams 拼 query：卷内路径可能含 `#`/空格/CJK（如
 * `/av_20260619` 的来源目录名），手工拼串会被下游读成 fragment。
 */
export async function foyerUsage(paths: string[] = []): Promise<FoyerUsage> {
  const qs = new URLSearchParams();
  for (const p of paths) qs.append('path', p);
  const q = qs.toString();
  const res = await fetch(`/foyer/usage${q ? `?${q}` : ''}`);
  if (!res.ok) throw new ApiError((await res.text()) || '读取用量失败', res.status);
  return (await res.json()) as FoyerUsage;
}
```

- [ ] **Step 4: 实现 `mountVolumePath` / `applyUsage`**

修改 `web/src/api/mounts.ts`，追加：

```ts
import type { FoyerUsage } from './jfs';

/** 挂载在卷内的绝对路径：优先 spec.dest，否则 /name。 */
export function mountVolumePath(m: { id?: string; name: string; spec?: Record<string, string> }): string {
  const dest = (m.spec?.dest || '').trim();
  if (dest) return dest.startsWith('/') ? dest : `/${dest}`;
  return `/${m.name}`;
}

/**
 * 把 `/foyer/usage` 的结果贴到挂载列表上。纯函数：路径→stats 的对应关系只在这一处。
 *
 * 控制面报 error 的路径刻意**不**贴 stats：宁可让 UI 显示「无数据」，也不能拿 0
 * 冒充真实用量（那正是这次要修的 bug）。
 */
export function applyUsage(mounts: ApiMount[], usage: FoyerUsage): void {
  const cap = usage.volume.capacity;
  const byPath = new Map<string, FoyerUsage['summaries'][number]>();
  for (const s of usage.summaries || []) {
    if (s && s.path && !s.error) byPath.set(s.path, s);
  }
  for (const m of mounts) {
    if (m.name === jfs.JFS_MOUNT) {
      m.stats = {
        total_bytes: usage.volume.used,
        node_count: usage.volume.used_inodes,
        capacity_bytes: cap,
      };
      continue;
    }
    const s = byPath.get(mountVolumePath(m));
    if (s) m.stats = { total_bytes: s.size, node_count: s.inodes, capacity_bytes: cap };
  }
}
```

- [ ] **Step 5: 扩展 `ApiMount` 并在 `listMounts` 贴 stats**

修改 `web/src/api/client.ts` 的 `ApiMount`：

```ts
export type ApiMountStats = {
  total_bytes: number;
  node_count: number;
  /** 进度条分母：配额优先，否则物理数据盘总量；0 表示拿不到。 */
  capacity_bytes: number;
};

export type ApiMount = {
  id: string;
  name: string;
  type: string;
  spec?: Record<string, string>;
  status?: string;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
  stats?: ApiMountStats;
};
```

修改 `listMounts`：

```ts
export async function listMounts(): Promise<{ mounts: ApiMount[] }> {
  await jfs.headBucket();
  let extra: ApiMount[] = [];
  try {
    extra = await jfs.foyerMounts();
  } catch {
    /* foyer 目录暂时不可用时仍暴露卷挂载 */
  }
  const merged = mergeMounts(extra);
  // 真实用量是加分项：控制面读不到时保留挂载列表，stats 缺席，UI 不画进度条。
  try {
    const paths = merged.filter(m => m.name !== jfs.JFS_MOUNT).map(mountVolumePath);
    applyUsage(merged, await jfs.foyerUsage(paths));
  } catch {
    /* ignore */
  }
  return { mounts: merged };
}
```

> `client.ts` 的 import 行改为 `import { applyUsage, mergeMounts, mountVolumePath } from './mounts';`

- [ ] **Step 6: 让 `mapMount` 透传 stats**

修改 `web/src/api/mappers.ts` 的 `mapMount`，在 return 里加一行：

```ts
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || new Date().toISOString(),
    stats: raw.stats,
```

并在 `web/src/types.ts` 的 `Mount.stats` 里补 `capacity_bytes`：

```ts
  stats?: {
    total_bytes: number;
    node_count: number;
    /** 进度条分母（配额优先，否则物理盘）；0 或缺席时不画进度条。 */
    capacity_bytes?: number;
    last_reconciled?: string;
  };
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS，tsc 无错。

- [ ] **Step 8: 提交**

```bash
git add web/src/api/jfs.ts web/src/api/mounts.ts web/src/api/client.ts web/src/api/mappers.ts web/src/types.ts web/src/api/mounts.test.ts web/src/api/mappers.test.ts
git commit -m "feat(web): fetch real mount usage and pipe it into mount models"
```

---

### Task 6: UI 去掉假容量与假进度条

**Files:**
- Create: `web/src/utils/capacity.ts`
- Create: `web/src/utils/capacity.test.ts`
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/src/components/MountManager.tsx`

**Interfaces:**
- Consumes: Task 5 的 `Mount.stats.total_bytes/node_count/capacity_bytes`。
- Produces: `usagePercent(usedBytes: number, capacityBytes: number): number`。

- [ ] **Step 1: 写失败测试**

创建 `web/src/utils/capacity.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { usagePercent } from './capacity';

describe('usagePercent', () => {
  it('computes a clamped percentage', () => {
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(150, 100)).toBe(100);
  });

  it('returns 0 when capacity is unknown, never a fake floor', () => {
    // 旧实现是 Math.max(pct, 4)，把 0 也画成 4% —— 这正是「假的」。
    expect(usagePercent(12345, 0)).toBe(0);
    expect(usagePercent(12345, -1)).toBe(0);
    expect(usagePercent(12345, Number.NaN)).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/utils/capacity.test.ts`
Expected: FAIL —— `Failed to resolve import "./capacity"`。

- [ ] **Step 3: 写最小实现**

创建 `web/src/utils/capacity.ts`：

```ts
/**
 * 已用 ÷ 容量的整数百分比。
 *
 * 容量未知（0/负数/NaN）时返回 0，且调用方应据此**不画**进度条：旧实现用
 * `Math.max(pct, 4)` 给 0 也画 4%，再加上硬编码的 2TB 分母，整条进度条都是假的。
 */
export function usagePercent(usedBytes: number, capacityBytes: number): number {
  if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) return 0;
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 0;
  return Math.min(100, Math.round((usedBytes / capacityBytes) * 100));
}
```

- [ ] **Step 4: 接入 Sidebar**

修改 `web/src/components/Sidebar.tsx`：

把假容量段：
```tsx
          const usedBytes = m.stats?.total_bytes || 0;
          const capacityBytes = 2 * 1024 * 1024 * 1024 * 1024; // 2TB simulated capacity
          const pct = Math.min(100, Math.round((usedBytes / capacityBytes) * 100));
```
替换为：
```tsx
          const usedBytes = m.stats?.total_bytes || 0;
          // 真实分母来自控制面（配额优先，否则物理数据盘总量）；拿不到就不画进度条。
          const capacityBytes = m.stats?.capacity_bytes || 0;
          const pct = usagePercent(usedBytes, capacityBytes);
```

把用量行：
```tsx
              <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>{colors.label}</span>
                <span>{formatBytes(usedBytes)}</span>
              </div>
```
替换为：
```tsx
              <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>{colors.label}</span>
                <span
                  title={
                    capacityBytes > 0
                      ? `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}（${pct}%）`
                      : '控制面未返回用量'
                  }
                >
                  {m.stats ? formatBytes(usedBytes) : '—'}
                </span>
              </div>
```

把进度条块：
```tsx
              {/* Mini progress bar */}
              <div className="w-full h-1 bg-slate-200 rounded-full mt-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full ${isSelected ? 'bg-indigo-600' : 'bg-slate-400'}`}
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
```
替换为：
```tsx
              {/* 只有拿到真实容量才画进度条；没有分母时宁可不画。 */}
              {capacityBytes > 0 && (
                <div className="w-full h-1 bg-slate-200 rounded-full mt-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isSelected ? 'bg-indigo-600' : 'bg-slate-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
```

并在 import 段加：
```tsx
import { usagePercent } from '../utils/capacity';
```

- [ ] **Step 5: 接入 MountManager**

修改 `web/src/components/MountManager.tsx` 的 metrics 段：

```tsx
          const usedBytes = m.stats?.total_bytes || 0;
```
之后加：
```tsx
          const capacityBytes = m.stats?.capacity_bytes || 0;
          const pct = usagePercent(usedBytes, capacityBytes);
```

把「Storage Metrics」块：
```tsx
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-150 grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <span className="text-slate-400 text-[11px] block">已索引对象</span>
                    <span className="font-bold text-slate-800 font-mono">{m.stats?.node_count || 0} 个</span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[11px] block">占用空间</span>
                    <span className="font-bold text-slate-800 font-mono">{formatBytes(usedBytes)}</span>
                  </div>
                </div>
```
替换为：
```tsx
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-150 grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <span className="text-slate-400 text-[11px] block">已索引对象</span>
                    <span className="font-bold text-slate-800 font-mono">
                      {m.stats ? `${m.stats.node_count} 个` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[11px] block">占用空间</span>
                    <span className="font-bold text-slate-800 font-mono">
                      {m.stats ? formatBytes(usedBytes) : '—'}
                    </span>
                  </div>
                </div>

                {capacityBytes > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono mb-1">
                      <span>占容量 {pct}%</span>
                      <span>
                        {formatBytes(usedBytes)} / {formatBytes(capacityBytes)}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-600" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )}
```

并在 import 段加：
```tsx
import { usagePercent } from '../utils/capacity';
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS，tsc 无错。

- [ ] **Step 7: 提交**

```bash
git add web/src/utils/capacity.ts web/src/utils/capacity.test.ts web/src/components/Sidebar.tsx web/src/components/MountManager.tsx
git commit -m "fix(web): drive mount capacity UI from real numbers"
```

---

### Task 7: 端到端验证（真实环境）

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-mount-real-usage-capacity.md`（把实测值记进本任务的 Notes）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 一份可复现的验证记录。

- [ ] **Step 1: 重建并起容器**

Run:
```powershell
.\scripts\run-foyer.ps1
```
Expected: 镜像重建成功，`foyer-1` 日志出现 `capacity: 物理盘 / 总量 N GiB` 与 `capacity: 已设为 N GiB`（或明确的跳过原因）。

- [ ] **Step 2: 核对控制面真实数值**

Run:
```powershell
curl.exe -s "http://127.0.0.1:8092/foyer/usage?path=/av_20260619&path=/dtest2&path=/host"
```
Expected: `volume.used` ≈ 1.9e12（逻辑已用）、`volume.disk_total` ≈ 1.1e12（真实物理盘）、`volume.capacity` 等于二者中被选中的分母；`summaries[0].size` ≈ 596 GiB、`inodes` 822（与 `juicefs quota get` 交叉核对一致）。

交叉核对（可选，会设置再删除临时配额）：
```powershell
docker exec deploy-foyer-1 juicefs quota set redis://redis:6379/1 --path /av_20260619 --capacity 0 --inodes 0
docker exec deploy-foyer-1 juicefs quota get redis://redis:6379/1 --path /av_20260619
docker exec deploy-foyer-1 juicefs quota delete redis://redis:6379/1 --path /av_20260619
```

- [ ] **Step 3: 核对容量配额已生效且没有把卷写死**

Run:
```powershell
docker exec deploy-foyer-1 juicefs config redis://redis:6379/1 | Select-String capacity
docker exec deploy-foyer-1 juicefs status redis://redis:6379/1 | Select-String "Capacity|UsedSpace|AvailableSpace"
```
Expected: `Capacity` 非 0 且 **≥ `UsedSpace`**。这是安全闸生效的证据：写入检查是 `used + space > Capacity`（`quota.go:262`），只要 `Capacity ≥ UsedSpace` 就不会因为配额被拒。

再真写一个对象穿过网关验证写入可用（用 rustfs-init 那个自带 aws cli 的镜像，挂到 compose 网络）：

```powershell
"capacity-gate-probe" | docker run --rm -i --network deploy_default `
  -e AWS_ACCESS_KEY_ID=foyerak -e AWS_SECRET_ACCESS_KEY=foyersecret -e AWS_DEFAULT_REGION=us-east-1 `
  amazon/aws-cli --endpoint-url http://foyer:9002 s3 cp - s3://foyer/capacity-gate-probe.txt
docker exec deploy-foyer-1 juicefs quota get redis://redis:6379/1 --path /capacity-gate-probe.txt 2>$null
docker run --rm --network deploy_default `
  -e AWS_ACCESS_KEY_ID=foyerak -e AWS_SECRET_ACCESS_KEY=foyersecret -e AWS_DEFAULT_REGION=us-east-1 `
  amazon/aws-cli --endpoint-url http://foyer:9002 s3 rm s3://foyer/capacity-gate-probe.txt
```

Expected: `upload` 成功、随后 `delete` 成功。若 PUT 返回 `ENOSPC`/`No space left`，说明 `Capacity < UsedSpace`，安全闸失效，**必须停下来修 Task 4**。

- [ ] **Step 4: 浏览器核对 UI**

打开 Web，进入「挂载」页与左侧栏，确认：
- 每个挂载显示真实百分比大小的占用空间与节点数（不再是 0 B / 0 个）。
- 进度条有真实分母；控制面读不到用量时该条**不出现**（而不是画 4%）。
- 「存储挂载表」详情卡里的「占容量 N%」与 `已用 / 容量` 文本一致。

若某挂载仍显示 `—`，检查 `/foyer/usage` 里该路径是否带 `error`（命中即为控制面如实回报，不是前端 bug）。

- [ ] **Step 5: 记录实测值**

把 Step 2/3 的真实输出贴进本文件末尾的 `## Verification Notes` 段落（含日期与容器版本），供后续回归对照。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/plans/2026-09-19-mount-real-usage-capacity.md
git commit -m "docs: record end-to-end verification for mount usage/capacity"
```

---

## Verification Notes

**2026-09-19 21:00（修订后口径：进度条 = 池实时占用）。分支 `feat/foyer-mount-lifecycle-import`，HEAD `6b77376`，镜像 `deploy-foyer:latest`（容器 `deploy-foyer-1`，juicefs `1.3.0+unknown`）。**

> 下面 17:53 那一节记录的是**已被否决的额度设计**，保留作背景；结论以本节为准。

启动日志里配额那两行已随配额机器一起删除，只剩：

```
12:48:13 foyer gateway 0.0.0.0:9002 volume=foyer
12:48:13 foyer admin on :8092
```

`GET /foyer/usage?path=/host&path=/dtest2&path=/av_20260619` → HTTP 200：

```json
{"volume":{"used":2433243119616,"used_inodes":3323,"disk_total":1081101176832,"disk_used":24706756608,"disk_free":1001402064896},
 "summaries":[
   {"path":"/host","size":12288,"length":8,"files":1,"dirs":2,"inodes":3},
   {"path":"/dtest2","size":28672,"length":9,"files":3,"dirs":4,"inodes":7,"disk_total":1903616323584,"disk_used":1659784339456,"disk_free":243831984128},
   {"path":"/av_20260619","size":576797478912,"length":576795279476,"files":578,"dirs":222,"inodes":800,"disk_total":2000381014016,"disk_used":921854009344,"disk_free":1078527004672}]}
```

`/host` **不带** `disk_*`（它没绑进容器，读不到池）—— 设计内的诚实退化：不画条，不拿 0 冒充。

**池占用口径与 `df` 逐字节对齐**（API `disk_used` vs 容器内 `df -B1` 的 Used）：

| 挂载 | API `disk_used` | `df` Used | 一致 |
|---|---|---|---|
| 卷（`/`） | 24706756608 | 24706756608 | ✓ |
| `/dtest2`（`E:\`） | 1659784339456 | 1659784339456 | ✓ |
| `/av_20260619`（`G:\`） | 921854009344 | 921854009344 | ✓ |

**UI 将渲染的进度条**（`usagePercent(pool_used, pool_total)`）：

| 行 | 逻辑用量 | inodes | 池已用 / 总量 | 条 |
|---|---|---|---|---|
| 卷 `foyer` | 2266.1 GiB | 3323 | 23.0 / 1006.9 GiB | **2%** |
| `/host` | 0 GiB | 3 | — | **不画条**（池未知） |
| `/dtest2` | 0 GiB | 7 | 1545.8 / 1772.9 GiB | **87%** |
| `/av_20260619` | 537.2 GiB | 800 | 858.5 / 1863.0 GiB | **46%** |

`/dtest2` 那一行正是旧口径看不见的：逻辑用量近乎 0，但它依赖的 `E:` 已 87% 满、只剩 227 GiB。

### 已知未验证（修订后）

- **UI 渲染仍未在浏览器中核对**：无浏览器自动化工具，且仓库 vitest 为 node 环境（无 DOM 测试设施，只 include `*.test.ts`）。上表系按下发载荷与 `usagePercent` 语义手算，不是看渲染结果得出的。

---

**2026-09-19 17:53（本地时区）。分支 `feat/foyer-mount-lifecycle-import`，HEAD `500ba91`，镜像 `deploy-foyer:latest`（容器 `deploy-foyer-1`，juicefs `1.3.0+unknown`）。**

> 首次实测发现运行中的镜像早于 Task 3/4：`grep -ac 'foyer/usage' /usr/local/bin/foyer` 返回 `0`，`GET /foyer/usage` 返回 404。原因是用户在 Task 3 提交（17:32:41）前后跑了 `run-foyer.ps1`，构建在源码落盘前就 `COPY server` 了。重建后同一检查为 `foyer/usage` = 2、`capacity: ` = 4，端点恢复正常。**教训：改后端后要确认镜像真的重建，别只看容器在跑。**

### 启动日志（容量安全闸）

```
2026/09/19 09:53:47 capacity: 物理盘 / 总量 1006 GiB
2026/09/19 09:53:47 capacity: 跳过: 目标 1006 GiB 低于当前已用 2266 GiB（元数据导入会让逻辑用量远超物理盘）
2026/09/19 09:53:47 foyer gateway 0.0.0.0:9002 volume=foyer
2026/09/19 09:53:47 foyer admin on :8092
```

安全闸按设计**跳过**：本卷逻辑已用（2266 GiB）> 物理盘总量（1006 GiB），照设会让全卷写入 ENOSPC（`quota.go:262`）。跳过即成功路径，不是失败。因此 `capacity_set=false`、`capacity` 回退到 `disk_total`。

### 控制面实测

`GET http://127.0.0.1:8092/foyer/usage?path=/host&path=/dtest2&path=/av_20260619` → HTTP 200

```
volume: capacity=1006.9 GiB   capacity_set=false   used=2266.1 GiB (2.21 TiB)   used_inodes=3323
disk:   total=1006.9 GiB      used=73.8 GiB        free=933 GiB                 => 真实磁盘占用 7.3%

/host          size=      0.0 GiB   inodes=    3
/dtest2        size=      0.0 GiB   inodes=    7
/av_20260619   size=    537.2 GiB   inodes=  800
```

多路径单次请求正常，形状与前端 `listMounts` 的调用一致。

### 写入未被配额写死（安全闸的判定依据）

用自带 aws cli 的镜像穿过网关写入：

```
-- PUT --          （成功，无 ENOSPC）
-- LS --           2026-09-19 09:54:59         15 capacity-gate-probe.txt
-- RM --           delete: s3://foyer/capacity-gate-probe.txt
```

对象确实落库（LS 可见），随后删除成功。因为安全闸没设配额，`format.Capacity` 仍为 0，不存在写入硬限制。

### 已知未验证

- **UI 渲染未在浏览器中核对**：无浏览器自动化工具，且仓库 vitest 为 node 环境（无 DOM 测试设施）。上表百分比是按下发数据与 `usagePercent` 语义手算的，不是看渲染结果得出的。

## 已知取舍

- **逻辑用量与池占用是两个量纲，刻意分开**：`summaries[].size` 是元数据逻辑大小（`align4K(文件长度)` 累加），`disk_*` 是所依赖那块物理盘的实时占用。「仅导入元数据」时前者统计的是宿主盘上已存在的文件，与 JuiceFS 实际占的对象存储空间无关。
  **进度条只用池占用**（`disk_used / disk_total`）；逻辑用量只作数字展示，且 UI 把条标注为「所依赖磁盘的占用」并显示池自己的已用/总量，两者不可能被读成同一个量。
  实测（2026-09-19 21:00）：`/dtest2` 逻辑近乎 0 但池占用 **87%**（`E:` 只剩 227 GiB）；`/av_20260619` 逻辑 537.2 GiB、池占用 **46%**；卷逻辑 2.21 TiB、池占用 **2%**。`/dtest2` 那一行正体现了旧口径看不见的事。
- **不记录任何额度/配额**：额度是静态快照，而被挂载目录依赖的是共享且动态的磁盘资源（同一块盘上还有别的目录在长），写死的额度立刻失真。分母每次请求现场 statfs；读不到池（如 `/host` 未绑进容器）就**不给 `disk_*`、不画条**，UI 显示 `—`（绝不拿 0 冒充）。
- **占用口径与 `df` 对齐**：`Used = Blocks - Bfree`（文件真实占用，同 `df` 的 Used），`Free = Bavail`（可写余量，同 `df` 的 Avail）；`Used + Free ≠ Total` 的差额是 ext4 保留块，属正确行为。曾用 `Bavail` 反推 `Used` 会把保留块算成已用（`/` 上多报 ~51 GiB），已修正，勿改回。
- **池的解析目前只支持 `mode=metadata`**：此时文件仍在源盘上，源盘就是依赖的池（由 `spec.container` 现场 statfs 得到）。将来若支持整卷复制（数据落到对象存储），依赖的池应改为 `cfg.DataDisk` —— `poolPathFor` 里有注释点明，届时必须一并改。
- **`dest → 池` 是精确匹配**：请求挂载的**子路径**（如 `/av_20260619/sub`）拿不到池、因此不画条。前端只请求挂载根，当前无影响；接口本身是通用的，属已知限制。
- **配额只在启动时对齐一次**：运行中物理盘变化（扩容）不会自动跟进，需重启或 `FOYER_VOLUME_CAPACITY_GB` 显式覆盖。这是刻意的——避免运行中改硬限制。
- **对象存储类挂载（s3/minio/oss/fastdfs）**：`client.ts` 目前拒绝创建，且对象存储无通用总容量 API；这些类型只会显示真实已用大小、不画进度条。
- **控制面 8092 仍无鉴权**：与新端点的既有约定保持一致，未在本计划中收紧。
