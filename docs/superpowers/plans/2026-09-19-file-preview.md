# 文件预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 双击文件即可在控制台居中模态里预览图片、文本/代码、PDF、音视频、docx、xlsx/csv；不支持的或过大的类型优雅降级为下载。

**Architecture:** 前端纯新增。`PreviewTarget` 把 `FSNode`/`SearchHit` 归一；`preview/classify.ts` 等纯函数决定类型与上限；`jfs.presignGetUrl` 生成预签名 URL，图片/PDF/音视频交给浏览器原生元素（Range 流式），文本/Office 经 `fetchObjectBytes` 有界读取后渲染（docx-preview / SheetJS 动态加载）。`FilePreviewModal` 由 context 的 `previewTarget` 驱动，挂在 `App.tsx` 底部。

**Tech Stack:** React 19 + TypeScript、Vite 8、vitest（node 环境）、`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`、`docx-preview`、`xlsx`。

## Global Constraints

- 不改 Go 后端、不改 `api/openapi.yaml`：本次纯前端。
- 依赖版本固定：`@aws-sdk/s3-request-presigner@^3.1136.0`、`docx-preview@^0.4.0`、`xlsx@^0.18.5`。安装一律加 `--legacy-peer-deps`（仓库既有约定）。
- 上限：PDF/音视频 `stream` **不设限**；图片/docx/xlsx/csv `memory` 上限 **20MB**，超出 `blocked`；文本/代码 `truncate` 上限 **1MB**，超出只读前 1MB 并提示。
- `md`/`html` 一律按**源码文本**展示；**禁止**把文档内容 `innerHTML` 注入 DOM。SVG 只经 `<img>` 渲染。
- 客户端取数统一走 `web/src/api/client.ts`；**组件不得直接 import `web/src/api/jfs.ts`**。
- 预签名 URL 按需生成、默认 `900` 秒、**不写日志**、不持久化。
- vitest 是 node 环境且只 `include: ['src/**/*.test.ts']`（`web/vite.config.ts`）。**不要**引入 jsdom、testing-library 或 `*.test.tsx`；组件用 `npm run lint` + 手工浏览器验证。
- 所有 UI 文案用中文，与现有组件一致。
- 命令在 `web/` 目录下执行。本机是 Windows PowerShell，**不支持 `&&`**，多命令用 `;` 连接。

---

### Task 1: 预览类型判定与上限（纯函数）

**Files:**
- Create: `web/src/preview/classify.ts`
- Test: `web/src/preview/classify.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type PreviewKind = 'image' | 'pdf' | 'media' | 'text' | 'docx' | 'sheet' | 'unsupported'`
  - `type PreviewMode = 'stream' | 'memory' | 'truncate' | 'blocked'`
  - `interface PreviewPlan { kind: PreviewKind; mode: PreviewMode; maxBytes: number | null }`
  - `PREVIEW_MEMORY_MAX_BYTES = 20 * 1024 * 1024`、`PREVIEW_TEXT_MAX_BYTES = 1024 * 1024`
  - `extensionOf(name: string): string`
  - `previewKindFor(name: string): PreviewKind`
  - `mediaIsVideo(name: string): boolean`
  - `previewPlanFor(name: string, size?: number | null): PreviewPlan`

- [ ] **Step 1: 写失败测试**

创建 `web/src/preview/classify.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_MEMORY_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  extensionOf,
  mediaIsVideo,
  previewKindFor,
  previewPlanFor,
} from './classify';

describe('extensionOf', () => {
  it('取最后一段并小写', () => {
    expect(extensionOf('A.DNG')).toBe('dng');
    expect(extensionOf('a.b.PNG')).toBe('png');
  });

  it('无点、首点、尾点都返回空串', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('a.')).toBe('');
  });
});

describe('previewKindFor', () => {
  it('识别各家族', () => {
    expect(previewKindFor('a.png')).toBe('image');
    expect(previewKindFor('a.svg')).toBe('image');
    expect(previewKindFor('a.pdf')).toBe('pdf');
    expect(previewKindFor('a.MP4')).toBe('media');
    expect(previewKindFor('a.mp3')).toBe('media');
    expect(previewKindFor('a.md')).toBe('text');
    expect(previewKindFor('a.LOG')).toBe('text');
    expect(previewKindFor('a.docx')).toBe('docx');
    expect(previewKindFor('a.xlsx')).toBe('sheet');
    expect(previewKindFor('a.csv')).toBe('sheet');
    expect(previewKindFor('a.xls')).toBe('sheet');
  });

  it('旧 Office、未知、无扩展名都归 unsupported', () => {
    expect(previewKindFor('a.pptx')).toBe('unsupported');
    expect(previewKindFor('a.doc')).toBe('unsupported');
    expect(previewKindFor('a.zip')).toBe('unsupported');
    expect(previewKindFor('README')).toBe('unsupported');
  });
});

describe('mediaIsVideo', () => {
  it('区分视频与音频', () => {
    expect(mediaIsVideo('a.mp4')).toBe(true);
    expect(mediaIsVideo('a.ogv')).toBe(true);
    expect(mediaIsVideo('a.ogg')).toBe(false);
    expect(mediaIsVideo('a.mp3')).toBe(false);
  });
});

describe('previewPlanFor', () => {
  it('pdf 与音视频流式、不设限', () => {
    expect(previewPlanFor('a.pdf', 500 * 1024 * 1024)).toEqual({
      kind: 'pdf',
      mode: 'stream',
      maxBytes: null,
    });
    expect(previewPlanFor('a.mp4', 500 * 1024 * 1024)).toEqual({
      kind: 'media',
      mode: 'stream',
      maxBytes: null,
    });
  });

  it('文本一律 1MB 截断，与大小无关', () => {
    expect(previewPlanFor('a.log', 10)).toEqual({
      kind: 'text',
      mode: 'truncate',
      maxBytes: PREVIEW_TEXT_MAX_BYTES,
    });
    expect(previewPlanFor('a.log', 500 * 1024 * 1024)).toEqual({
      kind: 'text',
      mode: 'truncate',
      maxBytes: PREVIEW_TEXT_MAX_BYTES,
    });
  });

  it('图片/docx/表格走 20MB 闸门，超出转 blocked', () => {
    expect(previewPlanFor('a.png', 10)).toEqual({
      kind: 'image',
      mode: 'memory',
      maxBytes: PREVIEW_MEMORY_MAX_BYTES,
    });
    expect(previewPlanFor('a.docx', 10).mode).toBe('memory');
    expect(previewPlanFor('a.xlsx', 10).mode).toBe('memory');
    expect(previewPlanFor('a.png', PREVIEW_MEMORY_MAX_BYTES).mode).toBe('memory');
    expect(previewPlanFor('a.png', PREVIEW_MEMORY_MAX_BYTES + 1).mode).toBe('blocked');
    expect(previewPlanFor('a.docx', PREVIEW_MEMORY_MAX_BYTES + 1).mode).toBe('blocked');
  });

  it('size 缺席时仍走 memory（读取时兜底闸门）', () => {
    expect(previewPlanFor('a.png')).toEqual({
      kind: 'image',
      mode: 'memory',
      maxBytes: PREVIEW_MEMORY_MAX_BYTES,
    });
    expect(previewPlanFor('a.png', null).mode).toBe('memory');
  });

  it('unsupported 永远 blocked', () => {
    expect(previewPlanFor('a.pptx', 10)).toEqual({
      kind: 'unsupported',
      mode: 'blocked',
      maxBytes: null,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/preview/classify.test.ts`
