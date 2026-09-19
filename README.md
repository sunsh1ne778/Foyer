# Foyer（FileStore 文件平台）

以 **JuiceFS** 为存储底座的文件平台：官方 JuiceFS 管元数据与数据平面，`foyer` 进程同时提供
**S3 Gateway** 与**控制面 API**，`overlays/juicefs` 提供发行版增强命令，`web/` 是 React 控制台。

仓库里同时保留早期 **filestore**（PostgreSQL + `/v1` OpenAPI）那条线，见文末「两条线」。

## 目录结构

```text
Foyer/
├── overlays/juicefs/       # JuiceFS 发行版增强（真源）：cmd/ 与 pkg/ 覆盖层
├── third_party/juicefs/    # 官方 JuiceFS v1.3.0（submodule，勿直接编辑）
├── server/
│   ├── cmd/foyer/          # 控制面 + S3 Gateway 监督进程（当前主线）
│   ├── cmd/server/         # filestore API 进程（:8090，/v1）
│   ├── cmd/worker/         # filestore asynq 异步任务
│   ├── cmd/cli/            # filestore 本机 CLI（只走 /v1，不直连存储）
│   └── internal/foyer/     # 控制面实现：挂载、导入、用量、检索、浏览…
├── web/                    # React + Vite 控制台
├── deploy/                 # compose.yml、compose.host-drives.yml、foyer 镜像、迁移
├── scripts/                # 开发与运维脚本（PowerShell）
├── api/openapi.yaml        # filestore /v1 契约
├── configs/                # filestore 进程配置（server.yml、env.example）
└── docs/                   # 设计与实现文档（specs/ 与 plans/）
```

## 快速开始（JuiceFS 主线）

前提：Docker Desktop、Go 1.25+、Node 20+。

```powershell
git submodule update --init --recursive
.\scripts\run-foyer.ps1
```

该脚本会：更新 submodule → 生成盘符绑定（`deploy/compose.host-drives.yml`）→
`docker compose --profile juicefs up --build`。

| 用途 | 地址 | 凭据 |
|------|------|------|
| S3 Gateway | http://127.0.0.1:19002 | `foyerak` / `foyersecret` |
| 控制面 API | http://127.0.0.1:8092 | 无（仅本机） |
| 控制台（Vite） | http://localhost:3000 | `foyerak` / `foyersecret` |

控制台单独起（网关已在跑时不必重复构建镜像）：

```powershell
cd web
npm install --legacy-peer-deps
npm run dev
```

登录用**网关的 AK/SK**（默认 `foyerak` / `foyersecret`，即 compose 里的
`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`），不是 `admin/changeme` —— 后者是旧 filestore `/v1` 的账号。

### 验证 S3 通路

```powershell
$env:AWS_ACCESS_KEY_ID = "foyerak"
$env:AWS_SECRET_ACCESS_KEY = "foyersecret"
$env:AWS_DEFAULT_REGION = "us-east-1"
echo hello | Out-File -Encoding ascii hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 mb s3://foyer
aws --endpoint-url http://127.0.0.1:19002 s3 cp hello.txt s3://foyer/hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 cp s3://foyer/hello.txt hello-back.txt
Get-Content hello-back.txt
```

成功：读回内容含 `hello`。若 `mb` 报已存在，直接 `cp`。

`mc` 等价：`mc alias set foyer http://127.0.0.1:19002 foyerak foyersecret`，然后
`mc cp hello.txt foyer/foyer/hello.txt`。

### 验证控制面

```powershell
curl.exe -s "http://127.0.0.1:8092/foyer/health"
curl.exe -s "http://127.0.0.1:8092/foyer/mounts"
curl.exe -s "http://127.0.0.1:8092/foyer/usage?path=%2Fhost"
curl.exe -s "http://127.0.0.1:8092/foyer/search?q=host"
```

## 控制台能力

- **文件**：浏览 / 上传 / 下载 / 新建目录 / 删除 / 复制 / 移动；属性抽屉（真实 mtime 取自控制面）。
- **深度检索**：跨**全部挂载**按**名称**递归查找文件与目录，结果在列表区域以独立视图展示，
  客户端分页，可「跳转」到命中所在目录并选中该行。
- **存储挂载**：本地目录挂载的完整生命周期——导入前预检、导入后真实计数、增量重导、改名 / 停用 / 删除；
  仅导入元数据，并尽量沿用源对象的原始 mtime / mode / 属主。
