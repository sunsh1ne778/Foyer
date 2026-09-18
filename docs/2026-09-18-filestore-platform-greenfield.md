---
name: filestore-platform-greenfield
overview: >
  从零重建 file-store 为可挂载任意存储的文件平台：VFS 单通道内核、
  OpenAPI 唯一契约、CLI/Web/S3 均为门面、PostgreSQL 索引 + Redis 会话、
  预签名数据面、水平扩展。不演进现有 SQLite 单进程实现。
todos:
  - id: t0-greenfield-tree
    content: 封存旧树，建立新模块/目录/compose（PG Redis MinIO）
    status: pending
  - id: t1-runtime-spine
    content: Gin + Wire + Viper + Zap + OTel 进程骨架与健康检查
    status: pending
  - id: t2-path-driver
    content: mount:path 解析与 Driver/Caps 契约（含 Register）
    status: pending
  - id: t3-mount-table
    content: PG 挂载表 + MountTable 热加载（唯一配置源）
    status: pending
  - id: t4-index
    content: PG 投影索引（List 唯一走索引）
    status: pending
  - id: t5-vfs
    content: VFS 编排全部动词；读写内部策略（307 直传 / 流式）
    status: pending
  - id: t6-openapi
    content: OpenAPI 唯一门面；Gin 只做协议翻译
    status: pending
  - id: t7-drivers
    content: local / S3+MinIO / OSS 一等 / FastDFS
    status: pending
  - id: t8-cli
    content: Cobra CLI 生成自 OpenAPI，禁止直连后端凭据
    status: pending
  - id: t9-worker
    content: asynq 对账与跨挂载复制（同一 Copy 动词的 async 模式）
    status: pending
  - id: t10-web
    content: Web 只消费 OpenAPI
    status: pending
  - id: t11-s3-gateway
    content: S3 网关门面，内部只调 VFS
    status: pending
  - id: t12-scale-obs
    content: 无状态副本、观测、禁粘性会话
    status: pending
isProject: true
---

# 文件平台从零开发方案

> **定位**：最终底座的施工图，不是在现有 `file-store/server` 上打补丁。  
> **前序讨论**：可挂载任意存储的文件平台；CLI 为一等门面；高性能 + 水平扩展；成熟框架体系；同一功能禁止双通道。

**Goal:** 从零交付一个以 VFS 为唯一内核的文件平台：挂载多后端、丰富文件操作、CLI/Web 同源、可水平扩展。

**Architecture:** 门面（CLI / REST / S3）只翻译协议；VFS + MountTable 是唯一编排；Driver 可插拔；字节真源在后端，List 走 PostgreSQL 投影；大流量由 VFS 内部选择预签名直传，不另开 API。

**Tech Stack:** Go · Gin · Cobra/Viper · Wire · Zap · pgx · Redis/asynq · OpenAPI 3 · OTel/Prometheus · aws-sdk-go-v2 · 阿里云 OSS SDK

## Global Constraints

- 路径语法对外只有 `mount:path`（例 `photos:/2026/a.jpg`）
- 文件语义只存在于 `internal/vfs`，门面零业务 if
- 同一功能一条通道：无 `/presign` 并列 API、无 `mount_id`+`path` 第二套定位、无 YAML/PG 双源挂载
- 进程内禁止上传会话 / 挂载热表 / staging 目录作为架构状态
- 密钥只来自环境变量或 PG 中的挂载 spec（服务端持有），CLI 只持 server+token
- 本方案不写测试文件（未要求）；验证用 curl / CLI / compose
- 禁止自动 git commit

---

## 1. 背景：为什么从零而不是演进

### 1.1 旧实现的地基与远景相反

现有 `file-store/` 是单进程文件管理器：SQLite 当目录真源、内存 `map` 挂载、本地 staging 分片、OSS 注册成 MinIO 别名、HTTP 自研 mux、Web 用 `mount_id` query。这套假设下「挂已有桶看不见原生文件」「扩副本会丢会话」「CLI 只能再包一层」。

远景要的是 **文件系统平台**：后端是字节真源、索引可查询、节点无状态、CLI 与 Web 同一通道。在旧树上改，会在过渡期保留双真源、双上传、双路径语法——正好违反「一功能一通道」。

### 1.2 从零的含义

