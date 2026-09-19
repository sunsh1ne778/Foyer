# 导出元数据报表 设计

日期：2026-09-19
状态：待评审

## 问题

Web 控制台需要把一个**挂载源（下称"分区"）**或挂载内某个**目录**的元数据导出成可阅读、可归档、可进 Excel/BI 的报表。当前没有任何导出通道，用户只能逐目录翻看。

## 定位（本设计的第一原则）

这是一份**只读清单报表（inventory report）**，不是可恢复备份。

| | 本设计 | 明确不是 |
|---|---|---|
| 用途 | 盘点、审计、迁移前评估、容量分析 | 灾难恢复、元数据迁移 |
| 产物 | JSON（规范）+ CSV（表格） | `juicefs dump` 的 JSON/二进制 |
| 能否 `juicefs load` | 否 | 是 |
| 是否含 blob/chunks 映射、xattr、凭据 | 否 | 是 |

`dump`/`load` 是独立课题（体积、敏感字段、与只读模式的语义纠缠），另立一期。

## 术语

- **分区** = 挂载源（`MountRecord`，如 `photos`，见 `server/internal/foyer/mounts.go`）。导出分区 = 递归导出该挂载的整棵树。
- **目录** = 挂载内的一个路径（如 `photos:/2026`）。

## 范围选择

| 选项 | 默认 | 说明 |
|---|---|---|
| `kind` | — | `mount`（分区，`path="/"`）或 `directory`（目录） |
| `recursive` | `true` | 递归整棵子树 |
| `include_dirs` | `true` | 明细是否包含目录行 |
| `detail` | `basic` | 一期仅 `basic`；`full`（POSIX 属主/权限）预留 |

所选范围的**根节点自身**也作为一条明细输出（分区导出时是挂载根目录）。

## 数据来源（决定什么字段能出现）

| 字段簇 | 来源 | 备注 |
|---|---|---|
| `path / name / type / size / etag / mtime` | 数据面 S3 网关列目录（`web/src/api/jfs.ts` 的 `ListEntry`） | 目录只出现在 `CommonPrefixes`，**天然没有时间** |
| 目录 `mtime` | 控制面 `GET /foyer/stat`（批量） | 复用已有 `attachDirMtimes` 思路；缺失即 `null` |
| `scope / source` | 挂载记录（`GET /foyer/mounts`） | `mount_spec` 原样带出（见下方已知限制） |
| `tags / custom_meta` | Web 标签持久化（**前置任务，见下**） | 一期字段预留、值恒为空 |

硬约束：**凡源不提供的字段一律 `null`/空，绝不用当前时间或默认值冒充。** 这是本项目已验证的准则（见 `web/src/api/stat.test.ts` 对"不许回退 `new Date()`"的断言）。

`detail=basic` 不含 `inode / mode / uid / gid / nlink`——这些必须逐路径 `juicefs stat`，慢且一期不需要。

## 格式 `foyer.metadata-report/v1`

### 信封（JSON 顶层）

```json
{
  "schema": "foyer.metadata-report/v1",
  "generated_at": "2026-09-19T06:30:00.000Z",
  "generator": { "name": "foyer", "version": "0.2.0", "operator": "admin" },
  "scope": {
    "kind": "directory",
    "mount": "photos",
    "path": "/2026",
    "ref": "photos:/2026",
    "recursive": true,
    "include_dirs": true,
    "detail": "basic"
  },
  "source": {
    "volume": "foyer",
    "driver": "local",
    "mount_spec": { "root": "E:\\photos", "dest": "/photos", "mode": "metadata" }
  },
  "summary": { },
  "entries": [ ],
  "errors": [ ]
}
```

`scope.kind=mount` 时 `path` 固定为 `"/"`。

### 明细行 `entries[]`（一对象一条）

| 字段 | 类型 | 说明 |
|---|---|---|
| `ref` | string | `photos:/2026/a.jpg`，统一定位标识 |
| `path` | string | 挂载内绝对路径，以 `/` 开头 |
| `parent_path` | string | 父目录路径，根为 `/`；便于透视/还原树形 |
| `name` | string | basename |
| `type` | `"file"` \| `"dir"` | |
| `ext` | string | 小写、无点；目录/无后缀为 `""` |
| `size` | integer | 字节 |
| `etag` | string \| null | 目录为 `null` |
| `mtime` | string \| null | ISO-8601 UTC（毫秒）；拿不到即 `null` |
| `mtime_source` | `"s3"` \| `"stat"` \| `"none"` | 值的出处，可审计 |
| `tags` | string[] | **预留**：一期恒为 `[]` |
| `custom_meta` | object | **预留**：一期恒为 `{}` |

排序：按 `path` 升序，保证同一范围重复导出结果逐字节可比。

### 汇总 `summary`