Expected: FAIL，报 `Failed to resolve import "./classify"`。

- [ ] **Step 3: 写最小实现**

创建 `web/src/preview/classify.ts`：

```ts
/** 预览类型：决定用哪个渲染器。 */
export type PreviewKind = 'image' | 'pdf' | 'media' | 'text' | 'docx' | 'sheet' | 'unsupported';

/**
 * 读取策略——描述「是否受内存闸门约束」，不是传输方式：
 * stream   直给浏览器元素，不设限；
 * memory   有界读入（图片把 URL 给 <img>，但仍先过闸门）；
 * truncate 只读前一段；
 * blocked  不预览，降级下载。
 */
export type PreviewMode = 'stream' | 'memory' | 'truncate' | 'blocked';

export interface PreviewPlan {
  kind: PreviewKind;
  mode: PreviewMode;
  /** memory/truncate 的读取上限；stream/blocked 为 null。 */
  maxBytes: number | null;
}

export const PREVIEW_MEMORY_MAX_BYTES = 20 * 1024 * 1024;
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'log',
  'go', 'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'sql',
  'sh', 'ps1', 'css', 'ini', 'conf',
]);
const MEDIA_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);

/** 最后一个 `.` 之后的小写扩展名；无点/首点/尾点返回空串。 */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

export function previewKindFor(name: string): PreviewKind {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (MEDIA_EXTENSIONS.has(ext)) return 'media';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === 'docx') return 'docx';
  if (SHEET_EXTENSIONS.has(ext)) return 'sheet';
  return 'unsupported';
}

export function mediaIsVideo(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(name));
}

export function previewPlanFor(name: string, size?: number | null): PreviewPlan {
  const kind = previewKindFor(name);
  switch (kind) {
    case 'pdf':
    case 'media':
      return { kind, mode: 'stream', maxBytes: null };
    case 'text':
      return { kind, mode: 'truncate', maxBytes: PREVIEW_TEXT_MAX_BYTES };
    case 'image':
    case 'docx':
    case 'sheet':
      if (typeof size === 'number' && size > PREVIEW_MEMORY_MAX_BYTES) {
        return { kind, mode: 'blocked', maxBytes: null };
      }
      return { kind, mode: 'memory', maxBytes: PREVIEW_MEMORY_MAX_BYTES };
    default:
      return { kind: 'unsupported', mode: 'blocked', maxBytes: null };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/preview/classify.test.ts`
Expected: PASS（5 个 describe 全绿）。

- [ ] **Step 5: 提交**

```bash
git add web/src/preview/classify.ts web/src/preview/classify.test.ts
git commit -m "feat(web): add preview kind classification and size caps"
```

---

### Task 2: 文本解码与二进制判定（纯函数）

**Files:**
- Create: `web/src/preview/text.ts`
- Test: `web/src/preview/text.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `looksBinary(bytes: Uint8Array): boolean`、`decodeText(bytes: Uint8Array): string`。

- [ ] **Step 1: 写失败测试**

创建 `web/src/preview/text.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { decodeText, looksBinary } from './text';

describe('looksBinary', () => {
  it('遇到 NUL 判二进制', () => {
    expect(looksBinary(new Uint8Array([0x68, 0x00]))).toBe(true);
  });

  it('只扫描前缀，前缀外的 NUL 不管', () => {
    const bytes = new Uint8Array(9000);
    bytes[0] = 0x68;
    bytes[8999] = 0x00;
    expect(looksBinary(bytes)).toBe(false);
  });

  it('空输入与普通文本都算文本', () => {
    expect(looksBinary(new Uint8Array([]))).toBe(false);
    expect(looksBinary(new TextEncoder().encode('hello 世界'))).toBe(false);
  });
});