- 新模块树、新 `go.mod`、新 OpenAPI、新 compose。
- 旧 `server/`、`web/` **封存不编译、不进入新 compose**，不作对照双轨、不迁表、不兼容旧 API。
- 允许阅读旧代码当参考（FastDFS 协议、Vue 交互），禁止 import 旧包。

```text
# ❌ 演进：旧 catalog.List + 新 VFS.List 并存
# ✅ 从零：只有 VFS.List
```

---

## 2. 设计原则

**P1 抽象在动词，不在协议。** 调用方看见的是 List/Stat/Read/Write/Mkdir/Remove/Copy/Move。HTTP 方法、CLI 子命令、S3 API 都是这些动词的皮肤。

**P2 一功能一通道。** 删掉一条路径后功能仍在，说明另一条是重复通道。内部策略（预签名 vs 流式、同步 vs 异步）不得升格为第二套对外入口。详见 §3.5。

**P3 控制面与数据面分离。** API 节点可水平扩；字节尽量 client↔后端直传。直传仍由 VFS **签发**，不是第二控制面。

**P4 索引是投影，不是第二真源。** List 只打 PostgreSQL；对账 Worker 只修索引，不提供 `list_native`。冲突以后端对象为准，下一轮对账收敛。

**P5 成熟体系一整套。** Gin + Cobra + Viper + Wire + Zap + pgx + Redis + asynq + OpenAPI + OTel。不引入第二 HTTP 框架、第二配置库、第二日志库。

**P6 不改写对象形态。** 原生 key 保留。不是 JuiceFS（切 chunk）、不是自建盘。

---

## 3. 契约

### 3.1 仓库与进程

新代码占据 `file-store/` 顶层。旧实现移到 `file-store/legacy/`（`go.mod` 不含、CI 不含）。

```text
file-store/
  api/openapi.yaml              # 唯一 HTTP 契约，CLI/Web/网关的根
  cmd/server/main.go            # API 进程（Gin + VFS + Driver 池）
  cmd/worker/main.go            # asynq worker（对账/跨挂载复制）
  cmd/cli/main.go               # Cobra；生成客户端，无 Driver
  internal/
    path/                       # 只负责 mount:path 解析
    driver/                     # Driver 接口 + Register + 各后端
    mount/                      # MountTable，源=PG
    index/                      # 投影索引
    overlay/                    # 标签等旁路元数据
    vfs/                        # 唯一编排
    httpapi/                    # Gin：OpenAPI → VFS
    gateway/s3/                 # S3 协议 → VFS（任务 11）
    worker/                     # asynq handler，调 VFS
    auth/
    config/
    obs/
  web/                          # Vue；只调 /v1
  deploy/
    compose.yml                 # postgres redis minio api worker
    migrations/                 # filestore_*.sql
  configs/server.yml            # 进程配置：listen/dsn/redis；无 backends 列表
  legacy/                       # 封存的旧实现
```

三个二进制，职责不可交叉：

| 进程 | 可以依赖 | 禁止 |
|---|---|---|
| `server` | VFS、Driver、PG、Redis | 执行长复制循环（交 asynq） |
| `worker` | VFS、Driver、PG、Redis | 另做一套 Copy 语义 |
| `cli` | OpenAPI 客户端 | `internal/driver`、AK/SK、直连 PG |

### 3.2 定位：唯一路径语法

```go
package pathx

type Ref struct {
    Mount string // name 或 id
    Path  string // POSIX，以 / 开头，清理 .. 
}

func Parse(s string) (Ref, error) // "photos:/a.jpg" | "photos:a.jpg"
func (r Ref) String() string      // 规范形式 "photos:/a.jpg"
```

禁止第二套：`?mount_id=&path=`、JSON 字段 `backend`、CLI `--mount` 与位置参数两套并用。HTTP 一律 `?p=photos:/a.jpg` 或 path 风格 `/v1/fs/photos/a.jpg`（路由层先合成 `Ref`，再进 VFS）。对 VFS 只存在 `Ref`。

### 3.3 Driver（存储适配，不是编排）

