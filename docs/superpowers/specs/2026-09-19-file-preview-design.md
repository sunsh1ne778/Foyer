# 文件预览 设计

日期：2026-09-19
状态：已确认（2026-09-19）

## 问题

`FileExplorer` 里单击文件只在右侧 `FileStatDrawer` 展示属性（`web/src/components/FileExplorer.tsx:147-159` 的 `handleNodeClick`），唯一能拿到**内容**的出口是「下载」——`downloadNode` → `jfs.getObjectBlob` → 生成 `Blob` 落盘（`web/src/context/FileStoreContext.tsx:646-654`、`web/src/api/jfs.ts:252-259`）。用户为了看一眼图片、一段日志或一个表格，必须先下载再本地打开。

需要「双击文件就能在控制台里看到内容」。

## 目标

- 双击文件打开**居中模态**预览；覆盖图片、文本/代码、PDF、音视频、docx、xlsx/csv。
- 图片/PDF/音视频走**预签名 URL 直连 S3 网关**，由浏览器原生 Range 流式加载——大文件不占前端内存、音视频可拖动进度。
- 文本/Office 按类型**有界读取**，绝不把整个大文件拉进内存。
- 不支持或过大的类型优雅降级为「请下载查看」，读取失败展示原因，不静默失败。
- 类型判定、上限、文本解码、表格转换、目标映射全部是**纯函数**，可在现有 vitest（node 环境）下单测。

## 非目标

- **不做语法高亮**（不引入 highlight.js/Prism 之类）。
- **不渲染 Markdown、不渲染 HTML**：`md`/`html` 一律按**源码文本**展示，绝不用 `innerHTML` 注入文档内容（避免 XSS）。
- **不渲染 pptx / doc 旧格式** → 降级为下载（`xls` 由 SheetJS 顺带支持，不额外做降级）。
- 不做服务端转换（仓库没有 LibreOffice 之类的转换设施，也不该为预览压控制面）。
- 不做列表内缩略图、不做预览里切换上/下一个文件、不做编辑、不做预览历史。

## 方案总览

```
双击 / 点「预览」
  → context.openPreview(target)
  → jfs.presignGetUrl(s3Key, 900)                       # 新增 @aws-sdk/s3-request-presigner
  → previewPlanFor(name, size) 决定 kind/mode/上限
        stream   → 预签名 URL 直接交给 <iframe>/<video>/<audio>（原生 Range，不设限）
        memory   → 图片：预签名 URL 直给 <img>（浏览器流式解码，但先过 20MB 闸门）
                   docx/表格：fetch(url) 有界读入（≤20MB）→ 解析 → 渲染
        truncate → fetch(url) 读前 1MB → 解码 → 渲染 + 截断提示
        blocked  → UnsupportedPreview（原因 + 下载）
```

> `mode` 描述的是**是否受内存上限闸门约束**，不是传输方式：图片与 docx/表格同为 `memory`，但只有 docx/表格需要前端读字节，图片把 URL 交给 `<img>` 即可。