```json
{
  "entry_count": 2,
  "file_count": 1,
  "dir_count": 1,
  "total_bytes": 16384,
  "by_extension": [ { "ext": "jpg", "count": 1, "bytes": 16384 } ],
  "mtime_range": { "min": "2020-01-02T03:04:05.123Z", "max": "2026-08-01T09:00:00.000Z" },
  "error_count": 0,
  "truncated": false
}
```

- `by_extension` 按 `count` 降序、同值按 `ext` 升序（确定性）。
- `total_bytes` 只累加文件。
- `mtime_range` 仅统计非 `null` 的 `mtime`；全为 `null` 则为 `null`。
- `truncated=true` 表示因上限被截断，报表**不得自称完整**。

### 错误 `errors[]`

```json
{ "path": "/2026/ghost", "stage": "stat", "message": "no such file or directory" }
```

计数口径：`entries` 只放解析成功的行；失败落到 `errors`，`summary.error_count == errors.length`，**失败对象不进任何计数**。

`error_count` 数的是**错误记录条数**，不是失败路径个数，两者在一处会不等：

- 整批 `stat` 抛错（控制面不可用）→ 按该批**每条路径**各记一条（最多 500 条/批），定位精确。
- 整批成功但**个别路径没被解析**（控制面报该路径错、或无 `mtime`）→ 该批只记**一条**，`path` 指向第一个未解析的路径，`message` 形如 `3/500 个目录未返回时间（含 /2026/sub）`。宽目录下错误列表不会爆炸，但 `error_count` 会小于实际失败路径数——真实条数在 `message` 里。
- 已取消而**未发出的批次**不记错误（不是失败，是没读）。

### 进度与取消

导出是串行的，上限 5 万条时可能跑很久，因此导出过程中必须给出进度并可取消：

- `WalkOptions.onProgress` 每列完一个目录回调一次（`{ entries, dirs }`），界面显示 `已读取 N 条`。
- `WalkOptions.isCancelled` 在两处被询问：**遍历阶段**的每个目录边界之前、**stat 阶段**的每一批之前（含第一批）。任一处置位即停止后续读取，**已收集的明细与已取回的目录时间都保留**。
- `WalkResult.cancelled` 与 `truncated` 分开：前者是用户要求停止，后者是撞上上限，报表不得把二者混为一谈。
- 取消是严格的**绝不下载**：`runExport` 返回 `ExportOutcome { report, cancelled }`；界面在 `downloadReport` 之前再确认一次取消标志，以覆盖「取消落在最后一批在飞期间」这一没有下一次询问机会的窗口（对 ≤500 个目录的树，整个 stat 阶段只有一批，这个窗口并不罕见）。关闭弹窗等同取消。

### CSV 投影（一行为一对象，列序固定）

```csv
ref,mount,path,parent_path,name,type,ext,size,etag,mtime,mtime_source,tags,custom_meta
photos:/2026,photos,/2026,/,2026,dir,,0,,2026-08-01T09:00:00.000Z,stat,,
photos:/2026/a.jpg,photos,/2026/a.jpg,/2026,a.jpg,file,jpg,16384,9c1f...,2020-01-02T03:04:05.123Z,s3,,
```

- `tags` / `custom_meta` 在 CSV 中以 **JSON 文本**承载（如 `["财务"]`、`{"来源":"扫描"}`），无值留空；避免自定义分隔符歧义。
- 汇总与错误不进 CSV，随 JSON 一起交付（后续如做 XLSX 再拆 sheet）。
- CSV 列自一期起**固定包含 `tags`/`custom_meta` 两列**（先留空），避免后续加列破坏解析方。

## 架构（一期为纯前端，零后端改动）

数据面列表与控制面 stat 都已存在，导出可由浏览器直接完成，不需要新增 HTTP 端点。

| 单元 | 职责 | 依赖 |
|---|---|---|
| `web/src/report/types.ts` | `ReportScope / ReportEntry / ReportSummary / MetadataReport` 类型 | 无 |
| `web/src/report/walk.ts` | 注入 `list(prefix)` 与 `stat(paths)`，递归收集并归一化 `{ entries, errors }` | `api/jfs.ts` |
| `web/src/report/build.ts` | 纯函数：由 scope + 归一化结果构造 `MetadataReport`，计算 `summary` | 无 |
| `web/src/report/format.ts` | 纯函数：`toJSON` / `toCSV`（含转义、稳定列序） | 无 |
| `web/src/report/*.test.ts` | vitest 纯函数单测（node 环境，无 DOM） | — |
| `web/src/components/ExportReportModal.tsx` | 选范围（当前挂载/当前目录）、格式、预计条数、下载 | 上列 + Context |

设计要点：