```go
package driver

type Caps struct {
    List, Mkdir, Copy, Move bool
    Multipart, Presign      bool
    Directory               bool // 真目录 vs key 前缀
}

type Driver interface {
    Kind() string
    Caps() Caps
    Close() error
    Health(ctx context.Context) error

    List(ctx context.Context, prefix string, rec ListRec) (ListPage, error)
    Stat(ctx context.Context, key string) (Info, error)
    Mkdir(ctx context.Context, key string) error
    Remove(ctx context.Context, key string) error

    Read(ctx context.Context, key string, rng *Range) (io.ReadCloser, error)
    Write(ctx context.Context, key string, r io.Reader, n int64) error

    Copy(ctx context.Context, src, dst string) error
    Move(ctx context.Context, src, dst string) error

    CreateUpload(ctx context.Context, key string) (uploadID string, err error)
    PutPart(ctx context.Context, uploadID string, n int, r io.Reader) error
    Complete(ctx context.Context, uploadID string) error
    Abort(ctx context.Context, uploadID string) error

    PresignGet(ctx context.Context, key string, ttl time.Duration) (url string, headers map[string]string, err error)
    PresignPut(ctx context.Context, key string, n int64, ttl time.Duration) (url string, headers map[string]string, err error)
}

type Factory func(id string, spec map[string]string) (Driver, error)

func Register(kind string, f Factory)
func Open(kind, id string, spec map[string]string) (Driver, error)
```

约定：

- 不支持的方法返回 `ErrUnsupported`；Caps 先行声明。VFS 据此选策略，不另开包。
- `spec` 只有 `map[string]string`。预留键：`prefix`、`endpoint`、`bucket`、`region`、`access_key`、`secret_key`、`root`、`path_style`、`auto_create`（默认 `false`）、`tracker`、`group`。
- `Kind()` 必须等于注册 type。OSS 不得报 `minio`。
- `Open` 只探活；`auto_create!=true` 时禁止建桶。
- 长尾后端用 go-storage **实现** `Driver`，不把 go-storage 的 `Storager` 暴露给 VFS。

### 3.4 VFS（唯一编排）

```go
package vfs

type FS struct { /* mounts + index + overlay + jobs */ }

func (f *FS) List(ctx context.Context, ref pathx.Ref, rec ListRec) (ListPage, error)
func (f *FS) Stat(ctx context.Context, ref pathx.Ref) (Info, error)
func (f *FS) Mkdir(ctx context.Context, ref pathx.Ref) error
func (f *FS) Remove(ctx context.Context, ref pathx.Ref) error
func (f *FS) Read(ctx context.Context, ref pathx.Ref, rng *Range) (ReadResult, error)
func (f *FS) WriteBegin(ctx context.Context, ref pathx.Ref, in WriteIn) (WriteSession, error)
func (f *FS) WritePart(ctx context.Context, sid string, n int, r io.Reader) error
func (f *FS) WriteComplete(ctx context.Context, sid string) error
func (f *FS) WriteAbort(ctx context.Context, sid string) error
func (f *FS) Copy(ctx context.Context, src, dst pathx.Ref, async bool) (CopyResult, error)
func (f *FS) Move(ctx context.Context, src, dst pathx.Ref, async bool) (CopyResult, error)
```

`ReadResult` / `WriteSession` 是 **一个类型内的策略枚举**，不是两套 API：

```go
type ReadResult struct {
    Mode    string            // "redirect" | "stream"
    URL     string            // redirect 时给客户端 307
    Headers map[string]string
    Body    io.ReadCloser     // stream 时由 server 代理，用完关闭
}

type WriteSession struct {
    ID      string
    Mode    string            // "redirect" | "stream"
    Parts   []PresignPart     // redirect：客户端对 URL PUT
}
```

选择规则（写死，禁止调用方挑选）：

```text
Read:  Caps.Presign && 无 Range 复杂需求 → redirect；否则 stream
Write: Caps.Presign → redirect 分片；否则 stream 分片到 Driver.PutPart
Copy 同挂载且 Caps.Copy → Driver.Copy
Copy 跨挂载或无 Caps.Copy → 若 async=false 且体积小可同步流式；否则 asynq，返回 job_id
           对外仍是 Copy 的 200/202，不另开 /jobs/copy 业务
```

写成功后 **写透索引**；失败补偿删除不完整索引行。List 永不直接 `Driver.List`（对账任务除外，见 §3.7）。

