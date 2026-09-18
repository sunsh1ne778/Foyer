# JuiceFS 瘦发行版（第一期）

日期：2026-09-18  
状态：待用户评审 spec

## 问题

Foyer 自研 VFS（原生 key、投影索引、`/v1`）与「给应用当文件系统」的目标不一致。已决定以官方 JuiceFS 为内核做二开，而不是继续演进 `server/internal/vfs`。第一期必须在本仓库可编译、可 compose 起网关、本机用 S3 API 验证读写。

## 目标

交付一个 **瘦 fork 发行版**：

- 用 git submodule 钉死 `juicedata/juicefs` 官方 commit。
- 本仓库薄入口二进制（建议命令名 `foyer`）启动官方 **S3 Gateway**，并同进程提供最小管理口 `/foyer/health`（可带与现网一致的简单登录，不做多租户）。
- compose：Redis 作 JuiceFS 元数据，现有 RustFS 作对象存储；容器内 `format`（已 format 则跳过）后起 gateway。
- `pkg/object` 中登记 FastDFS 骨架并编进二进制，compose **不启用** FastDFS。
- README 写明本机 `aws`/`mc` 对映射端口 put/get/ls。

成功标准：`compose up` 后本机对 Gateway 上传一个对象并能读回。

## 非目标（第一期）

- 修改 JuiceFS 切块、POSIX、`pkg/meta` / `pkg/vfs` 语义。
- 配额、目录统计、生命周期、审计（后续 spec）。
- 完整多租户控制台；替换现有 Web 文件浏览器与 `/v1`。
- 删除或停止维护现有 `server` VFS 代码（仅默认 compose 路径不再依赖它作为文件内核）。
- Windows 本机 FUSE / WinFsp。
- 把 JuiceFS 整树拷进仓库（禁止 vendor 巨拷贝）。
- FastDFS 真集群联调。

## 做法

瘦 fork（已选）：补丁尽量留在 submodule 的 `pkg/object` 与本仓库 `server/cmd/foyer` + `server/internal/foyer`。控制台与后续运维功能走管理 HTTP，不把产品逻辑散进 JuiceFS 内核包。

不采用胖 fork（无法跟上游）或独立 juicefs 仓库（当前只有 Foyer 工作区）。

## 仓库布局

```text
Foyer/
  third_party/juicefs/     # submodule → github.com/juicedata/juicefs，钉 commit
  server/cmd/foyer/        # 入口：format/gateway 编排 + 挂载 /foyer
  server/internal/foyer/   # health、可选 login、卷/网关就绪信息
  deploy/compose.yml       # 增加 foyer 服务；rustfs + redis 必开
  docs/superpowers/specs/  # 本文件
```

`go.mod`（`filestore` 或后续改名）用 `replace` 指向 `./third_party/juicefs`，只 import 需要的 `pkg` 与官方 `cmd` 中可复用的 gateway 启动路径。若官方 `cmd` 包耦合过死、不便 import，则 `server/cmd/foyer` 内复制 **最小** 启动胶水（调用 `pkg` 公开函数），禁止复制 `pkg/vfs` 实现。

子模块内 FastDFS：`pkg/object` 实现 `ObjectStorage` 并 `Register("fastdfs", …)`。未配置 endpoint 时不调用。无真集群时单元测试可用 fake 或跳过集成测试。

## 进程与数据流

```text
本机 aws/mc
    → :19002（compose 映射的 JuiceFS S3 Gateway）
        → JuiceFS 切块/元数据（Redis）
            → RustFS :19000

curl
    → :8092 /foyer/health
        → 同进程；不经过 server/internal/vfs
```

端口与现有 Foyer API `:8091`、RustFS `:19000` 错开，避免和正在跑的 `run-api.ps1` 冲突。具体端口在 compose 中写死并在 README 列出。

环境变量（名称可微调，语义固定）：

| 变量 | 含义 |
|------|------|
| `FOYER_META_URL` | JuiceFS 元数据，如 `redis://redis:6379/1` |
| `FOYER_STORAGE` | `s3` 或 `minio`（与官方 RustFS/S3 兼容写法一致） |
| `FOYER_BUCKET` | 对象桶名（compose 里 rustfs-init 已建 `filestore` 则可复用或另建 `jfs`） |
| `FOYER_ACCESS_KEY` / `FOYER_SECRET_KEY` | 对象存储密钥（与 RustFS 一致） |
| `FOYER_GATEWAY_LISTEN` | Gateway bind，如 `:9002` |
| `FOYER_ADMIN_LISTEN` | 管理口 bind，如 `:8092` |
| `FOYER_VOLUME` | `juicefs format` 卷名，如 `foyer` |

启动顺序：等 Redis、RustFS 健康 → 若卷未 format 则 `format` → 起 Gateway → 起 `/foyer` HTTP。format 与 gateway 不得并发写坏元数据。

## 与旧栈关系

| 组件 | 第一期 |
|------|--------|
| `server/internal/vfs` 与 `/v1` | 保留源码；compose `api`/`worker` 仍用 `profiles: ["app"]`，默认 JuiceFS 路径不启动 |
| `web/` | 不改文件浏览；可选后续再接 Gateway |
| `scripts/run-api.ps1` | 行为不变 |
| 新增 | `scripts` 或 compose 文档：只起基础设施 + foyer 网关 |

## 错误处理

- Redis/RustFS 未就绪：进程退出非 0，compose 重启。
- 重复 format：检测卷已存在则跳过，不报致命错误。
- Gateway 鉴权：沿用 JuiceFS/MinIO 网关惯例（环境变量设置 gateway 的 AK/SK）；管理口 health 默认不需鉴权，以免探活失败。若做 login，仅管理口，不影响 S3。
- FastDFS 未配置：Register 存在但 format/gateway 不选该 storage。

## 测试与验证

- 编译：`go build -o foyer ./server/cmd/foyer`（在设置 `replace` 后）。
- 手工：compose 起来后 `aws --endpoint-url http://127.0.0.1:<gw> s3 cp` 与 `cp` 回本地，内容一致。
- 不要求第一期在 Windows 上跑 FUSE。
- 不强制对官方 JuiceFS 做回归套件；子模块保持可官方测试的目录结构。

## 后续 spec（不在本期实现）

- 配额、目录统计、生命周期、审计。
- 管理面多租户与现有 React 控制台对接 Gateway。
- FastDFS 集成测试与 compose profile。
- 跟上游 submodule 的升级流程（单独文档即可）。
