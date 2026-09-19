# 跨文件夹深度关键词检索 设计

日期：2026-09-19
状态：已确认（2026-09-19）

## 问题

`FileExplorer` 的搜索框只对**当前已加载目录**做内存过滤（`web/src/components/FileExplorer.tsx:73-80`，匹配 `name`/`tags`/`etag`）。用户无法在当前目录**之外**找文件：想找 `raw/a.dng` 必须先手动逐层进入 `raw` 目录。目录一深，搜索就形同虚设。

需要「输入一个关键词，**跨所有挂载、递归地**找出名字里含它的文件与目录」。

## 目标

- 关键词按**文件名/目录名**匹配（子串，默认大小写不敏感）。
- 递归遍历，覆盖**所有挂载**。
- 结果复用 `FileExplorer` 列表区域展示，可点击跳转到所在目录。
- 大目录下结果很多时可翻页浏览。

## 非目标

- **不搜文件内容**（不读字节、不做全文索引）。只匹配名字。
- 不建 PostgreSQL 索引、不做对账——JuiceFS 元数据仍是唯一真源。
- 不覆盖非 JuiceFS 卷支撑的驱动（见「已知边界」）。
- 不做正则 / glob 语法（关键词是子串，`*`、`?` 一律当普通字符）。

## 方案总览

复用既有 overlay → Runner → HTTP → 前端的分层，不引入第二真源。

| 单元 | 职责 | 依赖 |
|---|---|---|
| `overlays/juicefs/cmd/find.go`（新） | `juicefs find`：递归元数据树、按名字匹配、输出 JSON | `meta.Meta.Readdir` |
| `scripts/apply-juicefs-overlay.*` | 落地 `find.go` 并注册进 `main.go` | 既有脚本 |
| `server/internal/foyer/search.go`（新） | `SearchArgs` / `Runner.Search` / `parseSearch` + 类型 | `exec.go` 的 `Runner.cmd`/`parseJSONLine` |
| `server/internal/foyer/health.go` | 注册 `GET /foyer/search` | 上列 |
| `server/internal/foyer/config.go` | 新增 `SearchMaxResults`（`FOYER_SEARCH_MAX_RESULTS`，默认 0=不限） | 无 |
| `web/src/api/jfs.ts` | `foyerSearch(keyword, path?)` + 类型 | `URLSearchParams` |
| `web/src/api/search.ts`（新） | 纯函数：卷内路径 → 挂载 + 挂载内 key；分页切片 | `mounts.ts` |
| `web/src/context/FileStoreContext.tsx` | 深度检索状态 + `runDeepSearch`/`exitDeepSearch`/`revealHit` | 上列 |
| `web/src/components/FileExplorer.tsx` | 触发入口 + 结果视图（复用列表区域） | 上列 |

数据流：

```
FileExplorer 输入框 Enter/按钮
  → context.runDeepSearch(kw)
  → jfs.foyerSearch(kw, '/')            # GET /foyer/search?q=kw&path=/
  → Runner.Search → juicefs find META / --name kw
  → 元数据树递归匹配 → JSON（卷内绝对路径）
  → attributeMatches(mounts, matches)   # 最长 dest 前缀归到挂载
  → 结果视图（客户端分页）
  → 点击行 revealHit → navigateTo(mount, 父目录) → 加载完成后选中该行
```

## overlay：`juicefs find`

### 命令

```
juicefs find META-URL [PATH...] --name <关键词> [--case-sensitive] [--limit N]
```

- `--name` 必填；空值报错。
- `PATH` 默认 `/`；多个 PATH 时各自作为遍历根。
- `--limit` 默认 `0`（不限）；命中数达到 N 时置 `truncated=true` 并停止（**只作安全阀**，正常路径不截断）。
- `--case-sensitive` 默认关（关键词大小写不敏感）。

### 遍历规则

- 迭代（显式队列）遍历，逐级 `Readdir(ctx, inode, 1, &entries)`（`wantattr=1` 取属性，避免二次 GetAttr）。
- 匹配对象是 **entry 名**（`Entry.Name`），不是整条路径；只收集根的**后代**，根自身不出现在结果里。
- 只跟随目录（`Attr.Typ == meta.TypeDirectory`）；**不跟随 symlink**（防环）。
- 跳过卷回收站子树（`meta.TrashInode` / `.trash`）：已删除但留在回收站的文件不应出现在用户检索里。
- 单个目录 `Readdir` 失败：记一条 `errors`，跳过该子树，**不中断**整体遍历。
- `scanned` 统计访问过的 entry 总数（供 UI 显示「已扫描 M 项」）。

### 输出

单行 JSON（与 `usage` 一致，server 侧 `parseJSONLine` 直接解析）：