### 3.5 一功能一通道（实施时对照表）

| 功能 | 唯一入口 | 禁止 |
|---|---|---|
| 定位 | `pathx.Ref` | `mount_id`+`path`、`backend` 别名 |
| List | `FS.List` → PG | `list_native`、门面直打 Driver.List |
| Read | `FS.Read` | 并列 `GET /content` 与 `POST /presign` |
| Write | `FS.WriteBegin/Part/Complete` | 本地 staging 协议 + 后端 multipart 两套对外 |
| Copy/Move | `FS.Copy`/`Move` | Worker 专用复制 URL 与同步复制语义分叉 |
| 挂载配置 | PG `mounts` | `configs/*.yml` 里长期 `backends:` |
| 鉴权 | Bearer JWT | CLI 持有后端 AK 直连 |
| DTO | `api/openapi.yaml` | CLI 手写第二套 struct |
| 驱动模型 | `driver.Driver` | 进程内一套 + go-storage 再暴露一套 |

Gin 路由只是动词投影，例如：

```text
POST /v1/login
GET  /v1/mounts          POST /v1/mounts
PATCH /v1/mounts/{id}    DELETE /v1/mounts/{id}
POST /v1/mounts/{id}/probe
POST /v1/mounts/{id}/unmount | /mount

GET  /v1/fs/list?p=
GET  /v1/fs/stat?p=
POST /v1/fs/mkdir?p=
DELETE /v1/fs?p=
GET  /v1/fs?p=              # Read：200 流 或 307
POST /v1/fs/writes          # WriteBegin
PUT  /v1/fs/writes/{id}/parts/{n}
POST /v1/fs/writes/{id}/complete
DELETE /v1/fs/writes/{id}
POST /v1/fs/copy            # body {src,dst} → 200|202
POST /v1/fs/move
GET  /v1/jobs/{id}          # 观察 Copy 进度，不是第二条 Copy
```

`GET /v1/fs` 在 `redirect` 时返回 **307 + Location**，客户端（CLI/浏览器）跟随到后端。没有 `POST /v1/presign`。

### 3.6 数据模型

PostgreSQL（进程配置里只有 DSN，没有挂载清单）：

```sql
-- deploy/migrations/filestore_core_init.sql

CREATE TABLE mounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  spec_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 投影索引：List 的唯一查询面
CREATE TABLE fs_nodes (
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,              -- 后端原生 key（含 prefix 处理后的相对 key）
  is_dir BOOLEAN NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  etag TEXT,
  mtime TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (mount_id, key)
);
CREATE INDEX fs_nodes_parent ON fs_nodes (mount_id, (regexp_replace(key, '/[^/]+$', '')));

CREATE TABLE overlay_meta (
  mount_id TEXT NOT NULL,
  key TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  custom JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (mount_id, key)
);
```

Redis：

```text
sess:write:{sid}     WriteSession JSON + TTL
lock:node:{mount}:{key}   rename/copy
asynq queues         copy, reconcile
```

禁止：SQLite、进程 `sync.Map` 存会话、`./data/staging`。

### 3.7 对账（索引维修，不是第二 List）

Worker 任务 `reconcile(mount_id)`：`Driver.List` 全量/增量 → upsert/delete `fs_nodes`。只由挂载成功、定时、或管理 API `POST /v1/mounts/{id}/reconcile` 触发。该 API 触发的是 **维修作业**，返回 job_id，**列表结果仍只来自 `FS.List`。**

### 3.8 配置 schema

```yaml
# configs/server.yml  — 禁止 backends:
listen: ":8090"
postgres_dsn: ${FILESTORE_PG_DSN}
redis_url: ${FILESTORE_REDIS_URL}
auth:
  username: admin
  # password/secret 仅环境变量
otel:
  endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}
```

首次挂载只通过 `POST /v1/mounts` 或 CLI `filestore mount add`。

### 3.9 框架体系（只此一套）

| 层 | 库 |
|---|---|
| HTTP | gin-gonic/gin |
| CLI | spf13/cobra + viper |
| DI | google/wire |
| Log | uber-go/zap |
| PG | jackc/pgx/v5 |
| Redis/任务 | redis/go-redis + hibiken/asynq |
| 契约 | OpenAPI 3 + oapi-codegen |
| 观测 | go.opentelemetry.io/otel |
| S3/MinIO | aws-sdk-go-v2 |
| OSS | aliyun-oss-go-sdk |