- **递归由 `walk.ts` 负责，纯逻辑（summary/CSV/JSON）全部下沉为可单测纯函数**，遵循本仓库"先落纯函数再接线"的既有约定。
- **控制面 stat 需分批**：`StatArgs` 把 path 全塞进一个 argv，超长会失败。按约 500 path/批切分，合并结果。
- **下载**：`Blob` + `URL.createObjectURL` 触发浏览器保存，文件名 `foyer-report-<mount>-<yyyymmdd-hhmmss>.{json,csv}`。
- **范围**直接取 Context 的 `currentMount` / `currentPath` / `mounts`，不新增选择器组件体系。
- **规模**：一期同步生成；设软上限（如 5 万条）超出置 `truncated=true` 并提示。异步任务产物留二期。

## 前置任务：Web 标签持久化（独立立项）

`tags` / `custom_meta` 目前只存在 React state（`web/src/components/FileStatDrawer.tsx` 写入、`FileStoreContext.tsx:539` 更新），刷新即丢、无法导出。要让报表带上它们，需先解决"存哪"：

- 倾向：落到控制面（`mounts.json` 同级或独立 `labels.json`，key 为 `mount:path`），暴露 `GET/PUT /foyer/labels`。
- 备选：写入 JuiceFS xattr（真持久、随卷走，但需 overlay 改动与批量读写成本）。
- 本设计**只预留报表字段**，具体持久化方案在该任务内单独设计评审。

## 明确不做（一期）

- 可 `juicefs load` 恢复的元数据备份（dump 包装）。
- 文件内容导出。
- POSIX `inode/mode/uid/gid/nlink`（`detail=full` 预留，需逐路径 stat）。
- `atime` / `ctime`（上游 `object.Object` 不暴露）。
- XLSX 多 sheet、NDJSON 流式、服务端生成、异步任务产物。
- Web 标签的真实值（依赖前置任务）。

## 测试

- `build.ts` / `format.ts` 纯函数单测：空目录、目录/文件混排、`mtime` 缺失为 `null`、`by_extension` 排序确定性、CSV 逗号/引号/换行转义、`tags`/`custom_meta` 的 JSON 单元格、`truncated` 口径。
- `walk.ts`：以注入的假 `list`/`stat` 验证递归、目录 mtime 合入、分批调用、错误进 `errors` 且计数对齐。
- 手工：对真实挂载导出 `photos:/` 与 `photos:/2026`，校验行数/字节数与文件页一致；CSV 用 Excel 打开无乱码、时间列不串位。

## 落地后的已知限制与已接受取舍

1. **`source.mount_spec` 原样带出，不脱敏**（已与用户确认接受）。今天不可能漏凭据：`web/src/api/client.ts` 拒绝创建非 `local` 挂载，`spec` 里只有宿主路径（`root`/`dest`/`mode`）。但 `GET /foyer/mounts` 本身不脱敏，日后若支持对象存储类挂载，`access_key`/`secret_key` 这类键会随报表带出——**届时应改为白名单过滤**。
2. **`error_count` 是记录条数而非失败路径数**，详见「错误 `errors[]`」一节的三种情况。
3. **每批一条的未解析错误无法区分「控制面报错」与「控制面没有 mtime」**。这是为不改 `WalkDeps.stat` 接口而选的轻量方案（该接口返回 `Map<string,string>`，没有回传逐路径错误的通道）。要精确区分需扩展该接口。
4. **导出为串行 + 全量驻留内存**，上限 5 万条。如果将来上限调高或改流式，需要重新评估内存与耗时，并为 stat 阶段也补进度。
5. **进度/取消的界面行为没有自动化测试**：本仓库 vitest 为 `environment: 'node'`，无 DOM，React 组件渲染不了，加 DOM 测试环境被明确排除在一期之外。该部分只由 `tsc --noEmit` 把关，需人工浏览器验收（见下）。

## 人工验收清单（需真实浏览器 + 栈，自动化覆盖不到）

1. `photos:/` 与 `photos:/2026` 各导一次，行数/字节数与文件页一致。
2. JSON：`schema`、`scope.path`、`source`、`entries` 按 `path` 升序、目录的 `mtime_source` 为 `stat`、`summary.entry_count` 正确。
3. CSV 用 Excel 打开无乱码（BOM）、时间列不串位、`tags`/`custom_meta` 两列是 JSON 文本。
4. 同一目录连续导两次，文件逐字节一致。
5. 根目录明细行存在（scope 根自身也是一条）。
6. 删掉/改名某个子目录后再导，`errors[]` 有对应记录且 `error_count` 对齐。
7. 导大目录：过程中能看到 `已读取 N 条` 递增；点「取消」后按钮变「正在停止…」，随后显示「已取消，未生成报表」且**没有文件下载**；导出中直接关闭弹窗同样不产生下载。

## 待评审确认

1. 上述字段集与列序是否够用/是否要增删。
2. `ref` 是否保留——它含挂载名，跨挂载不可直接比较；也可只用 `mount + path` 两列。
3. CSV 的 `tags/custom_meta` 是否接受 JSON 文本承载，还是拆成 `tags` 分号串更顺手。
4. 软上限取值（5 万条是否合适）。