- **本地目录选择器**：新增挂载时从已绑定盘符逐级选择，不必手填绝对路径。
- **用量**：每个挂载的真实已用大小与节点数；进度条是**所依赖物理盘**的实时占用率。
- **导出报表**：把挂载源或挂载内目录的元数据导出为 `foyer.metadata-report/v1` 的 JSON / CSV 只读报表。
- **Web CLI**：浏览器内终端（`ls` / `stat` / `mkdir` / `rm` / `cp` / `mv` / `job` / `mount` / `help` / `clear`，支持 `--json`）。
- **任务**：异步作业监控。

## 控制面 API（:8092）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/foyer/health` | 进程、卷与宿主盘符健康 |
| GET | `/foyer/stat?path=` | 单路径元数据属性 |
| GET | `/foyer/usage?path=&path=` | 卷级 + 每个 path 的真实用量；带 `disk_*` 表示该 path 所依赖的物理盘 |
| GET | `/foyer/search?q=&path=&case=` | 按名称递归检索，返回 `matches` / `scanned` / `truncated` |
| GET | `/foyer/browse?path=` | 目录选择器的盘符与目录列举（限制在绑定根内，拒绝越界与符号链接逃逸） |
| GET / POST / PATCH / DELETE | `/foyer/mounts[/<id>]` | 挂载表增删改查；`POST /foyer/mounts/<id>/resync` 增量重导 |
| POST | `/foyer/import` | 导入预检（不改元数据） |

`FOYER_SEARCH_MAX_RESULTS`（默认 `0` = 不限）是检索命中的**安全阀**，不是分页机制——分页在前端做。

## juicefs 增强命令（overlay）

`third_party/juicefs` 是 **submodule**，改动不被父仓库跟踪，**不要直接编辑**。
增强写在 `overlays/juicefs`，由脚本注入，两个版本必须同步维护：

- `scripts/apply-juicefs-overlay.ps1` —— 本机（Windows）
- `scripts/apply-juicefs-overlay.sh` —— `deploy/foyer/Dockerfile` 构建期

| 命令 | 说明 |
|------|------|
| `juicefs import META-URL SRC [DEST] [--dry-run] [--json] [--dir-mtime]` | 把已有对象按**仅元数据**导入，尽量沿用源 mtime / mode / 属主 |
| `juicefs stat META-URL PATH...` | 逐行 JSON 输出元数据属性 |
| `juicefs usage META-URL [PATH...]` | 真实空间与 inode 用量（卷级 + 每个 path） |
| `juicefs find META-URL [PATH...] --name <kw> [--case-sensitive] [--limit N]` | 按**名称**递归检索，单行 JSON |
| `juicefs unflag META-URL PATH... [--dry-run] [--json]` | 清除 immutable / append 标志，让锁定条目可再删除 |

`find` / `usage` / `stat` 只读元数据：不扫数据平面、不需要配额。

## 测试

```powershell
# 控制面（Go）
cd server; go build ./...; go vet ./internal/foyer/ ./cmd/foyer/; go test ./internal/foyer/

# 控制台（TS）
cd web; npx tsc --noEmit; npx vitest run
```

Overlay 的测试**只能在 Linux 容器里跑**：`third_party/juicefs` 的 `cmd` 包在 Windows 上编译不了
（`CGO_ENABLED=0` 时 sqlite3 / lz4 / zstd 的 build constraints 会排除全部文件）。
先在本机跑过 `scripts/apply-juicefs-overlay.ps1` 把 overlay 注入工作树，再挂载该工作树进容器：

```powershell
docker run --rm -v "e:/workspace-dev/Foyer:/src" `
  -v foyer-gomodcache:/go/pkg/mod -v foyer-gocache:/root/.cache/go-build `
  -e GOPROXY=https://goproxy.cn,direct -e CGO_ENABLED=1 `
  -w /src/third_party/juicefs golang:1.23-bookworm `
  bash -c "apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libfuse3-dev >/dev/null && go test ./cmd/ -run 'TestMatchName|TestWalkFind|TestSearchResultJSONKeys|TestPathUsageOf|TestVolumeUsageOf|TestUsageResultJSONKeys|TestNormalizeVolumePath|TestStatTypeString|TestStatResultOf|TestStatResultJSONKeys|TestStatResultErrorShape|TestMetadataFor|TestHasSourceMtime|TestImportDirPath|TestDirKeyFromObject|TestHasLockingFlag|TestClearFlags|TestReportUnflagFormats' -count=1"
```

成功输出 `ok github.com/juicedata/juicefs/cmd`（覆盖五个增强命令的 29 个用例）。

**两点必须注意**，否则会误判成回归：