---

## 4. 水平扩展（底座即如此，不是后期改造）

```text
[CLI/Web] → Traefik → server×N（无状态）
                      worker×N
                      → PostgreSQL（主 + 只读从，List 可读从）
                      → Redis
                      → 各对象存储 / NAS / FastDFS
```

- JWT 无粘性。
- WriteSession 只在 Redis，任意 server 可续传。
- 每个 server 按 PG 挂载表在本地建 Driver 池（Driver 是客户端，副本重复持有合法）。
- 节点无工作盘。
- 扩容先加 server 副本；带宽靠直传，不靠 Gin 调优。

---

## 5. 实施任务

每项独立可验证。顺序不可跳：没有 Driver 契约就没有 VFS，没有 VFS 就没有门面。

### 任务 0：封存旧树 + 空仓骨架

**现状：** §1.1，旧 `server/` `web/` 仍是可运行的单机管理器，若新代码与之并行启动即双轨。

**方案：** 将 `file-store/server`、`file-store/web`、旧 `configs/server.yml` 移入 `file-store/legacy/`。顶层新建 §3.1 目录、`go.mod`（module `filestore`）、`deploy/compose.yml`（postgres 16、redis 7、minio）。`configs/server.yml` 只含 §3.8 字段。

| 影响 | 路径 |
|---|---|
| 移动 | `file-store/server` → `file-store/legacy/server` 等 |
| 新建 | `file-store/go.mod`、`cmd/*`、`deploy/compose.yml`、`configs/server.yml` |

**验证：** `docker compose up` 后 PG/Redis/MinIO 健康；仓库内只有一个 `go.mod` 被构建。

### 任务 1：运行时脊柱

**现状：** 新树尚无进程。若先写业务再补日志/DI，容易再引入 std log 与 Gin 并行的第二套。

**方案：** `cmd/server` 用 Wire 装配：Viper 配置、Zap、OTel、Gin、`GET /v1/health`（查 PG+Redis）。无业务路由。

| 影响 | 路径 |
|---|---|
| 新建 | `internal/config`、`internal/obs`、`internal/httpapi`（仅 health）、`cmd/server` |

**验证：** `GET /v1/health` → `{ok:true}`；kill PG 后非 200。

### 任务 2：路径 + Driver 契约

**现状：** 无 `Ref`、无 Caps 时，后续 HTTP 会习惯性发明 `mount_id`。

**方案：** 落地 §3.2 §3.3。`internal/driver` 只含接口与 `Register/Open`。本任务不写真实后端（可在 `_test` 外用内存 fake 仅供本模块自检，不强制加测试目录）。

| 影响 | 路径 |
|---|---|
| 新建 | `internal/path`、`internal/driver/driver.go`、`register.go` |

**验证：** `Parse("photos:/a/../b")` 得到 `photos:/b`；未知 type 的 `Open` 报错。

### 任务 3：MountTable（PG 唯一配置源）

**现状：** §1.1 旧 YAML `backends` 与 SQLite 双源。底座禁止。

**方案：** 迁移脚本 §3.6 `mounts` 表。`internal/mount`：`Attach/Detach/Get/LoadAll`，热加载 PG NOTIFY 或 5s 轮询。`spec_json` 读写 `map[string]string`。密钥出库接口 `PublicSpec` 打码。Probe = `Open` 后 `Health` 再 Close，不留实例。

| 影响 | 路径 |
|---|---|
| 新建 | `deploy/migrations/filestore_core_init.sql`、`internal/mount` |
| 修改 | `internal/httpapi` 暂不暴露（挂载 HTTP 在任务 6 与 FS 一起挂，避免早期双风格） |

**验证：** 直接 SQL 插入一条 local 挂载，进程日志显示 Driver 已加载；改 spec 后旧连接 Close。

### 任务 4：投影索引

**现状：** 没有索引则 List 只能打后端，或先写 SQLite——都会锁死错误真源。

**方案：** `fs_nodes` + `internal/index`：`ListChildren`、`Upsert`、`Delete`、`DeletePrefix`。查询按 `mount_id` + parent 分页。本任务不对 HTTP 开放「原生 List」。