| 单元 | 职责 | 依赖 |
|---|---|---|
| `web/src/preview/classify.ts`（新，纯函数） | 扩展名 → `PreviewKind`；`previewPlanFor(name, size)` → `{kind, mode, maxBytes}` | 无 |
| `web/src/preview/text.ts`（新，纯函数） | `looksBinary(bytes)`（前 8KB 找 NUL）、`decodeText(bytes)`（UTF-8 `fatal:false`） | `TextDecoder` |
| `web/src/preview/sheet.ts`（新，纯函数） | 工作簿 → `SheetTable[]`（sheet 名 + 二维行），`sheet_to_json` 由调用方注入 | 无（注入依赖，node 测试不加载 xlsx） |
| `web/src/preview/target.ts`（新，纯函数） | `FSNode` / `SearchHit` → 统一 `PreviewTarget` | `types.ts` |
| `web/src/api/jfs.ts` | `presignGetUrl(key, expiresIn=900)`、`fetchObjectBytes(url, maxBytes)`（有界流式读取，超限返回 `truncated`） | S3 客户端 + presigner |
| `web/src/components/preview/FilePreviewModal.tsx`（新） | 模态外壳：头部（图标/名称/大小/类型徽标/下载/关闭）、Esc 关闭、锁 body 滚动、按 kind 分派 | 下列渲染器 |
| `web/src/components/preview/{Image,Pdf,Media,Text,Docx,Sheet,Unsupported}Preview.tsx`（新） | 各类型渲染器；docx/xlsx 用动态 `import()` 懒加载 | 上列 |
| `web/src/context/FileStoreContext.tsx` | `previewTarget`、`openPreview`、`closePreview` | 上列 |
| `web/src/components/FileExplorer.tsx` | 表格行/网格卡片双击、行操作「眼睛」按钮 | 上列 |
| `web/src/components/SearchResults.tsx` | 结果行双击（仅文件） | 上列 |
| `web/src/components/FileStatDrawer.tsx` | 头部「预览」按钮（仅文件） | 上列 |
| `web/src/App.tsx` | 挂载 `<FilePreviewModal />` | 上列 |

> 说明：Go 后端其实已有 `GET /v1/fs` 读接口（`server/internal/httpapi/router.go:80,325-350`，支持 `Range` 与 307 重定向）。但当前控制台运行在 **JuiceFS 模式**，所有数据面操作都直连 S3 网关（`jfs.ts`），不经 `/v1`，故预览同样走 S3 预签名，保持单一数据通路。

## 类型判定与上限（`preview/classify.ts`）

```ts
export type PreviewKind = 'image' | 'pdf' | 'media' | 'text' | 'docx' | 'sheet' | 'unsupported';
export type PreviewMode = 'stream' | 'memory' | 'truncate' | 'blocked';
export interface PreviewPlan { kind: PreviewKind; mode: PreviewMode; maxBytes: number | null }
export const PREVIEW_MEMORY_MAX_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;
```

| 类型 | 扩展名 | mode | 上限 | 渲染 |
|---|---|---|---|---|
| 图片 | `png jpg jpeg gif webp avif bmp svg ico` | `memory` | 20MB，超出 `blocked` | `<img src={presignedUrl}>`（`<img>` 里 SVG 不执行脚本） |
| PDF | `pdf` | `stream` | 不限 | `<iframe src={presignedUrl}>` + 新标签打开 |
| 音视频 | `mp4 webm mov m4v ogv` / `mp3 wav flac ogg m4a aac` | `stream` | 不限 | `<video|audio controls>`（不自动播放） |
| 文本/代码 | `txt md json yaml yml xml log go ts tsx js jsx py java c sql sh ps1 css ini conf` | `truncate` | 1MB，超出只读前 1MB | `<pre>` 等宽 + `whitespace-pre-wrap` |
| docx | `docx` | `memory` | 20MB，超出 `blocked` | `docx-preview` 动态加载 |
| 表格 | `xlsx xls csv` | `memory` | 20MB，超出 `blocked` | SheetJS 动态加载 → React 表格 |
| 其余 | 目录、`pptx doc`、未知 | `blocked` | — | 下载兜底 |

规则细节：

- 扩展名判定**大小写不敏感**、取最后一个 `.` 之后；无扩展名或未知 → `unsupported`。
- **目录不进入预览**（判 `blocked`，调用侧也守卫 `isDir`）。
- `size` 缺席（`undefined`）时：图片/docx/表格不因大小 `blocked`（S3 列表正常都给 size），上限在读取时兜底；文本始终 `truncate`。
- 超限的**图片/Office** → `blocked`（无法截断），模态给「文件超过 20MB，请下载查看」。
- 超限的**文本** → 仍 `truncate`，读 1MB 后主动中止流，模态提示「仅显示前 1MB，完整内容请下载」。

## 数据通路（`jfs.ts`）