1. **必须按上面的 `Test...` 名字精确过滤。** 直接 `go test ./cmd/` 或放宽成 `-run 'Import|Usage'` 都会
   命中 juicefs 自带的用例，而它们会在 `TestMain` 里挂一个真实 FUSE 文件系统
   （`/tmp/jfs-unit-test`）：普通容器里没有 `/dev/fuse` 与 `/bin/fusermount`，于是整包以
   `fuse is not installed` 直接 FAIL。这与本仓库的 overlay 无关。
2. **`pkg/vfs` 不在上面的集合里。** 它有需要本机 redis（db 11）的用例，跑法更重且耗时明显；
   只有改动到 `overlays/juicefs/pkg/vfs/compat.go` 时才需要单独跑。

两个 cache 卷（`foyer-gomodcache` / `foyer-gocache`）可复用编译缓存，否则每次都要重下依赖。

## 部署与配置

- `deploy/compose.yml` —— `--profile juicefs` 起 `foyer`（网关 + 控制面）；`--profile app` 起 filestore API / worker。
- `deploy/compose.host-drives.yml` —— 由 `scripts/gen-host-drives.ps1` **生成**（勿手改），
  把本机盘符只读绑进容器（`C:/` → `/mnt/c`），供目录选择器使用。
- `deploy/foyer/Dockerfile` —— 两阶段构建；构建期用 `.sh` 版 overlay 注入增强命令，再把 `server` 编成 `foyer`。
- `scripts/start-dev.ps1` / `stop-dev.ps1` / `restart-dev.ps1` / `status-dev.ps1` —— filestore 那条线的
  本地开发脚本（起 Postgres / Redis / RustFS + API + Vite）。

foyer 进程的环境变量（默认值来自 `server/internal/foyer/config.go`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `FOYER_META_URL` | `redis://127.0.0.1:6379/1` | 元数据地址 |
| `FOYER_STORAGE` / `FOYER_BUCKET` | `minio` / `http://127.0.0.1:9000/jfs` | 对象存储类型与桶 |
| `FOYER_ACCESS_KEY` / `FOYER_SECRET_KEY` | `rustfsadmin` / `rustfsadmin` | 对象存储凭据 |
| `FOYER_GATEWAY_LISTEN` / `FOYER_ADMIN_LISTEN` | `:9002` / `:8092` | 网关与控制面监听 |
| `FOYER_VOLUME` / `FOYER_JUICEFS_BIN` | `foyer` / `juicefs` | 卷名与 juicefs 可执行文件 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `foyerak` / `foyersecret` | 网关 AK/SK（控制台登录用） |
| `FOYER_HOST_MOUNT` / `FOYER_HOST_MOUNT_BASE` | `/host` / `/mnt` | 宿主目录挂载点与盘符绑定根（须与生成脚本一致） |
| `FOYER_HOST_DATA` | 空 | 额外开放给导入的宿主目录；非空时该目录之外的宿主路径会被拒绝 |
| `FOYER_MOUNTS_FILE` | `/var/lib/foyer/mounts.json` | 挂载表持久化位置 |
| `FOYER_DATA_DISK_PATH` | `/` | 物理数据盘路径（读真实容量） |
| `FOYER_SEARCH_MAX_RESULTS` | `0` | 检索命中上限，`0` = 不限 |

## 两条线

- **JuiceFS 主线（当前）**：`cmd/foyer` + `overlays/juicefs` + `web/` 控制台。
  文件操作走 S3 Gateway，元数据与挂载走 8092 控制面；不依赖 PostgreSQL。
- **filestore（早期）**：`cmd/server` + `cmd/worker` + `cmd/cli` + `api/openapi.yaml` + `configs/`，
  PostgreSQL 元数据、`/v1` 契约。仍在 compose 的 `app` profile 下可跑，但控制台已不依赖它。

## 已知边界

- **深度检索只匹配名称**，不读文件内容、不建索引：JuiceFS 元数据是唯一真源。
- **用量进度条是所依赖物理盘的实时占用率**，不记录额度、不设配额——挂载源会被同盘其他目录挤压，
  静态额度没有意义。进程启动时不再自动设卷配额。
- **控制面 8092 目前无鉴权**，只应绑定在本机或受信网络。
- **目录列举走单次 `ListObjectsV2`**（无 continuation-token 循环），单目录上限 1000 条。
- **组件层无 DOM 自动化测试**：仓库 vitest 为 node 环境且只 include `src/**/*.test.ts`，
  组件改动靠 `tsc --noEmit` + 代码审阅 + 人工核对。

更完整的架构说明见 [docs/2026-09-18-filestore-platform-greenfield.md](docs/2026-09-18-filestore-platform-greenfield.md)；
各特性的设计与实现记录在 [docs/superpowers/specs](docs/superpowers/specs) 与
[docs/superpowers/plans](docs/superpowers/plans)。
