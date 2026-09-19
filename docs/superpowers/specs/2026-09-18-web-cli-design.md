# Web CLI 设计

日期：2026-09-18  
状态：已评审待实现

## 问题

控制台 CLI 页（`web/src/components/CliPlaybook.tsx`）目前是写死演示输出。Go Cobra CLI（`server/cmd/cli`）才真正调用 `/v1`。Web 与 CLI 应是同一门面的两种皮肤，终端必须执行真实动词。

## 目标

浏览器内提供与 Cobra 同名的命令解释器：解析输入、用当前登录 JWT 调用已有 OpenAPI、默认人类可读输出、`--json` 输出契约原文。不新增 HTTP 通道。

非目标（第一期）：`put`/`get` 本地文件传输；服务端 `/v1/cli/exec`；从 OpenAPI 生成命令表。

## 架构

```text
输入行
  → parse（argv + 全局 --json）
  → dispatch（web/src/api/client.ts，Authorization: Bearer <fs_token>）
  → format（表格 或 JSON）
  → 追加终端历史
  → 写操作成功则 refreshDirectory / refreshMounts
```

`CliPlaybook` 只负责 UI（历史、输入、预置命令、契约/准则 Tab）。解析、调度、格式化放在独立模块，便于单测。

禁止：`POST /v1/cli/*` 或在服务端 exec Cobra。

## 模块边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `web/src/cli/parse.ts` | 切分 argv、去掉可选前缀 `filestore`、抽出 `--json`、得到 `{ name, args, flags, json }` | 无 |
| `web/src/cli/commands.ts` | 动词 → 调用哪个 `api.*`、缺参 usage、put/get/login 的固定文案 | `api/client.ts` |
| `web/src/cli/format.ts` | 默认表格/键值；`--json` 为 `JSON.stringify(value, null, 2)` | 无 |
| `web/src/cli/run.ts` | parse + commands + format，返回 `{ text, kind, refresh }` | 上三者 |
| `CliPlaybook.tsx` | 历史渲染、执行中禁用输入、预置命令、保留 routes/principles | `run.ts` + FileStoreContext |

`client.ts` 补齐 OpenAPI 已有、Web 尚未封装的 `unmount` / `remount`（`POST /v1/mounts/{id}/unmount`、`POST /v1/mounts/{id}/mount`）。

## 命令

行首可省略 `filestore`。未知命令打印 `help` 摘要（含 usage）。

| 语法 | API | 默认输出 |
|------|-----|----------|
| `help` / `-h` | 无 | 已支持动词列表 |
| `clear` | 无 | 清空历史（仅 Web） |
| `ls <mount:path>` | `GET /v1/fs/list?p=` | NAME / SIZE / ETAG / MTIME 表；目录名带 `/` |
| `stat <ref>` | `GET /v1/fs/stat?p=` | 字段键值 |
| `mkdir <ref>` | `POST /v1/fs/mkdir?p=` | 默认 `created <ref>`；`--json` 打印响应体 |
| `rm <ref>` | `DELETE /v1/fs?p=` | `removed <ref>` |
| `cp <src> <dst>` | `POST /v1/fs/copy` body `{src,dst,async:true}` | 同步 ok 或 `queued job_id=…` |
| `mv <src> <dst>` | `POST /v1/fs/move` 同上 | 同 cp |
| `job <id>` | `GET /v1/jobs/{id}` | 键值 |
| `mount ls` / `mount list` | `GET /v1/mounts` | NAME / TYPE / STATUS 表 |
| `mount add <name> --type T --spec k=v` | `POST /v1/mounts` | 创建结果键值；`--type` 默认 `local`；`--spec` 可重复 |
| `mount rm <id>` | `DELETE /v1/mounts/{id}` | `removed mount <id>` |
| `mount probe <id>` | `POST …/probe` | `{ ok }` |
| `mount unmount <id>` | `POST …/unmount` | 状态 |
| `mount mount <id>` | `POST …/mount` | 状态 |
| `put` / `get` | **不调用 API** | 说明浏览器无本机路径，请用本机 `filestore put/get` |
| `login` | 不调用 | 说明已在控制台登录，会话即 JWT |

缺位置参数或未知 flag：不打 API，输出 `usage: …`。

`rm` / `mount rm` 不二次确认（与 Cobra 一致）。

## 解析规则

- 空白分词；支持双引号包住含空格的 ref（`ls "photos:/my dir"`）。
- 全局 `--json` 可出现在任意位置，从 argv 中剥离后再匹配子命令。
- `mount` 的子命令为第一位置参数（`ls|list|add|rm|probe|unmount|mount`）。
- `--spec` 形式 `key=value`；非法（无 `=`）视为 usage 错误。
- 不实现 Cobra 的全部 flag 全集；未列出的 flag 一律 usage 错误。

## 交互

- 终端为滚动历史：每条记录 `$ <cmd>` + 输出正文。失败用区别于成功的文本颜色（仍是等宽文本）。
- Enter 执行；请求进行中禁用输入与执行按钮。
- 预置命令使用 **当前** `currentMount` / `currentRef`，不再写死 `banner_spring_launch.png`。点击即执行。预置仅包含第一期支持的只读/安全示例：`ls`、`stat`（当前选中或当前目录）、`mount ls`、`help`。不预置 `rm`。
- 写操作成功后刷新对应列表：`mkdir`/`rm`/`cp`/`mv` → `refreshDirectory`；`mount add|rm|unmount|mount` → `refreshMounts`。`probe` 只读探测，不刷新。
- 401：输出未授权文案；不在 CLI 内做登录表单（沿用控制台已有会话）。
- 保留「OpenAPI 动词契约对齐表」与「内核设计准则」Tab；对照表按上表更新（含未实现的 put/get 标注为本机 CLI）。

## 错误

- `ApiError`：打印 `error: <message>`（含 HTTP status 若有）。
- 网络失败：`error: <message>`。
- 解析失败：`usage: …`，`kind=usage`。
- put/get：`kind=unsupported`，固定中文说明 + 本机示例一行。

## 测试

- 为 `parse` / 调度映射 / `format` 加 vitest（纯函数，不启浏览器、不打真 API）。
- 覆盖：省略 `filestore` 前缀、`--json` 剥离、引号、`mount list` 别名、put/get 不进入 api mock、缺参 usage。
- 手工：登录控制台，对真实挂载执行 `ls`/`stat`/`mkdir`/`rm`，对照文件页；`filestore ls` 与 `ls` 等价。

## 明确不做

- 后端执行命令字符串。
- 第一期 `put`/`get`（含隐藏 file input 绕过）。
- WebSocket/PTY。
- 改 Go CLI 输出格式（Go 侧仍可全部 JSON；Web 默认表格是皮肤差异，`--json` 同源）。