| 影响 | 路径 |
|---|---|
| 修改 | `filestore_core_init.sql`（`fs_nodes`） |
| 新建 | `internal/index` |

**验证：** 插入两层 key，List `/` 只返回一层。

### 任务 5：VFS 内核（平台本体）

**现状：** 缺这一层则 Gin 与 Driver 会直接对话，通道在门面分叉。

**方案：** 实现 §3.4 全部方法。Read/Write 按 Caps 填 `Mode`。Copy/Move 同挂载走 Driver，跨挂载本任务可返回 `ErrNeedAsync`（任务 9 接 asynq，仍是这两个方法）。写透索引。挂载未 loaded 则错误，不静默打别的盘。

| 影响 | 路径 |
|---|---|
| 新建 | `internal/vfs` |

**验证：** 用 local 驱动在进程内（server 未暴露也可写 `cmd/devcheck` 一次性工具，用完删除）完成 mkdir → write → list → stat → read → remove，List 数据来自 PG。

### 任务 6：OpenAPI + Gin 唯一 HTTP 门面

**现状：** 无契约则 CLI/Web 会各自发明 DTO。

**方案：** 先写 `api/openapi.yaml` 覆盖 §3.5 路由，再 `oapi-codegen`，Gin handler 只做：鉴权 → `pathx.Parse` → 调 `FS.*` → 按 `ReadResult.Mode` 写 307 或流式。挂载 CRUD 同时挂上，内部只调 `mount` + 成功后 `reconcile` 入队（任务 9 前可同步调一次 Driver.List 写入 index，仍不把 List 暴露成第二 API）。

JWT 登录沿用「用户名密码换 token」，密码来自环境变量。

| 影响 | 路径 |
|---|---|
| 新建 | `api/openapi.yaml`、`internal/auth`、`internal/httpapi` 全量路由 |
| 修改 | `cmd/server` |

**验证：** 只通过 HTTP 走完挂载 local、写入、list、307/流式下载；curl 不得出现 `mount_id` 字段。

### 任务 7：一等驱动

**现状：** 旧实现 OSS=MinIO 别名、Open 会建桶，违反 Kind 与探活政策。

**方案：**

| type | 包 | SDK |
|---|---|---|
| `local` | `internal/driver/local` | 标准库；NAS = `root` 指向已挂路径 |
| `s3` / `minio` | `internal/driver/s3` | aws-sdk-go-v2；`path_style` 可配 |
| `oss` | `internal/driver/oss` | 官方 OSS SDK；独立 Register |
| `fastdfs` | `internal/driver/fastdfs` | 可参考 `legacy` 协议，不 import legacy |

`s3` 与 `minio` 可共用内部实现，但 `Kind()` 返回各自 type。`cos` 若做，同样一等或明确归入 `s3` 兼容，**只选一种注册名**，禁止两名两实现抢同一后端。

| 影响 | 路径 |
|---|---|
| 新建 | `internal/driver/{local,s3,oss,fastdfs}` |
| 修改 | `cmd/server` blank import |

**验证：** MinIO compose 桶预创建；挂载后对账可见预放对象；OSS 用独立 spec 字段；`auto_create` 默认不建桶。

### 任务 8：CLI

**现状：** 无 CLI 时人会给 Web 加 flag、给脚本加第二套路径。

**方案：** Cobra 子命令与 VFS 动词 1:1：`login ls stat mkdir rm put get cp mv mount`。配置：`~/.filestore/config` 仅 `server`+`token`。`put`/`get`：调 WriteBegin/Read，Mode=redirect 则 CLI 对 URL 传文件，**不把 AK 写入配置**。`--json` 输出 OpenAPI schema。客户端由 oapi-codegen 生成，禁止手写 URL。

| 影响 | 路径 |
|---|---|
| 新建 | `cmd/cli`、`internal/cliclient`（生成代码） |

**验证：** 同一 server，CLI `ls photos:/` 与 `GET /v1/fs/list?p=photos:/` 结果一致。

### 任务 9：Worker（同一动词的异步模式）

**现状：** 跨挂载复制若另做 `/jobs/copy` 业务，Copy 被劈成两条。