```json
{
  "keyword": "raw",
  "matches": [
    { "path": "/av_20260619/raw",       "name": "raw",   "type": "directory", "size": 4096, "mtime": 1690000000, "mtimensec": 0 },
    { "path": "/av_20260619/raw/a.dng", "name": "a.dng", "type": "file",      "size": 123,  "mtime": 1690000001, "mtimensec": 0 }
  ],
  "scanned": 3323,
  "truncated": false,
  "errors": [ { "path": "/broken", "error": "readdir: input/output error" } ]
}
```

- `type`：`file` | `directory` | `symlink` | `other`，复用 `statTypeString`。
- `path`：卷内绝对路径，经 `normalizeVolumePath` 归一（无尾斜杠）。
- `errors` 为空时省略。
- 退出码 0：只要会话建立成功。单个路径/目录的错误走 `errors`，不改变退出码（与 `usage` 的 per-path `error` 一致）。

### 可测试性

递归逻辑与匹配逻辑拆成可注入依赖的纯逻辑：`dirReader` 接口（`Readdir` 方法）由 `meta.Meta` 满足，测试用假目录树注入，不需要真元数据引擎。匹配函数 `matchName(name, keyword string, caseSensitive bool) bool` 独立可测。

## 控制面：`GET /foyer/search`

### 请求

```
GET /foyer/search?q=raw
GET /foyer/search?q=%23整理&path=/av_20260619
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `q` | 是 | 关键词；trim 后为空 → 400 |
| `path` | 否 | 卷内遍历根；默认 `/`。本期前端固定用 `/`（覆盖所有挂载） |
| `case` | 否 | `1` = 大小写敏感；缺省不敏感 |

> 跨文件夹检索默认从卷根 `/` 开始：所有挂载都是卷内子树，一次遍历即全覆盖，天然避免嵌套挂载被重复遍历。

### 响应

```json
{
  "ok": true,
  "keyword": "raw",
  "matches": [ { "path": "/av_20260619/raw/a.dng", "name": "a.dng", "type": "file", "size": 123, "mtime": 1690000001, "mtimensec": 0 } ],
  "scanned": 3323,
  "truncated": false
}
```

- 载荷即 overlay 结果，外加 `ok:true`；`errors` 为空时省略（与 overlay 一致）。前端据此把卷内路径映射到挂载。
- 空 `q` → 400 纯文本（与 `/foyer/stat` 的 `path required` 风格一致）。
- 非 GET → 405 + `Allow: GET`（与 `/foyer/usage` 一致）。
- `Runner.Search` 失败 → 502。

### 配置

- `Config.SearchMaxResults uint64`，env `FOYER_SEARCH_MAX_RESULTS`，默认 `0`（不限）。
- server 把它作为 `--limit` 透传给 overlay。**默认 0 表示完整返回**；只有运维显式设值时才会截断并置 `truncated`。这是安全阀，不是常规分页机制。

## 前端

### `jfs.foyerSearch(keyword, path?)`

- `query` 一律用 `URLSearchParams` 构造（`#`→`%23`、CJK、空格安全）——沿用 `foyerBrowse`/`foyerUsage` 的既有约定。
- 返回类型 `FoyerSearchResult { keyword, matches: FoyerSearchMatch[], scanned, truncated, errors? }`。
- `FoyerSearchMatch { path, name, type, size, mtime, mtimensec }`。

### `web/src/api/search.ts`（纯函数）

- `mountRoot(m)`：卷挂载（`name === JFS_MOUNT`，或 `spec.dest` 缺失）→ `/`；否则 `mountVolumePath(m)`。
  - 注意：卷挂载的 `spec` 里没有 `dest`，直接套 `mountVolumePath` 会得到 `/foyer`（错误）。必须显式把卷挂载视作 `/`。
- `matchesDest(path, dest)`：段边界对齐的前缀判断——`path === dest` 或 `path.startsWith(dest + '/')`；`dest === '/'` 时恒真。
- `attributeMatches(mounts, matches): SearchHit[]`：
  - 对每个 match 选**最长**的 `mountRoot` 作为归属挂载；不在任何 dest 下的落到卷挂载。
  - `key` = path 去掉 dest 前缀后的挂载内绝对路径（卷挂载则原样）。
  - `SearchHit { mount, key, name, isDir, size, mtime, volumePath }`，`mtime` 由秒 + 纳秒折成 ISO（复用 `mtimeISO`）。
- `parentKey(key)`：`/a/b/c` → `/a/b`；`/a` → `/`。
- `pageSlice<T>(items, page, pageSize)`：越界页夹紧，返回 `{ items, page, totalPages }`。

### Context

新增状态与方法：