```ts
export async function presignGetUrl(fileKey: string, expiresIn = 900): Promise<string>;
// 用 s3() 客户端 + getSignedUrl(GetObjectCommand{Bucket:JFS_BUCKET, Key}), 复用现有鉴权与 forcePathStyle。

export async function fetchObjectBytes(
  url: string,
  maxBytes: number | null
): Promise<{ bytes: Uint8Array; truncated: boolean }>;
// fetch(url) → res.body.getReader() 累积；达到 maxBytes 即 reader.cancel() 并 truncated=true；
// maxBytes=null 时读满。响应非 2xx 抛 ApiError（带状态码）。
```

- key 由现有 `refToKey` 归一（`mount:path` → S3 key）。
- 预签名 URL 只在打开模态时按需生成，**不落日志**，默认 900s 过期，关闭模态即弃（`useEffect` 清理，组件卸载后忽略迟到的 `setState`）。
- `fetch(预签名URL)` 是跨源读取，依赖 S3 网关返回 CORS 头。现有 `listPrefix`/`getObjectBlob` 已经用浏览器 SDK 直连同一网关并读取响应体，证明 CORS 已开；此假设记入风险。

## UI 行为

### 模态外壳

- 居中大面板（约 `max-w-6xl`、高 `85vh`），半透明遮罩，`z-50`（与 `UploadModal` 同级）。
- 头部：类型图标、文件名（`title` 全名）、`formatBytes(size)`、类型徽标、**下载**按钮、关闭按钮。
- **Esc 关闭**；打开时锁 `document.body` 滚动；关闭后焦点交回触发元素（尽力而为）。
- body：`flex-1 overflow-auto`，渲染器内部滚动，不撑破布局。
- 所有类型失败态统一为「原因 + 下载」；`unsupported`/`blocked` 显示原因文案 + 下载按钮。

### 各渲染器

- `ImagePreview`：居中、`object-contain`、`max-h-full`；`onError` → 失败态。
- `PdfPreview`：`<iframe>` 撑满；顶部「新标签打开」链接。
- `MediaPreview`：`<video>`/`<audio controls>`，加 `key` 防串台；`onError` → 失败态。
- `TextPreview`：`looksBinary` 为真 → 「疑似二进制文件」+ 下载；否则 `decodeText` 后 `<pre>`；`truncated` 时顶部提示条。
- `DocxPreview`：动态 `import('docx-preview')`，`renderAsync(blob, container)`；加载中显示骨架。
- `SheetPreview`：动态 `import('xlsx')`，`XLSX.read(bytes,{type:'array'})` → `workbookToTables(wb, XLSX.utils.sheet_to_json)` → sheet 标签 + React `<table>`；空表显示空状态。
- 懒加载失败（离线/chunk 错）→ 失败态 + 下载，不让模态白屏。

### 入口

| 位置 | 交互 |
|---|---|
| `FileExplorer` 表格行 | `onDoubleClick`：仅文件打开预览（目录保持单击进入） |
| `FileExplorer` 网格卡片 | `onDoubleClick`：同上 |
| `FileExplorer` 行操作区 | 文件新增「眼睛」图标按钮（键盘/触摸可发现性） |
| `SearchResults` 行 | `onDoubleClick`：`targetFromHit` → 仅文件打开预览 |
| `FileStatDrawer` 头部 | 文件新增「预览」按钮 |

统一走 `openPreview(targetFromNode(node))`；`openPreview` 对 `isDir`/`blocked` 也可打开（模态会展示原因），但入口层已先守卫 `isDir`。

## 依赖（已核实可解析）

| 包 | 版本 | 用途 |
|---|---|---|
| `@aws-sdk/s3-request-presigner` | `^3.1136.0` | 生成 `GetObject` 预签名 URL（与现有 `@aws-sdk/client-s3@^3.1135.0` 同大版本） |
| `docx-preview` | `^0.4.0` | docx → HTML |
| `xlsx` | `^0.18.5` | xlsx/xls/csv 解析（SheetJS 社区版 npm 最新） |