**方案：** `cmd/worker` 消费 asynq。`FS.Copy(..., async=true)` 入队，HTTP 202 + `job_id`；`GET /v1/jobs/{id}` 只读进度。对账 `reconcile` 同样入队。Worker **调用 `FS`/`Driver`，不复制一份 Copy 代码**。

| 影响 | 路径 |
|---|---|
| 新建 | `cmd/worker`、`internal/worker` |
| 修改 | `internal/vfs` Copy 分支 |

**验证：** 跨 MinIO→local 的 `cp` 返回 202，轮询 job 成功后两边 index 一致。

### 任务 10：Web

**现状：** 旧 Vue 绑定 `mount_id`。新 UI 必须绑定 `mount:path`。

**方案：** 新 `file-store/web`（Vue + 现有 Element Plus 习惯可保留）。所有请求来自 OpenAPI。无本地拼装第二套路径。上传跟随 WriteSession（redirect 则浏览器直传 MinIO）。

| 影响 | 路径 |
|---|---|
| 新建 | `file-store/web/*` |

**验证：** 浏览器与 CLI 对同一 `photos:/` 看到同一棵树。

### 任务 11：S3 网关门面

**现状：** 生态工具（`mc`/`aws s3`）若直连 MinIO，会绕过索引与鉴权，形成第二数据面。

**方案：** `internal/gateway/s3` 实现必要 S3 API 子集（List/Get/Put/Delete/Head/Copy），bucket 映射为 mount name，key 映射为 path。内部只调 `FS`。与 REST 共用鉴权或签发网关专用 JWT，但 **不** 把后端 AK 转交给 `mc`。

| 影响 | 路径 |
|---|---|
| 新建 | `internal/gateway/s3` |
| 修改 | `cmd/server` 可同进程挂第二 listen，或同 Gin 不同 path；仍是一个 VFS |

**验证：** `mc ls myminio/photos/` 与 `filestore ls photos:/` 一致。

### 任务 12：观测与多副本

**现状：** 单进程足以开发；底座必须证明无粘性。

**方案：** 每个 VFS 操作打 Zap 字段 `op,mount,key,mode,node` + OTel span。compose 起 2 个 server + 1 worker。对同一 `write` sid 在两个 server 之间交替 PUT part。Prometheus `/metrics`。

| 影响 | 路径 |
|---|---|
| 修改 | `deploy/compose.yml`、`internal/obs`、`internal/vfs` |

**验证：** 停掉其中一个 server，续传与 List 仍成功。

---

## 6. 明确不做（写进底座，避免施工加回来）

- 不演进、不双轨运行 `legacy/`
- 不引入 JuiceFS/Seaweed 当内核
- 不把 go-storage 当作 VFS 接口
- 不做进程内 NFS；NAS 只当 local `root`
- 不引入第二 HTTP/日志/配置框架
- 不提供 `list_native`、`/presign`、YAML `backends`
- FUSE / WebDAV 可在本方案全部任务完成后再开子方案，仍必须进 VFS，不得新开通道
- 不在本方案写测试目录、不自动 commit

---

## 7. 风险

| 风险 | 为什么会发生 | 底座内的应对 |
|---|---|---|
| S3 List 与索引漂移 | 桶被控制台直接改 | 对账作业；冲突以后端为准，List 仍只读索引 |
| 预签名把数据面「看起来像」第二通道 | 给调用方开了 Presign API | 只允许 307/WriteSession.Mode，无独立资源 |
| OSS 与 S3 行为差 | 混用客户端 | 一等 OSS SDK，Kind 分离 |
| FastDFS 无预签名 | 大流量打满 API | Caps.Presign=false → 只 stream；水平扩展 API 副本，不发明第二套上传 |
| 施工顺序颠倒 | 先做 Web 再补 VFS | 任务 5 未完成不得开工任务 6+ |

---

## 8. 完工判据

1. 任意门面（curl / CLI / Web / `mc`）对同一 `mount:path` 结果一致。  
2. 仓库内不存在第二套 List/Read/Write/Copy 实现（gateway 与 httpapi 无 Driver 调用）。  
3. 杀死任意一个 server 副本，会话与挂载仍在。  
4. 挂已有 MinIO 桶，对账后 List 出现平台外放入的对象。  
5. `configs/server.yml` 无 `backends`；CLI 配置无 AK/SK。