describe('decodeText', () => {
  it('UTF-8 往返', () => {
    expect(decodeText(new TextEncoder().encode('日志 世界'))).toBe('日志 世界');
  });

  it('非法字节替换为 U+FFFD 而不是抛错', () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe]))).toContain('\uFFFD');
  });

  it('空输入解码为空串', () => {
    expect(decodeText(new Uint8Array([]))).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/preview/text.test.ts`
Expected: FAIL，`Failed to resolve import "./text"`。

- [ ] **Step 3: 写最小实现**

创建 `web/src/preview/text.ts`：

```ts
/** 只在前 8KB 里找 NUL：足够识别二进制，又不必扫整个文件。 */
const BINARY_SCAN_BYTES = 8192;

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** 宽容解码：坏字节变 U+FFFD，绝不因为一个非法字节丢掉整份预览。 */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/preview/text.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/preview/text.ts web/src/preview/text.test.ts
git commit -m "feat(web): add text decode and binary sniffing helpers"
```

---

### Task 3: 工作簿 → 表格（纯函数）

**Files:**
- Create: `web/src/preview/sheet.ts`
- Test: `web/src/preview/sheet.test.ts`

**Interfaces:**
- Consumes: 无（`sheet_to_json` 由调用方注入，node 测试不加载 xlsx）。
- Produces:
  - `interface SheetTable { name: string; rows: string[][] }`
  - `type SheetToJson = (sheet: unknown, opts: Record<string, unknown>) => unknown[]`
  - `interface WorkBookLike { SheetNames: string[]; Sheets: Record<string, unknown> }`
  - `workbookToTables(wb: WorkBookLike, sheetToJson: SheetToJson): SheetTable[]`

- [ ] **Step 1: 写失败测试**

创建 `web/src/preview/sheet.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { workbookToTables, type WorkBookLike } from './sheet';

const wb: WorkBookLike = {
  SheetNames: ['S1', 'S2'],
  Sheets: { S1: { id: 1 }, S2: { id: 2 } },
};

describe('workbookToTables', () => {
  it('保持 sheet 顺序并把单元格转成字符串', () => {
    const sheetToJson = vi.fn((sheet: unknown) => {
      const id = (sheet as { id: number }).id;
      return id === 1 ? [['a', 1], [null, true]] : [['x']];
    });
    const tables = workbookToTables(wb, sheetToJson as never);
    expect(tables.map(t => t.name)).toEqual(['S1', 'S2']);
    expect(tables[0].rows).toEqual([['a', '1'], ['', 'true']]);
    expect(tables[1].rows).toEqual([['x']]);
  });

  it('按稠密矩阵 + 填空值的方式向 SheetJS 取数', () => {
    const sheetToJson = vi.fn(() => []);
    workbookToTables(wb, sheetToJson as never);
    expect(sheetToJson).toHaveBeenCalledWith(wb.Sheets.S1, { header: 1, defval: '', raw: false });
  });

  it('空工作表返回空 rows', () => {
    const tables = workbookToTables({ SheetNames: ['Empty'], Sheets: { Empty: {} } }, (() => []) as never);
    expect(tables).toEqual([{ name: 'Empty', rows: [] }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/preview/sheet.test.ts`
Expected: FAIL，`Failed to resolve import "./sheet"`。

- [ ] **Step 3: 写最小实现**

创建 `web/src/preview/sheet.ts`：

```ts
export interface SheetTable {
  name: string;
  rows: string[][];
}

/** SheetJS `utils.sheet_to_json` 的最小子集；注入是为了让 node 测试不必加载 xlsx。 */
export type SheetToJson = (sheet: unknown, opts: Record<string, unknown>) => unknown[];

export interface WorkBookLike {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}

/**
 * 把工作簿折成「每张表一个二维字符串矩阵」。
 * 走数据而非 HTML：单元格文本交给 React 渲染，绝不把表格内容拼成 innerHTML。
 */
export function workbookToTables(wb: WorkBookLike, sheetToJson: SheetToJson): SheetTable[] {
  return wb.SheetNames.map(name => {
    const raw = sheetToJson(wb.Sheets[name], { header: 1, defval: '', raw: false });
    const rows = (raw as unknown[][]).map(row =>
      (row || []).map(cell => (cell == null ? '' : String(cell)))
    );
    return { name, rows };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/preview/sheet.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/preview/sheet.ts web/src/preview/sheet.test.ts
git commit -m "feat(web): add workbook-to-table transform for sheet preview"
```

---

### Task 4: 预览目标归一（纯函数）

**Files:**
- Create: `web/src/preview/target.ts`
- Test: `web/src/preview/target.test.ts`

**Interfaces:**
- Consumes: `FSNode`、`SearchHit`（`web/src/types.ts`）。
- Produces:
  - `interface PreviewTarget { mount: string; key: string; name: string; size: number; isDir: boolean }`
  - `targetFromNode(node: FSNode): PreviewTarget`
  - `targetFromHit(hit: SearchHit): PreviewTarget`

- [ ] **Step 1: 写失败测试**

创建 `web/src/preview/target.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { targetFromHit, targetFromNode } from './target';
import type { FSNode, SearchHit } from '../types';

const node: FSNode = {
  mount_id: 'm',
  mount_name: 'foyer',
  key: '/a.log',
  name: 'a.log',
  is_dir: false,
  size: 12,
  mtime: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  tags: [],
  custom_meta: {},
};

const hit: SearchHit = {
  mount: 'av',
  key: '/raw/a.dng',
  name: 'a.dng',
  isDir: false,
  size: 99,
  mtime: '2026-01-01T00:00:00Z',
  volumePath: '/av/raw/a.dng',
};

describe('preview targets', () => {
  it('映射 FSNode', () => {
    expect(targetFromNode(node)).toEqual({
      mount: 'foyer',
      key: '/a.log',
      name: 'a.log',
      size: 12,
      isDir: false,
    });
  });

  it('映射 SearchHit', () => {
    expect(targetFromHit(hit)).toEqual({
      mount: 'av',
      key: '/raw/a.dng',
      name: 'a.dng',
      size: 99,
      isDir: false,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/preview/target.test.ts`
Expected: FAIL，`Failed to resolve import "./target"`。

- [ ] **Step 3: 写最小实现**

创建 `web/src/preview/target.ts`：

```ts
import type { FSNode, SearchHit } from '../types';

/** 预览的最小输入：文件列表与深度检索结果都能归一到它。 */
export interface PreviewTarget {
  mount: string;
  /** 挂载内绝对路径，如 /raw/a.dng */
  key: string;
  name: string;
  size: number;
  isDir: boolean;
}

export function targetFromNode(node: FSNode): PreviewTarget {
  return {
    mount: node.mount_name,
    key: node.key,
    name: node.name,
    size: node.size,
    isDir: node.is_dir,
  };
}

export function targetFromHit(hit: SearchHit): PreviewTarget {
  return { mount: hit.mount, key: hit.key, name: hit.name, size: hit.size, isDir: hit.isDir };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/preview/target.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/preview/target.ts web/src/preview/target.test.ts
git commit -m "feat(web): normalize file list and search hits into a preview target"
```

---

### Task 5: 预签名 URL 与有界读取

**Files:**
- Modify: `web/package.json`（新增 `@aws-sdk/s3-request-presigner`）
- Modify: `web/src/api/jfs.ts`
- Modify: `web/src/api/client.ts`
- Test: `web/src/api/jfs.presign.test.ts`

**Interfaces:**
- Consumes: `s3()`、`JFS_BUCKET`、`ApiError`（`web/src/api/jfs.ts` 既有）；`jfs.refToKey`、`jfs.presignGetUrl`、`jfs.fetchObjectBytes`。
- Produces:
  - `jfs.presignGetUrl(fileKey: string, expiresIn = 900): Promise<string>`
  - `jfs.fetchObjectBytes(url: string, maxBytes: number | null): Promise<{ bytes: Uint8Array; truncated: boolean }>`
  - `client.previewUrl(p: string): Promise<string>`
  - `client.readObjectBytes(url: string, maxBytes: number | null): Promise<{ bytes: Uint8Array; truncated: boolean }>`

- [ ] **Step 1: 装依赖**

Run: `npm install @aws-sdk/s3-request-presigner@^3.1136.0 --legacy-peer-deps`
Expected: `package.json` 的 `dependencies` 多出 `@aws-sdk/s3-request-presigner`。

- [ ] **Step 2: 写失败测试**

创建 `web/src/api/jfs.presign.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSignedUrlMock } = vi.hoisted(() => ({
  getSignedUrlMock: vi.fn(async () => 'https://signed.example/object'),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: getSignedUrlMock }));

import { ApiError } from './errors';
import { JFS_BUCKET, fetchObjectBytes, presignGetUrl } from './jfs';

beforeEach(() => {
  getSignedUrlMock.mockClear();
  // presignGetUrl 会经 s3() 读凭据；node 环境没有 localStorage，得替身。
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'fs_secret' ? 'secret' : 'access'),
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => vi.unstubAllGlobals());

function bodyResponse(chunks: Uint8Array[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe('presignGetUrl', () => {
  it('为归一后的 key 签一个 GetObject', async () => {
    await expect(presignGetUrl('/raw/a.dng')).resolves.toBe('https://signed.example/object');
    const [client, command, options] = getSignedUrlMock.mock.calls[0];
    expect(client).toBeTruthy();
    expect((command as { input: unknown }).input).toEqual({ Bucket: JFS_BUCKET, Key: 'raw/a.dng' });
    expect(options).toEqual({ expiresIn: 900 });
  });

  it('透传自定义有效期', async () => {
    await presignGetUrl('a.pdf', 60);
    expect(getSignedUrlMock.mock.calls[1][2]).toEqual({ expiresIn: 60 });
  });
});

describe('fetchObjectBytes', () => {
  it('不设限时读满', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse([new Uint8Array([1, 2]), new Uint8Array([3])])));
    const out = await fetchObjectBytes('https://signed.example/object', null);
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(false);
  });

  it('到上限即停并标记截断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])])));
    const out = await fetchObjectBytes('https://signed.example/object', 3);
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(true);
  });

  it('对象恰好在上限处结束不算截断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bodyResponse([new Uint8Array([1, 2, 3])])));
    const out = await fetchObjectBytes('https://signed.example/object', 3);
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(false);
  });

  it('非 2xx 抛 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchObjectBytes('https://signed.example/object', null)).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- src/api/jfs.presign.test.ts`
Expected: FAIL，报 `presignGetUrl is not a function` / `fetchObjectBytes is not a function`。

- [ ] **Step 4: 实现 `jfs.ts`**

在 `web/src/api/jfs.ts` 顶部 import 区加入：

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
```

在 `getObjectBlob`（约 `:252`）之后追加：

```ts
/** 生成对象读取用的预签名 URL。按需调用，默认 900 秒过期，不要写日志。 */
export async function presignGetUrl(fileKey: string, expiresIn = 900): Promise<string> {
  const key = fileKey.replace(/^\/+/, '');
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: JFS_BUCKET, Key: key }), { expiresIn });
}

export interface BoundedBytes {
  bytes: Uint8Array;
  truncated: boolean;
}

/**
 * 有界读取：最多 maxBytes 字节（null 表示读满），到上限立刻 cancel 掉流，
 * 绝不把整个大对象拉进内存。响应非 2xx 抛 ApiError。
 */
export async function fetchObjectBytes(url: string, maxBytes: number | null): Promise<BoundedBytes> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(`读取对象失败 (${res.status})`, res.status);

  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (maxBytes != null && all.byteLength > maxBytes) {
      return { bytes: all.slice(0, maxBytes), truncated: true };
    }
    return { bytes: all, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (maxBytes != null) {
      const remain = maxBytes - total;
      if (remain <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (value.byteLength > remain) {
        chunks.push(value.slice(0, remain));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}
```

- [ ] **Step 5: 实现 `client.ts` 包装**

在 `web/src/api/client.ts` 的 `downloadFile`（约 `:220`）之后追加：

```ts
/** 预览：生成挂载路径对应对象的预签名 URL。 */
export async function previewUrl(p: string): Promise<string> {
  return jfs.presignGetUrl(jfs.refToKey(p));
}

/** 预览：从预签名 URL 有界读取字节；maxBytes=null 时读满。 */
export async function readObjectBytes(url: string, maxBytes: number | null) {
  return jfs.fetchObjectBytes(url, maxBytes);
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test -- src/api/jfs.presign.test.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 7: 全量回归**

Run: `npm test; npm run lint`
Expected: 全部测试 PASS；`tsc --noEmit` 退出码 0。

- [ ] **Step 8: 提交**

```bash
git add web/package.json web/package-lock.json web/src/api/jfs.ts web/src/api/client.ts web/src/api/jfs.presign.test.ts
git commit -m "feat(web): presign object URLs and read preview bytes with a cap"
```

---

### Task 6: 模态外壳 + 图片/PDF/音视频渲染 + 文件列表入口

**Files:**
- Create: `web/src/components/preview/shared.tsx`
- Create: `web/src/components/preview/ImagePreview.tsx`
- Create: `web/src/components/preview/PdfPreview.tsx`
- Create: `web/src/components/preview/MediaPreview.tsx`
- Create: `web/src/components/preview/UnsupportedPreview.tsx`
- Create: `web/src/components/preview/FilePreviewModal.tsx`
- Modify: `web/src/context/FileStoreContext.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/FileExplorer.tsx`

**Interfaces:**
- Consumes: `previewPlanFor`/`PreviewPlan`、`mediaIsVideo`（Task 1）；`PreviewTarget`/`targetFromNode`（Task 4）；`api.previewUrl`、`api.readObjectBytes`（Task 5）。
- Produces:
  - `interface PreviewRendererProps { url: string; target: PreviewTarget; plan: PreviewPlan; onDownload: () => void }`（`shared.tsx`）
  - `PreviewMessage({ title, detail?, onDownload? })`（`shared.tsx`）
  - context 新增 `previewTarget: PreviewTarget | null`、`openPreview(target: PreviewTarget): void`、`closePreview(): void`、`downloadTarget(target: PreviewTarget): Promise<void>`
  - `<FilePreviewModal />`

- [ ] **Step 1: 写共享 props 与空状态组件**

创建 `web/src/components/preview/shared.tsx`：

```tsx
import React from 'react';
import { Download, FileWarning } from 'lucide-react';
import type { PreviewPlan } from '../../preview/classify';
import type { PreviewTarget } from '../../preview/target';

export interface PreviewRendererProps {
  url: string;
  target: PreviewTarget;
  plan: PreviewPlan;
  onDownload: () => void;
}

/** 预览的统一空/错误态：一句原因 + 下载兜底。 */
export const PreviewMessage: React.FC<{
  title: string;
  detail?: string;
  onDownload?: () => void;
}> = ({ title, detail, onDownload }) => (
  <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
    <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400">
      <FileWarning className="w-6 h-6" />
    </div>
    <div className="text-sm font-semibold text-slate-700">{title}</div>
    {detail ? <div className="text-xs text-slate-500 max-w-md break-all">{detail}</div> : null}
    {onDownload ? (
      <button
        type="button"
        onClick={onDownload}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
        下载文件
      </button>
    ) : null}
  </div>
);
```

- [ ] **Step 2: 写图片/PDF/音视频/降级渲染器**

创建 `web/src/components/preview/ImagePreview.tsx`：

```tsx
import React, { useState } from 'react';
import { PreviewMessage, type PreviewRendererProps } from './shared';

export const ImagePreview: React.FC<PreviewRendererProps> = ({ url, target, onDownload }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <PreviewMessage
        title="无法显示图片"
        detail="浏览器无法解码该图片，请下载后用本地工具打开。"
        onDownload={onDownload}
      />
    );
  }
  return (
    <div className="h-full w-full flex items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={target.name}
        onError={() => setFailed(true)}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  );
};
```

创建 `web/src/components/preview/PdfPreview.tsx`：

```tsx
import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { PreviewRendererProps } from './shared';

export const PdfPreview: React.FC<PreviewRendererProps> = ({ url, target }) => (
  <div className="h-full w-full flex flex-col">
    <div className="flex items-center justify-end px-3 py-1.5 border-b border-slate-200 bg-white text-xs shrink-0">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        新标签打开
      </a>
    </div>
    <iframe title={target.name} src={url} className="flex-1 w-full border-0 bg-white" />
  </div>
);
```

创建 `web/src/components/preview/MediaPreview.tsx`：

```tsx
import React, { useState } from 'react';
import { mediaIsVideo } from '../../preview/classify';
import { PreviewMessage, type PreviewRendererProps } from './shared';

export const MediaPreview: React.FC<PreviewRendererProps> = ({ url, target, onDownload }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <PreviewMessage
        title="无法播放该媒体"
        detail="浏览器不支持该编码，请下载后用本地播放器打开。"
        onDownload={onDownload}
      />
    );
  }
  return (
    <div className="h-full w-full flex items-center justify-center p-4">
      {mediaIsVideo(target.name) ? (
        <video
          key={url}
          src={url}
          controls
          onError={() => setFailed(true)}
          className="max-w-full max-h-full bg-black"
        />
      ) : (
        <audio key={url} src={url} controls onError={() => setFailed(true)} className="w-full max-w-xl" />
      )}
    </div>
  );
};
```

创建 `web/src/components/preview/UnsupportedPreview.tsx`：

```tsx
import React from 'react';
import { PreviewMessage, type PreviewRendererProps } from './shared';

/** 不支持的类型与超限文件共用：说明原因 + 下载。 */
export const UnsupportedPreview: React.FC<PreviewRendererProps> = ({ plan, onDownload }) => {
  const reason =
    plan.kind === 'unsupported'
      ? '该文件类型暂不支持在线预览。'
      : '文件超过 20MB，为免拖慢浏览器，请下载查看。';
  return <PreviewMessage title="无法在线预览" detail={reason} onDownload={onDownload} />;
};
```

- [ ] **Step 3: 写模态外壳**

创建 `web/src/components/preview/FilePreviewModal.tsx`：

```tsx
import React, { useEffect, useState } from 'react';
import { Download, FileWarning, X } from 'lucide-react';
import { useFileStore } from '../../context/FileStoreContext';
import { previewPlanFor } from '../../preview/classify';
import { formatBytes } from '../../utils/formatters';
import * as api from '../../api/client';
import { PreviewMessage } from './shared';
import { ImagePreview } from './ImagePreview';
import { PdfPreview } from './PdfPreview';
import { MediaPreview } from './MediaPreview';
import { UnsupportedPreview } from './UnsupportedPreview';

export const FilePreviewModal: React.FC = () => {
  const { previewTarget, closePreview, downloadTarget } = useFileStore();
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState('');

  const target = previewTarget;
  const mount = target?.mount;
  const key = target?.key;

  useEffect(() => {
    if (!mount || !key) return;
    let alive = true;
    setUrl(null);
    setUrlError('');
    api
      .previewUrl(api.joinRef(mount, key))
      .then(u => {
        if (alive) setUrl(u);
      })
      .catch(err => {
        if (alive) setUrlError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [mount, key]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    // 尽力把焦点交回触发元素：行双击时 activeElement 可能是 body，focus 无害。
    const opener = document.activeElement as HTMLElement | null;
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [target, closePreview]);

  if (!target) return null;

  const plan = previewPlanFor(target.name, target.size);
  const onDownload = () => void downloadTarget(target);

  const body = urlError ? (
    <PreviewMessage title="生成预览链接失败" detail={urlError} onDownload={onDownload} />
  ) : plan.mode === 'blocked' || !url ? (
    plan.mode === 'blocked' ? (
      <UnsupportedPreview url="" target={target} plan={plan} onDownload={onDownload} />
    ) : (
      <div className="h-full flex items-center justify-center text-xs text-slate-400">正在准备预览…</div>
    )
  ) : plan.kind === 'image' ? (
    <ImagePreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : plan.kind === 'pdf' ? (
    <PdfPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : plan.kind === 'media' ? (
    <MediaPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : (
    <UnsupportedPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  );

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
      onClick={closePreview}
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileWarning className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="font-semibold text-sm text-slate-900 truncate" title={target.name}>
              {target.name}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-500 font-mono shrink-0">
              {plan.kind}
            </span>
            <span className="text-[11px] text-slate-400 font-mono shrink-0">{formatBytes(target.size)}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onDownload}
              title="下载"
              className="p-1 rounded-md hover:bg-slate-200/70 text-slate-500 hover:text-emerald-600 transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={closePreview}
              title="关闭 (Esc)"
              className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden bg-slate-50">{body}</div>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: 接进 context**

在 `web/src/context/FileStoreContext.tsx`：

1. import 区（`import { parseRef } from '../utils/formatters';` 之后）加：

```ts
import { targetFromNode, type PreviewTarget } from '../preview/target';
```

2. `interface FileStoreContextType` 里 `downloadNode: (node: FSNode) => Promise<void>;` 之后加：

```ts
  previewTarget: PreviewTarget | null;
  openPreview: (target: PreviewTarget) => void;
  closePreview: () => void;
  downloadTarget: (target: PreviewTarget) => Promise<void>;
```

3. 状态区（`const [isExportOpen, setIsExportOpen] = useState(false);` 之后）加：

```ts
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
```

4. `downloadNode`（约 `:646`）替换为：

```ts
  const downloadTarget = async (target: PreviewTarget) => {
    if (target.isDir) return;
    const p = api.joinRef(target.mount, target.key);
    try {
      await api.downloadFile(p, target.name);
    } catch (err) {
      reportError(err);
    }
  };

  const downloadNode = async (node: FSNode) => downloadTarget(targetFromNode(node));

  const openPreview = (target: PreviewTarget) => setPreviewTarget(target);
  const closePreview = () => setPreviewTarget(null);
```

5. `value={{ ... }}` 里 `downloadNode,` 之后加：

```ts
        previewTarget,
        openPreview,
        closePreview,
        downloadTarget,
```

- [ ] **Step 5: 挂载模态**

在 `web/src/App.tsx`：

1. import 区加：

```tsx
import { FilePreviewModal } from './components/preview/FilePreviewModal';
```

2. `<ExportReportModal />` 之后加：

```tsx
      <FilePreviewModal />
```

- [ ] **Step 6: 文件列表入口**

在 `web/src/components/FileExplorer.tsx`：

1. lucide 图标列表里加 `Eye`（`Download,` 之后一行 `Eye,`）。
2. 加 import：

```tsx
import { targetFromNode } from '../preview/target';
```

3. `useFileStore()` 解构里 `downloadNode,` 之后加 `openPreview,`。
4. 表格行 `<tr key={node.key} onClick={() => handleNodeClick(node)}` 后加：

```tsx
                    onDoubleClick={() => {
                      if (!node.is_dir) openPreview(targetFromNode(node));
                    }}
```

5. 表格操作区、`{!node.is_dir && (` 的下载按钮**之前**加：

```tsx
                        {!node.is_dir && (
                          <button
                            onClick={() => openPreview(targetFromNode(node))}
                            title="预览"
                            className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-indigo-600 transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
```

6. 网格卡片 `<div key={node.key} onClick={() => handleNodeClick(node)}` 后加：

```tsx
                  onDoubleClick={() => {
                    if (!node.is_dir) openPreview(targetFromNode(node));
                  }}
```

- [ ] **Step 7: 类型检查与回归**

Run: `npm run lint; npm test`
Expected: `tsc --noEmit` 退出码 0；全部测试 PASS。

- [ ] **Step 8: 手工验证**

前提：`.\scripts\run-foyer.ps1` 已在跑；`cd web; npm run dev`；登录 `admin / changeme`。

1. 表格视图**双击**一个 `.png` → 模态打开并显示图片。
2. 双击一个 `.pdf` → 内嵌 PDF 显示，「新标签打开」可点。
3. 双击一个 `.mp4` → 播放器出现，可拖动进度条。
4. 悬停行 → 出现「眼睛」图标，点击同样打开模态。
5. 双击一个 `.pptx` → 显示「无法在线预览 / 该文件类型暂不支持在线预览」+「下载文件」。
6. 按 `Esc` 与点击遮罩都能关闭；关闭后页面可正常滚动。

- [ ] **Step 9: 提交**

```bash
git add web/src/components/preview/ web/src/context/FileStoreContext.tsx web/src/App.tsx web/src/components/FileExplorer.tsx
git commit -m "feat(web): open an image/pdf/media preview modal from the file list"
```

---

### Task 7: 文本/代码渲染（1MB 截断）

**Files:**
- Create: `web/src/components/preview/TextPreview.tsx`
- Modify: `web/src/components/preview/FilePreviewModal.tsx`

**Interfaces:**
- Consumes: `PreviewRendererProps`（Task 6）；`api.readObjectBytes`（Task 5）；`looksBinary`/`decodeText`（Task 2）。
- Produces: `<TextPreview />`；模态分派新增 `plan.kind === 'text'` 分支。

- [ ] **Step 1: 写文本渲染器**

创建 `web/src/components/preview/TextPreview.tsx`：

```tsx
import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import * as api from '../../api/client';
import { decodeText, looksBinary } from '../../preview/text';
import { PreviewMessage, type PreviewRendererProps } from './shared';

type TextState = 'loading' | 'ready' | 'binary' | 'error';

export const TextPreview: React.FC<PreviewRendererProps> = ({ url, plan, onDownload }) => {
  const [state, setState] = useState<TextState>('loading');
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setTruncated(false);
    api
      .readObjectBytes(url, plan.maxBytes)
      .then(res => {
        if (!alive) return;
        if (looksBinary(res.bytes)) {
          setState('binary');
          return;
        }
        setText(decodeText(res.bytes));
        setTruncated(res.truncated);
        setState('ready');
      })
      .catch(err => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [url, plan.maxBytes]);

  if (state === 'loading') {
    return <div className="h-full flex items-center justify-center text-xs text-slate-400">正在读取文本…</div>;
  }
  if (state === 'binary') {
    return <PreviewMessage title="疑似二进制文件" detail="内容包含 NUL 字节，按文本预览会乱码。" onDownload={onDownload} />;
  }
  if (state === 'error') {
    return <PreviewMessage title="读取失败" detail={error} onDownload={onDownload} />;
  }
  return (
    <div className="h-full flex flex-col">
      {truncated ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-amber-200 bg-amber-50 text-[11px] text-amber-700 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5" />
          文件较大，仅显示前 1MB；完整内容请下载。
        </div>
      ) : null}
      <pre className="flex-1 min-h-0 overflow-auto p-4 text-xs text-slate-800 font-mono whitespace-pre-wrap break-all bg-white">
        {text}
      </pre>
    </div>
  );
};
```

- [ ] **Step 2: 接入分派**

在 `web/src/components/preview/FilePreviewModal.tsx`：

1. import 区加：

```tsx
import { TextPreview } from './TextPreview';
```

2. 把 `) : plan.kind === 'media' ? (` 那段的分支链改成在 media 之后加 text：

```tsx
  ) : plan.kind === 'media' ? (
    <MediaPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : plan.kind === 'text' ? (
    <TextPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : (
```

- [ ] **Step 3: 类型检查与回归**

Run: `npm run lint; npm test`
Expected: 退出码 0；全部测试 PASS。

- [ ] **Step 4: 手工验证**

前提：dev 服务在跑。

1. 双击一个 `.log`/`.json`/`.md` → 显示等宽文本，中文与换行正常。
2. 双击一个含 NUL 字节的二进制文件（可把任意图片改成 `.txt` 后缀）→ 显示「疑似二进制文件」+ 下载。
3. 造一个 >1MB 的 `.txt`（`1..200000 | ForEach-Object { "line $_" } | Set-Content big.txt`，上传后双击）→ 顶部出现「仅显示前 1MB」提示，页面不卡死。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/preview/TextPreview.tsx web/src/components/preview/FilePreviewModal.tsx
git commit -m "feat(web): render text and code previews with a 1MB truncation notice"
```

---

### Task 8: Office 渲染（docx-preview / SheetJS）

**Files:**
- Modify: `web/package.json`（新增 `docx-preview`、`xlsx`）
- Create: `web/src/components/preview/DocxPreview.tsx`
- Create: `web/src/components/preview/SheetPreview.tsx`
- Modify: `web/src/components/preview/FilePreviewModal.tsx`

**Interfaces:**
- Consumes: `PreviewRendererProps`（Task 6）；`api.readObjectBytes`（Task 5）；`workbookToTables`/`WorkBookLike`/`SheetToJson`/`SheetTable`（Task 3）。
- Produces: `<DocxPreview />`、`<SheetPreview />`；模态分派新增 `docx`/`sheet` 分支。

- [ ] **Step 1: 装依赖**

Run: `npm install docx-preview@^0.4.0 xlsx@^0.18.5 --legacy-peer-deps`
Expected: `package.json` 的 `dependencies` 多出 `docx-preview`、`xlsx`。

- [ ] **Step 2: 写 docx 渲染器**

创建 `web/src/components/preview/DocxPreview.tsx`：

```tsx
import React, { useEffect, useRef, useState } from 'react';
import * as api from '../../api/client';
import { PreviewMessage, type PreviewRendererProps } from './shared';

type DocxState = 'loading' | 'ready' | 'error';

export const DocxPreview: React.FC<PreviewRendererProps> = ({ url, plan, onDownload }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DocxState>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    (async () => {
      try {
        const { bytes } = await api.readObjectBytes(url, plan.maxBytes);
        const { renderAsync } = await import('docx-preview');
        if (!alive || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        await renderAsync(bytes, containerRef.current, undefined, {
          inWrapper: true,
          breakPages: true,
          useBase64URL: true,
        });
        if (alive) setState('ready');
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, plan.maxBytes]);

  if (state === 'error') {
    return <PreviewMessage title="无法解析 Word 文档" detail={error} onDownload={onDownload} />;
  }
  return (
    <div className="h-full overflow-auto bg-slate-100 p-4">
      {state === 'loading' ? (
        <div className="h-full flex items-center justify-center text-xs text-slate-400">正在解析文档…</div>
      ) : null}
      <div ref={containerRef} className="mx-auto max-w-3xl" />
    </div>
  );
};
```

- [ ] **Step 3: 写表格渲染器**

创建 `web/src/components/preview/SheetPreview.tsx`：

```tsx
import React, { useEffect, useState } from 'react';
import * as api from '../../api/client';
import { workbookToTables, type SheetTable, type SheetToJson, type WorkBookLike } from '../../preview/sheet';
import { PreviewMessage, type PreviewRendererProps } from './shared';

type SheetState = 'loading' | 'ready' | 'error';

export const SheetPreview: React.FC<PreviewRendererProps> = ({ url, plan, onDownload }) => {
  const [state, setState] = useState<SheetState>('loading');
  const [tables, setTables] = useState<SheetTable[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setActive(0);
    (async () => {
      try {
        const { bytes } = await api.readObjectBytes(url, plan.maxBytes);
        const XLSX = await import('xlsx');
        const wb = XLSX.read(bytes, { type: 'array' });
        if (!alive) return;
        setTables(
          workbookToTables(
            wb as unknown as WorkBookLike,
            XLSX.utils.sheet_to_json as unknown as SheetToJson
          )
        );
        setState('ready');
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, plan.maxBytes]);

  if (state === 'error') {
    return <PreviewMessage title="无法解析表格" detail={error} onDownload={onDownload} />;
  }
  if (state === 'loading') {
    return <div className="h-full flex items-center justify-center text-xs text-slate-400">正在解析表格…</div>;
  }
  const current = tables[active];
  return (
    <div className="h-full flex flex-col bg-white">
      {tables.length > 1 ? (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-200 overflow-x-auto shrink-0">
          {tables.map((t, i) => (
            <button
              key={t.name}
              type="button"
              onClick={() => setActive(i)}
              className={`px-2 py-1 rounded text-xs whitespace-nowrap ${
                i === active ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}
      {!current || current.rows.length === 0 ? (
        <PreviewMessage title="工作表为空" detail="这张表没有可显示的行。" onDownload={onDownload} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="text-xs border-collapse">
            <tbody>
              {current.rows.map((row, r) => (
                <tr key={r} className={r === 0 ? 'bg-slate-50 font-medium' : ''}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-slate-200 px-2 py-1 text-slate-700 whitespace-pre">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 4: 接入分派**

在 `web/src/components/preview/FilePreviewModal.tsx`：

1. import 区加：

```tsx
import { DocxPreview } from './DocxPreview';
import { SheetPreview } from './SheetPreview';
```

2. 文本分支之后、`UnsupportedPreview` 兜底之前加：

```tsx
  ) : plan.kind === 'docx' ? (
    <DocxPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : plan.kind === 'sheet' ? (
    <SheetPreview url={url} target={target} plan={plan} onDownload={onDownload} />
  ) : (
```

- [ ] **Step 5: 类型检查与回归**

Run: `npm run lint; npm test`
Expected: 退出码 0；全部测试 PASS。

- [ ] **Step 6: 手工验证**

前提：dev 服务在跑。

1. 双击一个 `.docx` → 文档以接近 Word 的排版显示，可滚动。
2. 双击一个多 sheet 的 `.xlsx` → 顶部出现 sheet 标签，切换生效，单元格文本正确。
3. 双击一个 `.csv` → 以表格显示。
4. 造一个 >20MB 的 `.xlsx` → 显示「文件超过 20MB，为免拖慢浏览器，请下载查看」。
5. 确认首屏不受影响：打开控制台 Network，`docx-preview`/`xlsx` 只在首次预览对应类型时加载（独立 chunk）。

- [ ] **Step 7: 提交**

```bash
git add web/package.json web/package-lock.json web/src/components/preview/DocxPreview.tsx web/src/components/preview/SheetPreview.tsx web/src/components/preview/FilePreviewModal.tsx
git commit -m "feat(web): render docx and spreadsheet previews with lazy-loaded parsers"
```

---

### Task 9: 深度检索与属性抽屉入口

**Files:**
- Modify: `web/src/components/SearchResults.tsx`
- Modify: `web/src/components/FileStatDrawer.tsx`

**Interfaces:**
- Consumes: `openPreview`/`targetFromNode`（Task 6）、`targetFromHit`（Task 4）。
- Produces: 无新导出（纯入口接线）。

- [ ] **Step 1: 深度检索结果行双击**

在 `web/src/components/SearchResults.tsx`：

1. import 区加：

```tsx
import { targetFromHit } from '../preview/target';
```

2. `const { deepSearch, setDeepSearchPage, exitDeepSearch, revealHit } = useFileStore();` 改为：

```tsx
  const { deepSearch, setDeepSearchPage, exitDeepSearch, revealHit, openPreview } = useFileStore();
```

3. 结果行 `<tr key={`${hit.mount}:${hit.key}`} className="hover:bg-slate-50/80 text-slate-700">` 改为：

```tsx
              <tr
                key={`${hit.mount}:${hit.key}`}
                onDoubleClick={() => {
                  if (!hit.isDir) openPreview(targetFromHit(hit));
                }}
                className="hover:bg-slate-50/80 text-slate-700"
              >
```

- [ ] **Step 2: 属性抽屉「预览」按钮**

在 `web/src/components/FileStatDrawer.tsx`：

1. lucide 图标 import 列表加 `Eye`（`Download,` 之后）。
2. 加 import：

```tsx
import { targetFromNode } from '../preview/target';
```

3. `const { selectedNode, setSelectedNode, mounts, updateNodeOverlay } = useFileStore();` 改为：

```tsx
  const { selectedNode, setSelectedNode, mounts, updateNodeOverlay, openPreview } = useFileStore();
```

4. 头部标题与关闭按钮之间（`<button` 关闭按钮之前）插入：

```tsx
        {!selectedNode.is_dir && (
          <button
            type="button"
            onClick={() => openPreview(targetFromNode(selectedNode))}
            title="预览"
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-500 hover:text-indigo-600 transition-colors shrink-0"
          >
            <Eye className="w-4 h-4" />
          </button>
        )}
```

- [ ] **Step 3: 类型检查与回归**

Run: `npm run lint; npm test`
Expected: 退出码 0；全部测试 PASS。

- [ ] **Step 4: 手工验证**

前提：dev 服务在跑。

1. 深度检索一个已知文件 → 结果行双击打开预览。
2. 单击文件 → 右侧抽屉顶部出现「预览」按钮，点击打开模态；目录不显示该按钮。
3. 关掉模态后，抽屉仍显示原文件属性（互不干扰）。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/SearchResults.tsx web/src/components/FileStatDrawer.tsx
git commit -m "feat(web): add preview entry points in search results and the stat drawer"
```

---

### Task 10: 端到端收尾验证

**Files:**
- 无（只验证；发现缺陷则回到对应 Task 修复后重跑）

**Interfaces:**
- Consumes: 前 9 个任务的全部产出。
- Produces: 一份可复现的验收记录。

- [ ] **Step 1: 全量检查**

Run: `npm run lint; npm test; npm run build`
Expected: `tsc --noEmit` 退出码 0；测试全绿；`vite build` 成功，产物里能看到 `docx-preview`/`xlsx` 的独立 chunk。

- [ ] **Step 2: 端到端矩阵**

前提：`.\scripts\run-foyer.ps1` + `cd web; npm run dev`，登录 `admin / changeme`。上传/准备下列文件后逐个双击：

| 文件 | 预期 |
|---|---|
| `.png`（<20MB） | 图片居中显示 |
| `.png`（>20MB） | 「文件超过 20MB…」+ 下载 |
| `.pdf` | 内嵌显示，可翻页；「新标签打开」可用 |
| `.mp4` | 播放器可播放、可拖动进度 |
| `.mp3` | 音频条可播放 |
| `.log` / `.json` / `.md` | 等宽文本；`.md` 是**源码**不是排版 |
| `.txt`（>1MB） | 顶部「仅显示前 1MB」提示，UI 不卡 |
| 含 NUL 的伪 `.txt` | 「疑似二进制文件」+ 下载 |
| `.docx` | 解析出文档排版 |
| `.xlsx`（多 sheet） | sheet 标签可切换 |
| `.csv` | 表格显示 |
| `.pptx` / `.doc` | 「无法在线预览」+ 下载 |

- [ ] **Step 3: 交互与清理**

1. `Esc`、点遮罩、点右上角 `X` 三种方式都能关闭。
2. 关闭后 `document.body` 的 `overflow` 已恢复（页面可滚动）。
3. 快速连续双击不同文件：只显示最后点击的那个（无串台）。
4. 打开模态后按 F5 重载再打开，功能正常（预签名 URL 每次都新生成，不复用旧 URL）。

- [ ] **Step 4: 记录结果**

把 Step 2 的矩阵与 Step 3 的结论写进 `.superpowers/sdd/preview-final-verify-report.md`（逐条勾选、失败项写明现象与回归任务号），然后提交：

```bash
git add .superpowers/sdd/preview-final-verify-report.md
git commit -m "docs: record the file-preview end-to-end verification"
```