`docx-preview` 与 `xlsx` 一律**动态 `import()`**，不进首屏包。

## 测试

Web（vitest，node 环境，纯函数为主；`include: ['src/**/*.test.ts']`）：

- `classify.test.ts`：各扩展名 → kind（大小写不敏感、无扩展名、未知、目录）；`stream|memory|truncate|blocked` 分派；20MB 边界（恰好/超出）；文本 1MB 边界且不被 size `blocked`；音视频都归 `media`；未知 size 的分支。
- `text.test.ts`：UTF-8 正常解码；含 NUL 判二进制；多字节字符跨边界不崩。
- `sheet.test.ts`：注入假 `sheet_to_json`，验证多 sheet、空表、`SheetNames` 顺序；`defval`/`header:1` 选项透传。
- `target.test.ts`：`FSNode`/`SearchHit` → `PreviewTarget` 字段映射与 `isDir`。
- `jfs.presign.test.ts`：mock `getSignedUrl`（`vi.mock`），断言 `Bucket=JFS_BUCKET`、`Key` 已归一、`expiresIn` 透传；`fetchObjectBytes` 用假 `ReadableStream` 验证「达上限即 cancel 且 `truncated=true`」与「读满」。

手工端到端（沿用 `scripts/run-foyer.ps1` + 真实网关）：

- 上传一张图、一个 `.log`、一个 `.pdf`、一个 `.mp4`、一个 `.docx`、一个 `.xlsx`，逐个双击验证渲染。
- 造一个 >1MB 文本确认截断提示；造一个 >20MB 图片/Office 确认降级为下载。
- 视频确认可拖动进度（Range 生效）；关闭模态后 Network 里预签名请求不再复用。

## 已知边界与风险

- **预签名 URL 是 bearer 凭据**：任何拿到 URL 的人都能在有效期内读取该对象。缓解：仅按需生成、默认 900s、不落日志、不持久化。
- **依赖 S3 网关 CORS**：文本/Office 需要 `fetch(预签名URL)` 跨源读取。若网关 CORS 关闭，图片/PDF/音视频（媒体元素，不需要 CORS 即可展示）仍可用，文本/Office 会失败并降级到下载。
- **docx-preview 渲染不可信文档**：文档内引用的外部图片可能导致浏览器发起外网请求（IP 泄露）。本期不做沙箱化，仅限已登录控制台用户上传的文件；如需收紧，后续可在 sandbox iframe 内渲染。
- **`xlsx@0.18.5` 非 SheetJS 最新发行渠道**：存在历史 ReDoS/原型污染类公告。缓解：仅解析用户自己上传的文件，且有 20MB 上限；后续可评估换发行渠道或替代库。
- **PDF `<iframe>` 依赖浏览器内置 PDF 查看器**：个别浏览器/配置不内置时显示为下载提示；已提供「新标签打开」与下载兜底。
- **不改后端、不改 OpenAPI**：本次纯前端；`/v1/fs` 仍不被此 UI 使用。
- **不做并发预取**：一次只预览一个文件，关闭即释放。

## 已确认的决定

1. 覆盖类型：图片、文本/代码、PDF、音视频、docx、xlsx/csv；pptx/doc 降级下载。
2. 展示方式：**双击文件 → 居中模态**（右侧抽屉继续负责属性）。
3. 数据通路：**预签名 URL 直连 S3 网关**，原生 Range 流式（新增 `@aws-sdk/s3-request-presigner`）。
4. Office 取舍：**docx 用 docx-preview、xlsx/csv 用 SheetJS，pptx 降级下载**。
5. 上限：PDF/音视频流式**不设限**；图片/Office **20MB**，超出降级下载；文本 **1MB 截断**并提示。
6. 入口：表格行双击、网格卡片双击、行操作「眼睛」按钮、深度检索结果行双击、属性抽屉「预览」按钮。
7. 测试以**纯函数**为主（判定/上限/解码/表格/映射/有界读取），组件靠手工端到端验证。
