# Foyer（FileStore 文件平台）

Monorepo：**前后端分离**，共享 OpenAPI 契约，部署与文档在仓库根目录。

## 目录结构

```text
Foyer/
├── api/                    # OpenAPI 3 契约（CLI / 前端 / 网关的唯一 HTTP 约定）
│   └── openapi.yaml
├── server/                 # Go 服务端（module: filestore）
│   ├── cmd/
│   │   ├── server/         # API 进程（Gin + VFS）
│   │   ├── worker/         # asynq 异步任务
│   │   └── cli/            # Cobra CLI（只走 OpenAPI，不直连存储）
│   └── internal/           # path, driver, mount, vfs, httpapi, …
├── web/                    # React + Vite 管理控制台（对接 /v1 OpenAPI）
├── configs/                # 进程配置（server.yml、env 示例）
├── deploy/                 # Docker Compose、数据库迁移
├── docs/                   # 架构与施工文档
└── legacy/                 # 封存的旧 SQLite 单机实现（不参与新 compose）
```

## 本地开发

### 快速脚本（Windows PowerShell，推荐）

在仓库根目录执行（会打开 **两个新窗口** 分别跑 API 与 Vite）：

| 操作 | 命令 |
|------|------|
| 启动 | `.\scripts\start-dev.ps1` |
| 停止 API + Web | `.\scripts\stop-dev.ps1` |
| 停止并含 Docker | `.\scripts\stop-dev.ps1 -IncludeDocker` |
| 重启 | `.\scripts\restart-dev.ps1` |
| 状态 | `.\scripts\status-dev.ps1` |

常用参数：

- `.\scripts\start-dev.ps1 -InfraOnly` — 只起 Docker（Postgres / Redis / RustFS）
- `.\scripts\start-dev.ps1 -NoDocker` — 假定基础设施已在跑，只起 API + Web
- `.\scripts\start-dev.ps1 -WaitHealth` — 启动后等待 `/v1/health` 就绪

首次运行会自动从 `configs/env.example` 复制 `configs/.env`（若不存在）。登录控制台：**admin / changeme**。

### 手动启动

**基础设施：** `cd deploy && docker compose up -d postgres redis rustfs`

**后端：** `cd server && go run ./cmd/server`（读取 `configs/server.yml` + `configs/.env`）

**前端：** `cd web && npm install --legacy-peer-deps && npm run dev` → http://localhost:3000

**Vite `ECONNREFUSED 8090`**：API 未监听；**`bind :8091`**：重复启动了第二个 `go run`，先 `.\scripts\stop-dev.ps1` 再启动。

### Docker 内跑 API + Worker

```bash
cd deploy
docker compose --profile app up
```

## 职责边界

| 层级 | 目录 | 说明 |
|------|------|------|
| 契约 | `api/` | 单一 OpenAPI 源 |
| 后端 | `server/` | 存储编排、认证、索引；不嵌入前端静态资源 |
| 前端 | `web/` | 仅 HTTP 调用 `/v1`，无 AK/SK、无直连 PG |
| 运维 | `deploy/`、`configs/` | 与业务代码分离 |

更完整的架构说明见 [docs/2026-09-18-filestore-platform-greenfield.md](docs/2026-09-18-filestore-platform-greenfield.md)。