- `deepSearch: { active, keyword, loading, hits, scanned, truncated, error, page }`
- `runDeepSearch(keyword: string)`：trim 空则忽略；置 loading；调 `jfs.foyerSearch`；成功后 `attributeMatches(mountsRef.current, res.matches)`；失败置 `error`（不弹全局错误）。
- `exitDeepSearch()`：清空并回到目录视图。
- `revealHit(hit)`：记录 `pendingRevealKey = hit.key`，然后 `navigateTo(hit.mount, parentKey(hit.key))`。
- 目录加载完成的 effect 里：若 `pendingRevealKey` 命中本层 `nodes` 则 `setSelectedNode` 并清空；若本层加载完成但未命中（目标已不在），也清空，避免悬挂。

### FileExplorer

- 触发：输入框**回车**触发 `runDeepSearch`；query 非空时输入框旁显示「深度检索」按钮。现有浅过滤（即时本地过滤）保留。
- `deepSearch.active` 时，列表区域切换为**结果视图**（复用现有表格样式）：
  - 顶部信息条：`命中 N 项 · 已扫描 M 项`；`truncated` 时明示「结果被截断」；`error` 时展示错误。
  - 列：名称（图标 + 挂载徽标）、路径（挂载内 key）、大小、修改时间、操作（跳转）。
  - **客户端分页**：每页 100，上一页/下一页 + 页码；翻页只切数组，不重新请求。
  - 「返回目录」按钮调用 `exitDeepSearch()`。
- 目录视图的其余行为（拖拽上传、选择、排序等）在结果视图下不生效。

### 依赖

不新增依赖。仓库无虚拟滚动库，故选客户端分页而非虚拟滚动——分页是纯函数、可单测、无新依赖。

## 测试

Go overlay（Docker `golang:1.23-bookworm` + gcc + libfuse3-dev，`overlays/juicefs/cmd/find_test.go`）：

- `matchName`：大小写不敏感/敏感两条路径；子串命中；`*`/`?` 当普通字符。
- `walkEntries`（注入假 `dirReader`）：递归覆盖多层；跳过回收站子树；不跟 symlink；单目录 `Readdir` 失败记 `errors` 且继续其余；`--limit` 命中时 `truncated=true` 且停止；`scanned` 计数与访问 entry 数一致。

Go server（`server/internal/foyer/search_test.go`）：

- `SearchArgs`：默认根 `/`、显式根、`--case-sensitive`、`--limit` 透传/省略。
- `parseSearch`：跳过 juicefs 日志行、解析 JSON、无 JSON 报错。
- `Runner.Search`：用 fake juicefs（沿用 `writeFakeJuice` 模式）验证解析。
- 路由：`q` 缺失/空白 → 400；非 GET → 405 + `Allow`；`path` 缺省为 `/`；200 形状含 `ok/keyword/matches/scanned/truncated`。

Web（vitest，node 环境，无 DOM）：

- `attributeMatches`：最长 dest 前缀胜出；`/av` 不匹配 `/av_20260619`（段边界）；卷挂载回退；卷挂载 root 为 `/`（不是 `/foyer`）；无 dest 的挂载。
- `parentKey`、`pageSlice` 边界（首页/末页/越界）。
- `jfs.foyerSearch` URL 构造：`#`→`%23`、CJK、空格、无 `path` 时不带该参数。

手工端到端（沿用 `scripts/run-foyer.ps1` + 真实容器）：

- `curl /foyer/search?q=<真实关键词>` 返回命中；`scanned` 与 `juicefs usage` 的 inode 规模量级一致。
- 浏览器：在结果视图搜一个已知文件，点击跳转到所在目录并选中；`/` 找到不在当前目录的文件。

## 已知边界与风险

- **只覆盖 JuiceFS 卷内的挂载**。当前所有挂载（含隐式卷挂载 `foyer`）都是卷内子树，故全覆盖；将来若挂载落到对象存储三方的原生 key（不经卷），需要各驱动自己的列举，不在本次范围。
- **只搜名字，不搜内容**。符合本次确认的取舍。
- **默认完整返回**可能产生大载荷：`Runner` 用 `CombinedOutput` 整体缓冲。`FOYER_SEARCH_MAX_RESULTS` 是安全阀（默认关）。真实卷规模（数千 inode）下无问题；病态树可由运维设值截断。
- **8092 控制面无鉴权**：与 `/foyer/stat`、`/foyer/usage` 现状一致，本次不收紧。
- **非快照遍历**：遍历期间并发写入可能让结果对不上某一瞬间；可接受（只读检索）。
- **不做权限过滤**：以控制面身份读元数据，与 `stat`/`usage` 同口径。

## 已确认的决定

1. 匹配目标是**文件名/目录名关键词**，不搜文件内容。
2. 范围是**所有挂载**（从卷根 `/` 一次遍历）。
3. 结果**复用 FileExplorer 列表区域**展示为独立结果视图。
4. 结果**后端完整返回**，前端做客户端分页（不新增虚拟滚动依赖）。
5. 技术路线为**控制面元数据递归遍历**（overlay `juicefs find`），不建 PG 索引、不建第二真源。
