# 导出元数据报表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web 控制台把「一个挂载源（分区）」或「挂载内某个目录」的元数据导出成 `foyer.metadata-report/v1` 的 JSON 与 CSV 只读报表。

**Architecture:** 纯前端，零后端改动。数据面 (`jfs.listPrefix`) 与控制面 (`jfs.foyerStat`) 都已存在：`walk` 注入这两个函数做递归收集并批量回填目录 mtime，`build` 把原始项折算成规范报表（排序、汇总的唯一负责人），`format` 序列化为 JSON/CSV，`live` 负责接线与下载。所有有判断力的逻辑都是纯函数，可在 vitest 的 node 环境直接单测；只有一个弹窗组件不写自动化测试。

**Tech Stack:** TypeScript 5 + React 19 + Vite 8；vitest 3（`environment: 'node'`，无 DOM）；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-19-metadata-export-report-design.md`

## Global Constraints

- **不改后端**：不触碰 `server/`、`overlays/`、`third_party/`，不新增或修改任何 HTTP 契约。本期只读。
- **这不是备份**：产物不能 `juicefs load`。不导出 blob/chunks 映射、xattr/ACL、对象存储凭据、文件内容。
- **一期只做 `detail: 'basic'`**：禁止为报表调用 POSIX 属性。`inode/mode/uid/gid/nlink` 一律不出现（它们要逐路径 `juicefs stat`，慢且本期不需要）。
- **缺失即 `null`，禁止冒充**：源不提供的 `mtime` 一律 `null` + `mtime_source: 'none'`，**绝不用 `new Date()` 或默认值填充**。这是本项目已验证的准则（见 `web/src/api/stat.test.ts` 对「不许回退 `new Date()`」的断言）。
- **`tags` / `custom_meta` 恒为 `[]` / `{}`**：标签持久化未落地，本期只占位字段与 CSV 列，真实值留待后续任务。
- **schema 字符串固定** `foyer.metadata-report/v1`，定义在 `web/src/report/types.ts` 的 `REPORT_SCHEMA`，不得散落字面量。
- **CSV 列序固定 13 列且含预留列**：`ref,mount,path,parent_path,name,type,ext,size,etag,mtime,mtime_source,tags,custom_meta`。顺序与数量不得改动，否则解析方会碎。
- **排序唯一来源是 `buildReport`**（`path` 升序）。`walk` 的输出顺序**不作保证**，调用方不得依赖。
- **目录 mtime 只有一个来源**：`walk` 自己的分批 `stat`。`walk` 必须忽略注入 lister 带来的目录 mtime（`listPrefix` 会附带，且其来源是控制面，若采信会把 `'stat'` 误标成 `'s3'`）。报表路径调 `listPrefix` 时传 `withDirMtimes: false`，避免对每个目录查两遍元数据引擎。
- **上限**：明细软上限 `50000`（超出置 `truncated: true`）；单次 `stat` 批大小 `500`（`juicefs stat` 的 path 全塞进一个 argv，超长会失败）。
- **`isolatedModules: true`**：仅作类型用的导入必须写 `import type`。
- **不引入新 npm 依赖。**
- **测试命令**：`cd web && npm test`（= `vitest run`，include 为 `src/**/*.test.ts`，`environment: 'node'`，**没有 DOM**）。单文件过滤：`cd web && npm test -- src/report/build.test.ts`。
- **类型检查命令**：`cd web && npm run lint`（= `tsc --noEmit`），要求退出码 0、无输出。
- **仓库约定：未获用户明确要求不提交。** 每个任务末尾的 commit 步骤标为可选，默认不执行。

## 本期已采纳的取舍（来自 spec「待评审确认」）

1. 字段集与 CSV 列序按 spec 原样实现，不增删。
2. 保留 `ref`（`photos:/2026/a.jpg`），同时保留 `mount` 列，跨挂载比较用 `mount + path`。
3. CSV 里 `tags` / `custom_meta` 用 **JSON 文本**承载（如 `["财务"]`、`{"来源":"扫描"}`），无值时留空。
4. 明细软上限 50000。
5. 弹窗不做「预计条数」（需要先跑一遍遍历，代价等于导出本身）；改为导出完成后回显真实计数与是否截断。

## 文件结构

| 路径 | 职责 | 动作 |
|------|------|------|
| `web/src/report/types.ts` | schema 常量、`MetadataReport` / `ReportEntry` / `ReportSummary` / `WalkItem` 等类型 | 新建 |
| `web/src/report/paths.ts` | `childPath` / `parentOf` / `baseName` / `deriveExt` 纯路径工具 | 新建 |
| `web/src/report/paths.test.ts` | 上者单测 | 新建 |
| `web/src/report/build.ts` | `buildReport` / `summarize`：排序 + 汇总，报表的规范构造者 | 新建 |
| `web/src/report/build.test.ts` | 上者单测 | 新建 |
| `web/src/report/format.ts` | `toJSON` / `toCSV` / `escapeCSV` / `reportFileName` | 新建 |
| `web/src/report/format.test.ts` | 上者单测 | 新建 |
| `web/src/report/walk.ts` | `walkMount`：注入 `list`/`stat` 的递归收集、目录 mtime 批量回填、错误归类、截断 | 新建 |
| `web/src/report/walk.test.ts` | 上者单测（全部用假依赖） | 新建 |
| `web/src/report/live.ts` | 把一个挂载接到 `jfs` 的真实 `list`/`stat`；`runExport` 编排；`downloadReport` | 新建 |
| `web/src/report/live.test.ts` | 路径换算与 stat 结果回译单测（stub `fetch`） | 新建 |
| `web/src/context/FileStoreContext.tsx` | 新增 `isExportOpen` / `setIsExportOpen` | 修改 |
| `web/src/components/ExportReportModal.tsx` | 范围/格式选择 + 导出 + 结果回执 | 新建 |
| `web/src/components/Header.tsx` | 「导出元数据」入口按钮 | 修改 |
| `web/src/App.tsx` | 挂载弹窗 | 修改 |

任务顺序：1 → 2 → 3 → 4 → 5。Task 1 建立的 `MetadataReport` 形状是后续所有任务的契约；Task 3 的 `WalkDeps` 被 Task 4 消费；Task 4 的 `runExport` 被 Task 5 消费。

---

### Task 1: 报表数据模型与规范构造（types / paths / build）

**Files:**
- Create: `web/src/report/types.ts`
- Create: `web/src/report/paths.ts`
- Create: `web/src/report/paths.test.ts`
- Create: `web/src/report/build.ts`
- Create: `web/src/report/build.test.ts`

**Interfaces:**
- Consumes: `joinRef(mount, path)`（`web/src/api/jfs.ts`，已存在且是纯函数）
- Produces（供 Task 2/3/4/5 使用）:

```ts
export const REPORT_SCHEMA = 'foyer.metadata-report/v1' as const;
export const REPORT_GENERATOR_NAME = 'foyer-web';
export const REPORT_GENERATOR_VERSION = '0.0.0';

export type ReportScopeKind = 'mount' | 'directory';
export type ReportDetail = 'basic';
export type MtimeSource = 's3' | 'stat' | 'none';

export interface ReportScope {
  kind: ReportScopeKind; mount: string; path: string; ref: string;
  recursive: boolean; include_dirs: boolean; detail: ReportDetail;
}
export interface ReportGenerator { name: string; version: string; operator: string; }
export interface ReportSource { volume: string; driver: string; mount_spec: Record<string, string>; }
export interface ReportEntry {
  ref: string; path: string; parent_path: string; name: string;
  type: 'file' | 'dir'; ext: string; size: number; etag: string | null;
  mtime: string | null; mtime_source: MtimeSource;
  tags: string[]; custom_meta: Record<string, string>;
}
export interface ReportError { path: string; stage: 'list' | 'stat'; message: string; }
export interface ExtensionBucket { ext: string; count: number; bytes: number; }
export interface ReportSummary {
  entry_count: number; file_count: number; dir_count: number; total_bytes: number;
  by_extension: ExtensionBucket[]; mtime_range: { min: string; max: string } | null;
  error_count: number; truncated: boolean;
}
export interface MetadataReport {
  schema: typeof REPORT_SCHEMA; generated_at: string; generator: ReportGenerator;
  scope: ReportScope; source: ReportSource; summary: ReportSummary;
  entries: ReportEntry[]; errors: ReportError[];
}
/** walk 收集到的原始项；ref/ext/汇总由 build 负责补。 */
export interface WalkItem {
  path: string; name: string; type: 'file' | 'dir'; size: number;
  etag: string | null; mtime: string | null; mtime_source: MtimeSource;
}

// build.ts 导出（**不是 types.ts**，不要在两处重复定义）：
export interface BuildInput {
  scope: ReportScope; source: ReportSource; generator: ReportGenerator;
  generatedAt: string; items: WalkItem[]; errors: ReportError[]; truncated: boolean;
}
export function buildReport(input: BuildInput): MetadataReport;
export function summarize(entries: ReportEntry[], errorCount: number, truncated: boolean): ReportSummary;

// paths.ts 导出：
export function childPath(parent: string, name: string): string;
export function parentOf(path: string): string;
export function baseName(path: string): string;
export function deriveExt(name: string): string;
```

---

- [ ] **Step 1: 建立类型与常量**

创建 `web/src/report/types.ts`：

```ts
/**
 * 导出元数据报表的数据模型。
 *
 * 这是**只读清单报表**，不是 `juicefs dump` 备份：不能 `load` 回来，不含
 * blob/chunks 映射、xattr/ACL、对象存储凭据。字段集刻意保持扁平，便于进
 * Excel / BI。
 */

/** schema 标识。格式发生任何不兼容变更时必须换版本号，解析方据此分流。 */
export const REPORT_SCHEMA = 'foyer.metadata-report/v1' as const;

/**
 * 生成器标识。version 与 web/package.json 的 version 手动保持一致：
 * 页面构建不注入 package 元数据，为此改 vite 配置不值得，发版时同步即可。
 */
export const REPORT_GENERATOR_NAME = 'foyer-web';
export const REPORT_GENERATOR_VERSION = '0.0.0';

export type ReportScopeKind = 'mount' | 'directory';
export type ReportDetail = 'basic';
/** mtime 的出处，用于审计：'s3' 来自数据面列表，'stat' 来自控制面，'none' 表示源没提供。 */
export type MtimeSource = 's3' | 'stat' | 'none';

export interface ReportScope {
  kind: ReportScopeKind;
  mount: string;
  /** 挂载内绝对路径，以 / 开头；kind='mount' 时固定为 '/'。 */
  path: string;
  ref: string;
  recursive: boolean;
  include_dirs: boolean;
  detail: ReportDetail;
}

export interface ReportGenerator {
  name: string;
  version: string;
  operator: string;
}

export interface ReportSource {
  volume: string;
  driver: string;
  mount_spec: Record<string, string>;
}

export interface ReportEntry {
  ref: string;
  path: string;
  parent_path: string;
  name: string;
  type: 'file' | 'dir';
  /** 小写、不含点；目录与无后缀文件为 ""。 */
  ext: string;
  size: number;
  etag: string | null;
  /** ISO-8601 UTC；源没提供就是 null。 */
  mtime: string | null;
  mtime_source: MtimeSource;
  /** 预留：标签持久化落地前恒为 []。 */
  tags: string[];
  /** 预留：标签持久化落地前恒为 {}。 */
  custom_meta: Record<string, string>;
}

export interface ReportError {
  path: string;
  stage: 'list' | 'stat';
  message: string;
}

export interface ExtensionBucket {
  ext: string;
  count: number;
  bytes: number;
}

export interface ReportSummary {
  entry_count: number;
  file_count: number;
  dir_count: number;
  total_bytes: number;
  by_extension: ExtensionBucket[];
  mtime_range: { min: string; max: string } | null;
  error_count: number;
  truncated: boolean;
}

export interface MetadataReport {
  schema: typeof REPORT_SCHEMA;
  generated_at: string;
  generator: ReportGenerator;
  scope: ReportScope;
  source: ReportSource;
  summary: ReportSummary;
  entries: ReportEntry[];
  errors: ReportError[];
}

/** walk 收集到的原始项；ref / ext / 汇总由 build 负责补。 */
export interface WalkItem {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  etag: string | null;
  mtime: string | null;
  mtime_source: MtimeSource;
}
```

- [ ] **Step 2: 先写 paths 的失败测试**

创建 `web/src/report/paths.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { baseName, childPath, deriveExt, parentOf } from './paths';

describe('childPath', () => {
  it('joins from the root without doubling the slash', () => {
    expect(childPath('/', 'a')).toBe('/a');
  });

  it('joins nested paths', () => {
    expect(childPath('/a', 'b')).toBe('/a/b');
  });

  it('ignores a trailing slash on the parent', () => {
    expect(childPath('/a/', 'b')).toBe('/a/b');
  });
});

describe('parentOf', () => {
  it('walks up one level', () => {
    expect(parentOf('/a/b.jpg')).toBe('/a');
  });

  it('keeps the root as its own parent', () => {
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBe('/');
  });
});

describe('baseName', () => {
  it('returns the last segment', () => {
    expect(baseName('/a/b/c.txt')).toBe('c.txt');
  });

  it('returns an empty string for the root so callers pick a fallback', () => {
    expect(baseName('/')).toBe('');
    expect(baseName('')).toBe('');
  });
});

describe('deriveExt', () => {
  it('lowercases the extension', () => {
    expect(deriveExt('A.JPG')).toBe('jpg');
  });

  it('takes only the last suffix', () => {
    expect(deriveExt('archive.tar.gz')).toBe('gz');
  });

  it('returns empty for extensionless names', () => {
    expect(deriveExt('README')).toBe('');
  });

  it('treats dotfiles as extensionless', () => {
    expect(deriveExt('.gitignore')).toBe('');
  });

  it('returns empty for a trailing dot', () => {
    expect(deriveExt('weird.')).toBe('');
  });
});
```

- [ ] **Step 3: 运行确认失败**

```powershell
cd web
npm test -- src/report/paths.test.ts
```

预期：FAIL，`Failed to resolve import "./paths"`。

- [ ] **Step 4: 实现 `paths.ts`**

创建 `web/src/report/paths.ts`：

```ts
/**
 * 报表用的路径工具。全部是纯函数：不碰网络、不碰 localStorage，
 * 因此可以在 vitest 的 node 环境直接单测。
 */

/** 拼接子路径：`childPath('/', 'a') -> '/a'`，`childPath('/a', 'b') -> '/a/b'`。 */
export function childPath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  return base === '' ? `/${name}` : `${base}/${name}`;
}

/** 父目录路径。根目录的父仍是它自己，保证 `parent_path` 永远不是空串。 */
export function parentOf(path: string): string {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** 取 basename；根目录返回 `''`，由调用方决定回退成什么名字。 */
export function baseName(path: string): string {
  const p = path.replace(/\/+$/, '');
  if (p === '') return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 取扩展名：小写、不含点。
 * 目录、无后缀文件、dotfile（`.gitignore`）、尾点（`weird.`）一律返回 `""`。
 */
export function deriveExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}
```

- [ ] **Step 5: 运行确认 paths 测试通过**

```powershell
cd web
npm test -- src/report/paths.test.ts
```

预期：`Test Files  1 passed`，用例全绿。

- [ ] **Step 6: 先写 build 的失败测试**

创建 `web/src/report/build.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildReport, summarize } from './build';
import type { BuildInput } from './build';
import type {
  ReportEntry,
  ReportError,
  ReportGenerator,
  ReportScope,
  ReportSource,
  WalkItem,
} from './types';

const scope: ReportScope = {
  kind: 'directory',
  mount: 'photos',
  path: '/2026',
  ref: 'photos:/2026',
  recursive: true,
  include_dirs: true,
  detail: 'basic',
};

const source: ReportSource = { volume: 'foyer', driver: 'local', mount_spec: { root: 'E:\\photos' } };

const generator: ReportGenerator = { name: 'foyer-web', version: '0.0.0', operator: 'admin' };

/** 故意乱序，验证 build 负责排序。 */
const items: WalkItem[] = [
  { path: '/2026/b.txt', name: 'b.txt', type: 'file', size: 10, etag: 'e2', mtime: '2021-01-01T00:00:01.000Z', mtime_source: 's3' },
  { path: '/2026', name: '2026', type: 'dir', size: 0, etag: null, mtime: '2020-01-01T00:00:00.000Z', mtime_source: 'stat' },
  { path: '/2026/a.jpg', name: 'a.jpg', type: 'file', size: 100, etag: 'e1', mtime: '2022-01-01T00:00:00.000Z', mtime_source: 's3' },
  { path: '/2026/README', name: 'README', type: 'file', size: 5, etag: null, mtime: null, mtime_source: 'none' },
];

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    scope,
    source,
    generator,
    generatedAt: '2026-09-19T06:30:00.000Z',
    items,
    errors: [],
    truncated: false,
    ...over,
  };
}

describe('buildReport', () => {
  it('sorts entries by path', () => {
    const r = buildReport(input());
    expect(r.entries.map(e => e.path)).toEqual([
      '/2026',
      '/2026/README',
      '/2026/a.jpg',
      '/2026/b.txt',
    ]);
  });

  it('stamps the schema and echoes scope/source/generator', () => {
    const r = buildReport(input());
    expect(r.schema).toBe('foyer.metadata-report/v1');
    expect(r.generated_at).toBe('2026-09-19T06:30:00.000Z');
    expect(r.scope).toEqual(scope);
    expect(r.source).toEqual(source);
    expect(r.generator).toEqual(generator);
  });

  it('derives ref, parent_path and ext', () => {
    const r = buildReport(input());
    const dir = r.entries[0];
    expect(dir.ref).toBe('photos:/2026');
    expect(dir.parent_path).toBe('/');
    expect(dir.ext).toBe('');

    const jpg = r.entries.find(e => e.name === 'a.jpg') as ReportEntry;
    expect(jpg.ref).toBe('photos:/2026/a.jpg');
    expect(jpg.parent_path).toBe('/2026');
    expect(jpg.ext).toBe('jpg');
  });

  it('leaves the reserved label fields empty', () => {
    const r = buildReport(input());
    for (const e of r.entries) {
      expect(e.tags).toEqual([]);
      expect(e.custom_meta).toEqual({});
    }
  });

  it('keeps a missing mtime as null with source none', () => {
    const r = buildReport(input());
    const readme = r.entries.find(e => e.name === 'README') as ReportEntry;
    expect(readme.mtime).toBeNull();
    expect(readme.mtime_source).toBe('none');
  });

  it('counts files, dirs and bytes', () => {
    const r = buildReport(input());
    expect(r.summary.entry_count).toBe(4);
    expect(r.summary.file_count).toBe(3);
    expect(r.summary.dir_count).toBe(1);
    expect(r.summary.total_bytes).toBe(115);
  });

  it('buckets extensions by count then ext, and keeps the empty extension', () => {
    const r = buildReport(input());
    expect(r.summary.by_extension).toEqual([
      { ext: '', count: 1, bytes: 5 },
      { ext: 'jpg', count: 1, bytes: 100 },
      { ext: 'txt', count: 1, bytes: 10 },
    ]);
  });

  it('orders extension buckets by count descending first', () => {
    const many: WalkItem[] = [
      { path: '/a.jpg', name: 'a.jpg', type: 'file', size: 1, etag: null, mtime: null, mtime_source: 'none' },
      { path: '/b.jpg', name: 'b.jpg', type: 'file', size: 1, etag: null, mtime: null, mtime_source: 'none' },
      { path: '/c.txt', name: 'c.txt', type: 'file', size: 1, etag: null, mtime: null, mtime_source: 'none' },
    ];
    const r = buildReport(input({ items: many }));
    expect(r.summary.by_extension.map(b => b.ext)).toEqual(['jpg', 'txt']);
  });

  it('ignores null mtimes in the range', () => {
    const r = buildReport(input());
    expect(r.summary.mtime_range).toEqual({
      min: '2020-01-01T00:00:00.000Z',
      max: '2022-01-01T00:00:00.000Z',
    });
  });

  it('reports an empty report without inventing data', () => {
    const r = buildReport(input({ items: [] }));
    expect(r.entries).toEqual([]);
    expect(r.summary).toEqual({
      entry_count: 0,
      file_count: 0,
      dir_count: 0,
      total_bytes: 0,
      by_extension: [],
      mtime_range: null,
      error_count: 0,
      truncated: false,
    });
  });

  it('mirrors the error count and keeps errors out of the entries', () => {
    const errors: ReportError[] = [{ path: '/2026/ghost', stage: 'stat', message: 'no such file' }];
    const r = buildReport(input({ errors }));
    expect(r.summary.error_count).toBe(1);
    expect(r.errors).toEqual(errors);
    expect(r.summary.entry_count).toBe(4);
  });

  it('carries the truncated flag through', () => {
    expect(buildReport(input({ truncated: true })).summary.truncated).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(JSON.stringify(buildReport(input()))).toBe(JSON.stringify(buildReport(input())));
  });
});

describe('summarize', () => {
  it('returns a null range and empty buckets when nothing was collected', () => {
    const s = summarize([], 0, false);
    expect(s.mtime_range).toBeNull();
    expect(s.by_extension).toEqual([]);
    expect(s.entry_count).toBe(0);
  });
});
```

- [ ] **Step 7: 运行确认失败**

```powershell
cd web
npm test -- src/report/build.test.ts
```

预期：FAIL，`Failed to resolve import "./build"`。

- [ ] **Step 8: 实现 `build.ts`**

创建 `web/src/report/build.ts`：

```ts
import { joinRef } from '../api/jfs';
import { deriveExt, parentOf } from './paths';
import { REPORT_SCHEMA } from './types';
import type {
  ExtensionBucket,
  MetadataReport,
  ReportEntry,
  ReportSummary,
  WalkItem,
} from './types';

export interface BuildInput {
  scope: MetadataReport['scope'];
  source: MetadataReport['source'];
  generator: MetadataReport['generator'];
  generatedAt: string;
  items: WalkItem[];
  errors: MetadataReport['errors'];
  truncated: boolean;
}

/**
 * 把 walk 收集到的原始项折成规范报表。
 *
 * 这里是**排序与汇总的唯一负责人**：walk 的输出顺序不作保证，报表的可比性
 * （同一范围重复导出结果逐字节相同）由本函数保证。
 */
export function buildReport(input: BuildInput): MetadataReport {
  const entries = input.items
    .map(item => toEntry(input.scope.mount, item))
    .sort(byPath);

  return {
    schema: REPORT_SCHEMA,
    generated_at: input.generatedAt,
    generator: input.generator,
    scope: input.scope,
    source: input.source,
    summary: summarize(entries, input.errors.length, input.truncated),
    entries,
    errors: [...input.errors],
  };
}

function byPath(a: ReportEntry, b: ReportEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function toEntry(mount: string, item: WalkItem): ReportEntry {
  return {
    ref: joinRef(mount, item.path),
    path: item.path,
    parent_path: parentOf(item.path),
    name: item.name,
    type: item.type,
    // 目录没有扩展名可言，别让 `2026.01` 这种目录名混进扩展名桶。
    ext: item.type === 'dir' ? '' : deriveExt(item.name),
    size: item.size,
    etag: item.etag,
    mtime: item.mtime,
    mtime_source: item.mtime_source,
    // 预留：标签持久化未落地，恒为空值。
    tags: [],
    custom_meta: {},
  };
}

/**
 * 计算汇总。口径：
 * - 只累加文件的字节；目录 size 恒为 0，不参与。
 * - `by_extension` 按 count 降序、同 count 按 ext 升序，保证确定性。
 * - `mtime_range` 只看非 null 的 mtime；全为 null 时是 null，不编造区间。
 * - 失败对象不进任何计数，只通过 `error_count` 反映。
 */
export function summarize(entries: ReportEntry[], errorCount: number, truncated: boolean): ReportSummary {
  const buckets = new Map<string, ExtensionBucket>();
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let min: string | null = null;
  let max: string | null = null;

  for (const e of entries) {
    if (e.type === 'dir') {
      dirCount++;
    } else {
      fileCount++;
      totalBytes += e.size;
      const bucket = buckets.get(e.ext) ?? { ext: e.ext, count: 0, bytes: 0 };
      bucket.count++;
      bucket.bytes += e.size;
      buckets.set(e.ext, bucket);
    }
    if (e.mtime !== null) {
      // 全部是同一形态的 ISO-8601 UTC（毫秒定长），字典序即时间序。
      if (min === null || e.mtime < min) min = e.mtime;
      if (max === null || e.mtime > max) max = e.mtime;
    }
  }

  const by_extension = [...buckets.values()].sort(
    (a, b) => b.count - a.count || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0)
  );

  return {
    entry_count: entries.length,
    file_count: fileCount,
    dir_count: dirCount,
    total_bytes: totalBytes,
    by_extension,
    mtime_range: min !== null && max !== null ? { min, max } : null,
    error_count: errorCount,
    truncated,
  };
}
```

注意：`BuildInput` 定义在**本文件**里（`types.ts` 里没有它，不要在两处重复定义——两处定义会让调用方拿到不一致的形状）。`build.test.ts` 从 `./build` 导入它。

- [ ] **Step 9: 运行确认 build 测试通过**

```powershell
cd web
npm test -- src/report/build.test.ts
```

预期：全绿。

- [ ] **Step 10: 类型检查**

```powershell
cd web
npm run lint
```

预期：无输出，退出码 0。

- [ ] **Step 11（可选）: 提交**

```powershell
git add web/src/report/types.ts web/src/report/paths.ts web/src/report/paths.test.ts web/src/report/build.ts web/src/report/build.test.ts
git commit -m "feat(web): metadata report model and pure builder"
```

---

### Task 2: JSON / CSV 序列化与文件名

**Files:**
- Create: `web/src/report/format.ts`
- Create: `web/src/report/format.test.ts`

**Interfaces:**
- Consumes: `MetadataReport`、`ReportEntry`（Task 1）
- Produces（供 Task 5 使用）:

```ts
export type ReportFormat = 'json' | 'csv';
export const CSV_HEADER: readonly string[];
export function escapeCSV(value: string): string;
export function toJSON(report: MetadataReport): string;
export function toCSV(report: MetadataReport): string;
export function reportFileName(mount: string, format: ReportFormat, generatedAt: string): string;
```

---

- [ ] **Step 1: 先写失败测试**

创建 `web/src/report/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CSV_HEADER, escapeCSV, reportFileName, toCSV, toJSON } from './format';
import type { MetadataReport, ReportEntry } from './types';

function entry(over: Partial<ReportEntry> = {}): ReportEntry {
  return {
    ref: 'photos:/2026/a.jpg',
    path: '/2026/a.jpg',
    parent_path: '/2026',
    name: 'a.jpg',
    type: 'file',
    ext: 'jpg',
    size: 16384,
    etag: '9c1f',
    mtime: '2020-01-02T03:04:05.123Z',
    mtime_source: 's3',
    tags: [],
    custom_meta: {},
    ...over,
  };
}

function report(entries: ReportEntry[]): MetadataReport {
  return {
    schema: 'foyer.metadata-report/v1',
    generated_at: '2026-09-19T06:30:00.000Z',
    generator: { name: 'foyer-web', version: '0.0.0', operator: 'admin' },
    scope: {
      kind: 'directory',
      mount: 'photos',
      path: '/2026',
      ref: 'photos:/2026',
      recursive: true,
      include_dirs: true,
      detail: 'basic',
    },
    source: { volume: 'foyer', driver: 'local', mount_spec: {} },
    summary: {
      entry_count: entries.length,
      file_count: entries.filter(e => e.type === 'file').length,
      dir_count: entries.filter(e => e.type === 'dir').length,
      total_bytes: 0,
      by_extension: [],
      mtime_range: null,
      error_count: 0,
      truncated: false,
    },
    entries,
    errors: [],
  };
}

describe('escapeCSV', () => {
  it('passes plain values through', () => {
    expect(escapeCSV('a.jpg')).toBe('a.jpg');
  });

  it('quotes values containing a comma', () => {
    expect(escapeCSV('a,b')).toBe('"a,b"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing a newline', () => {
    expect(escapeCSV('a\nb')).toBe('"a\nb"');
  });
});

describe('toJSON', () => {
  it('emits indented JSON that round-trips', () => {
    const r = report([entry()]);
    const text = toJSON(r);
    expect(text).toContain('\n');
    expect(JSON.parse(text)).toEqual(r);
  });
});

describe('toCSV', () => {
  it('starts with a BOM and the fixed 13-column header', () => {
    const csv = toCSV(report([]));
    expect(CSV_HEADER).toHaveLength(13);
    expect(csv.startsWith(`\uFEFF${CSV_HEADER.join(',')}\r\n`)).toBe(true);
  });

  it('uses CRLF and ends with one', () => {
    const csv = toCSV(report([entry()]));
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(3); // header + 1 row + trailing empty
  });

  it('writes a dir row with empty ext/etag and size 0', () => {
    const dir = entry({
      ref: 'photos:/2026',
      path: '/2026',
      parent_path: '/',
      name: '2026',
      type: 'dir',
      ext: '',
      size: 0,
      etag: null,
      mtime: '2026-08-01T09:00:00.000Z',
      mtime_source: 'stat',
    });
    const row = toCSV(report([dir])).split('\r\n')[1];
    expect(row).toBe('photos:/2026,photos,/2026,/,2026,dir,,0,,2026-08-01T09:00:00.000Z,stat,,');
  });

  it('writes a file row with a missing mtime left blank', () => {
    const file = entry({ mtime: null, mtime_source: 'none' });
    const row = toCSV(report([file])).split('\r\n')[1];
    expect(row).toBe('photos:/2026/a.jpg,photos,/2026/a.jpg,/2026,a.jpg,file,jpg,16384,9c1f,,none,,');
  });

  it('leaves the reserved label columns empty in this phase', () => {
    const row = toCSV(report([entry()])).split('\r\n')[1];
    expect(row.endsWith(',,')).toBe(true);
  });

  it('encodes tags and custom_meta as escaped JSON text', () => {
    const tagged = entry({ tags: ['财务', 'a,b'], custom_meta: { 来源: '扫描' } });
    const row = toCSV(report([tagged])).split('\r\n')[1];
    expect(row).toContain('"[""财务"",""a,b""]"');
    expect(row).toContain('"{""来源"":""扫描""}"');
  });

  it('quotes a filename containing a comma', () => {
    const weird = entry({ name: 'a,b.jpg' });
    expect(toCSV(report([weird]))).toContain('"a,b.jpg"');
  });
});

describe('reportFileName', () => {
  it('builds a deterministic name from the mount and timestamp', () => {
    expect(reportFileName('photos', 'csv', '2026-09-19T06:30:00.000Z')).toBe(
      'foyer-report-photos-20260919-063000Z.csv'
    );
    expect(reportFileName('photos', 'json', '2026-09-19T06:30:00.000Z')).toBe(
      'foyer-report-photos-20260919-063000Z.json'
    );
  });

  it('sanitizes characters that are unsafe in a filename', () => {
    expect(reportFileName('a/b c', 'json', '2026-09-19T06:30:00.000Z')).toBe(
      'foyer-report-a_b_c-20260919-063000Z.json'
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd web
npm test -- src/report/format.test.ts
```

预期：FAIL，`Failed to resolve import "./format"`。

- [ ] **Step 3: 实现 `format.ts`**

创建 `web/src/report/format.ts`：

```ts
import type { MetadataReport } from './types';

export type ReportFormat = 'json' | 'csv';

/**
 * CSV 列序**固定**。`tags` / `custom_meta` 本期恒为空，但从第一版就占位，
 * 避免后续补上真实值时加列把解析方打碎。
 */
export const CSV_HEADER = [
  'ref',
  'mount',
  'path',
  'parent_path',
  'name',
  'type',
  'ext',
  'size',
  'etag',
  'mtime',
  'mtime_source',
  'tags',
  'custom_meta',
] as const;

/** 规范的 JSON 形态：缩进 2 空格，便于人工阅读与 diff。 */
export function toJSON(report: MetadataReport): string {
  return JSON.stringify(report, null, 2);
}

/** RFC4180 转义：含逗号/引号/换行时整体加引号，内部引号翻倍。 */
export function escapeCSV(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 一行为一对象的 CSV 投影。汇总与错误不进 CSV（它们是整体信息，不是行数据），
 * 随 JSON 一起交付。
 */
export function toCSV(report: MetadataReport): string {
  const mount = report.scope.mount;
  const lines: string[] = [CSV_HEADER.join(',')];

  for (const e of report.entries) {
    const cells = [
      e.ref,
      mount,
      e.path,
      e.parent_path,
      e.name,
      e.type,
      e.ext,
      String(e.size),
      e.etag ?? '',
      e.mtime ?? '',
      e.mtime_source,
      e.tags.length > 0 ? JSON.stringify(e.tags) : '',
      Object.keys(e.custom_meta).length > 0 ? JSON.stringify(e.custom_meta) : '',
    ];
    lines.push(cells.map(escapeCSV).join(','));
  }

  // BOM：Excel 打开 UTF-8 CSV 需要它，否则中文文件名与内容会乱码。
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * 文件名：`foyer-report-<mount>-<yyyymmdd-hhmmssZ>.<ext>`。
 * 挂载名里的路径分隔符等字符会被替换，避免浏览器把它当目录。
 */
export function reportFileName(mount: string, format: ReportFormat, generatedAt: string): string {
  const stamp = generatedAt
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
  const safeMount = mount.replace(/[^A-Za-z0-9._-]/g, '_') || 'report';
  return `foyer-report-${safeMount}-${stamp}.${format}`;
}
```

- [ ] **Step 4: 运行确认 format 测试通过**

```powershell
cd web
npm test -- src/report/format.test.ts
```

预期：全绿。

- [ ] **Step 5: 全量测试与类型检查**

```powershell
cd web
npm test
npm run lint
```

预期：vitest 全绿（含既有 `parse.test.ts` / `run.test.ts` / `jfs.test.ts` / `mounts.test.ts` / `stat.test.ts` 与新增两个文件）；`tsc --noEmit` 无输出。

- [ ] **Step 6（可选）: 提交**

```powershell
git add web/src/report/format.ts web/src/report/format.test.ts
git commit -m "feat(web): metadata report JSON/CSV serialization"
```

---

### Task 3: 递归遍历（注入依赖、目录 mtime 分批回填）

**Files:**
- Create: `web/src/report/walk.ts`
- Create: `web/src/report/walk.test.ts`

**Interfaces:**
- Consumes: `ListEntry`（`web/src/api/jfs.ts`，已存在）、`childPath` / `baseName`（Task 1）、`ReportError` / `WalkItem`（Task 1）
- Produces（供 Task 4 使用）:

```ts
export interface WalkDeps {
  /** 列出一个目录的**直接子项**；dirPath 为挂载内绝对路径。 */
  list: (dirPath: string) => Promise<ListEntry[]>;
  /** 批量读目录 mtime；返回「挂载内路径 -> ISO 时间」，解析失败的路径缺席。 */
  stat: (paths: string[]) => Promise<Map<string, string>>;
}
export interface WalkOptions {
  mount: string; path: string; recursive: boolean; includeDirs: boolean;
  maxEntries?: number; statBatchSize?: number;
}
export interface WalkResult { items: WalkItem[]; errors: ReportError[]; truncated: boolean; }
export const DEFAULT_MAX_ENTRIES = 50000;
export const DEFAULT_STAT_BATCH_SIZE = 500;
export function walkMount(deps: WalkDeps, opts: WalkOptions): Promise<WalkResult>;
```

**为什么需要 `stat` 二遍回填**：带分隔符列目录时，目录只出现在 S3 的 `CommonPrefixes`，天然没有 `LastModified`（见 `web/src/api/jfs.ts` 的 `attachDirMtimes` 注释）。目录时间只能从控制面批量拿。

---

- [ ] **Step 1: 先写失败测试**

创建 `web/src/report/walk.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ListEntry } from '../api/jfs';
import { DEFAULT_STAT_BATCH_SIZE, walkMount } from './walk';
import type { WalkDeps, WalkItem } from './walk';

const tree: Record<string, ListEntry[]> = {
  '/': [
    { name: '2026', key: '/2026', is_dir: true },
    { name: 'top.txt', key: '/top.txt', is_dir: false, size: 3, etag: 't', mtime: '2020-01-01T00:00:00.000Z' },
  ],
  '/2026': [
    { name: 'a.jpg', key: '/2026/a.jpg', is_dir: false, size: 10, etag: 'a', mtime: '2021-01-01T00:00:00.000Z' },
    { name: 'sub', key: '/2026/sub', is_dir: true },
  ],
  '/2026/sub': [{ name: 'n.txt', key: '/2026/sub/n.txt', is_dir: false, size: 1, etag: 'n' }],
};

const dirTimes: Record<string, string> = {
  '/': '2019-12-31T23:59:58.000Z',
  '/2026': '2026-08-01T09:00:00.000Z',
  '/2026/sub': '2025-05-05T05:05:05.000Z',
};

function fakeDeps(over: Partial<WalkDeps> = {}): WalkDeps & { statCalls: string[][] } {
  const statCalls: string[][] = [];
  const deps: WalkDeps = {
    list: async (dirPath: string) => {
      const hit = tree[dirPath];
      if (!hit) throw new Error(`no such directory: ${dirPath}`);
      return hit;
    },
    stat: async (paths: string[]) => {
      statCalls.push([...paths]);
      const out = new Map<string, string>();
      for (const p of paths) {
        const iso = dirTimes[p];
        if (iso) out.set(p, iso);
      }
      return out;
    },
    ...over,
  };
  return Object.assign(deps, { statCalls });
}

const paths = (items: WalkItem[]) => items.map(i => i.path).sort();
const byPath = (items: WalkItem[]) => new Map(items.map(i => [i.path, i]));

describe('walkMount', () => {
  it('recurses and emits the scope root itself', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    expect(paths(res.items)).toEqual([
      '/', '/2026', '/2026/a.jpg', '/2026/sub', '/2026/sub/n.txt', '/top.txt',
    ]);
    expect(res.truncated).toBe(false);
    expect(res.errors).toEqual([]);
  });

  it('names the scope root after the mount', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    expect(byPath(res.items).get('/')?.name).toBe('photos');
    const nested = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/2026', recursive: true, includeDirs: true,
    });
    expect(byPath(nested.items).get('/2026')?.name).toBe('2026');
  });

  it('omits directory rows when includeDirs is false but still traverses them', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: false,
    });
    expect(paths(res.items)).toEqual(['/2026/a.jpg', '/2026/sub/n.txt', '/top.txt']);
  });

  it('stops at the first level when recursive is false', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: false, includeDirs: true,
    });
    expect(paths(res.items)).toEqual(['/', '/2026', '/top.txt']);
  });

  it('fills directory mtime from stat and leaves files from the listing as s3', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    const items = byPath(res.items);
    expect(items.get('/')?.mtime).toBe('2019-12-31T23:59:58.000Z');
    expect(items.get('/')?.mtime_source).toBe('stat');
    expect(items.get('/2026')?.mtime_source).toBe('stat');
    expect(items.get('/top.txt')?.mtime).toBe('2020-01-01T00:00:00.000Z');
    expect(items.get('/top.txt')?.mtime_source).toBe('s3');
  });

  it('does not invent a time for a file the listing had none for', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    const n = byPath(res.items).get('/2026/sub/n.txt');
    expect(n?.mtime).toBeNull();
    expect(n?.mtime_source).toBe('none');
  });

  it('splits stat into batches of statBatchSize', async () => {
    const deps = fakeDeps();
    await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true, statBatchSize: 1,
    });
    expect(deps.statCalls).toHaveLength(3);
    for (const call of deps.statCalls) expect(call).toHaveLength(1);
  });

  it('defaults to a 500-path stat batch', () => {
    expect(DEFAULT_STAT_BATCH_SIZE).toBe(500);
  });

  it('records a list failure and keeps walking the rest', async () => {
    const deps = fakeDeps({
      list: async (dirPath: string) => {
        if (dirPath === '/2026/sub') throw new Error('access denied');
        return tree[dirPath] ?? [];
      },
    });
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    expect(res.errors).toEqual([
      { path: '/2026/sub', stage: 'list', message: 'access denied' },
    ]);
    expect(paths(res.items)).toContain('/2026/a.jpg');
  });

  it('records a stat failure per path and keeps dir mtime null', async () => {
    const deps = fakeDeps({
      stat: async () => {
        throw new Error('stat down');
      },
    });
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    expect(res.errors).toHaveLength(3);
    for (const err of res.errors) expect(err.stage).toBe('stat');
    expect(byPath(res.items).get('/')?.mtime).toBeNull();
    expect(byPath(res.items).get('/')?.mtime_source).toBe('none');
  });

  it('ignores a directory mtime supplied by the listing', async () => {
    // 目录时间只由本模块的 stat 批量提供。注入的 lister 可能自带目录时间
    // （listPrefix 就会，且来源是控制面），若在此采信会把 'stat' 误标成 's3'。
    const listed: ListEntry[] = [
      { name: 'a', key: '/a', is_dir: true, mtime: '2000-01-01T00:00:00.000Z' },
      { name: 'b', key: '/b', is_dir: true, mtime: '2001-01-01T00:00:00.000Z' },
    ];
    const deps: WalkDeps = {
      list: async (dirPath: string) => (dirPath === '/' ? listed : []),
      stat: async () => new Map([['/a', '2024-03-03T03:03:03.000Z']]),
    };
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    const items = byPath(res.items);
    // stat 有则用 stat 的值（不是列表里的 2000），标 'stat'。
    expect(items.get('/a')?.mtime).toBe('2024-03-03T03:03:03.000Z');
    expect(items.get('/a')?.mtime_source).toBe('stat');
    // stat 没有则留空（不是列表里的 2001），标 'none'。
    expect(items.get('/b')?.mtime).toBeNull();
    expect(items.get('/b')?.mtime_source).toBe('none');
  });

  it('stops at maxEntries and flags truncation', async () => {
    const res = await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true, maxEntries: 2,
    });
    expect(res.items).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('never lists the same directory twice', async () => {
    const list = vi.fn(async (dirPath: string) => tree[dirPath] ?? []);
    await walkMount({ ...fakeDeps(), list }, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    const listed = list.mock.calls.map(c => c[0]);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd web
npm test -- src/report/walk.test.ts
```

预期：FAIL，`Failed to resolve import "./walk"`。

- [ ] **Step 3: 实现 `walk.ts`**

创建 `web/src/report/walk.ts`：

```ts
import type { ListEntry } from '../api/jfs';
import { baseName, childPath } from './paths';
import type { ReportError, WalkItem } from './types';

export type { WalkItem };

/** 明细条数软上限，超出即截断并置 `truncated`。 */
export const DEFAULT_MAX_ENTRIES = 50000;

/** 单次 stat 的路径数上限：`juicefs stat` 的 path 全在一个 argv 里，超长会失败。 */
export const DEFAULT_STAT_BATCH_SIZE = 500;

/**
 * walk 的外部依赖。刻意注入而非直接调 `jfs`：
 * 递归、分批、错误归类这些有判断力的逻辑必须能在没有网络的环境里单测。
 */
export interface WalkDeps {
  /** 列出一个目录的**直接子项**；dirPath 为挂载内绝对路径。 */
  list: (dirPath: string) => Promise<ListEntry[]>;
  /** 批量读目录 mtime；返回「挂载内路径 -> ISO 时间」，解析失败的路径缺席。 */
  stat: (paths: string[]) => Promise<Map<string, string>>;
}

export interface WalkOptions {
  mount: string;
  path: string;
  recursive: boolean;
  includeDirs: boolean;
  maxEntries?: number;
  statBatchSize?: number;
}

export interface WalkResult {
  items: WalkItem[];
  errors: ReportError[];
  truncated: boolean;
}

/**
 * 递归收集一个挂载内某路径下的元数据。
 *
 * 顺序**不作保证**——排序由 `buildReport` 统一负责，那是报表可比性的唯一来源。
 * 读取失败不中断遍历：`list` 失败记一条 error 并跳过该子树，`stat` 失败给该批
 * 每个路径各记一条；失败的路径永远保持 `mtime: null` / `mtime_source: 'none'`。
 */
export async function walkMount(deps: WalkDeps, opts: WalkOptions): Promise<WalkResult> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const rawBatch = opts.statBatchSize ?? DEFAULT_STAT_BATCH_SIZE;
  // 非正数会让下面的步进循环原地打转。
  const batchSize = rawBatch > 0 ? rawBatch : DEFAULT_STAT_BATCH_SIZE;

  const dirs: WalkItem[] = [];
  const files: WalkItem[] = [];
  const errors: ReportError[] = [];
  let count = 0;
  let truncated = false;

  const push = (item: WalkItem): boolean => {
    if (count >= maxEntries) {
      truncated = true;
      return false;
    }
    if (item.type === 'dir') dirs.push(item);
    else files.push(item);
    count++;
    return true;
  };

  // 选中范围的根节点也出一条明细（分区导出时它就是挂载根目录）。
  // 列表接口不会返回父节点自身，所以它的时间只能来自 stat。
  if (opts.includeDirs) {
    push({
      path: opts.path,
      name: baseName(opts.path) || opts.mount,
      type: 'dir',
      size: 0,
      etag: null,
      mtime: null,
      mtime_source: 'none',
    });
  }

  const queue: string[] = [opts.path];
  const visited = new Set<string>([opts.path]);

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let children: ListEntry[];
    try {
      children = await deps.list(dir);
    } catch (err) {
      errors.push({ path: dir, stage: 'list', message: describe(err) });
      continue;
    }

    for (const child of children) {
      const path = childPath(dir, child.name);
      if (child.is_dir) {
        if (opts.includeDirs && !push(dirItem(path, child))) break;
        if (opts.recursive && !visited.has(path)) {
          visited.add(path);
          queue.push(path);
        }
      } else if (!push(fileItem(path, child))) {
        break;
      }
    }
    if (truncated) break;
  }

  await fillDirMtimes(deps, dirs, batchSize, errors);

  return { items: [...files, ...dirs], errors, truncated };
}

function fileItem(path: string, entry: ListEntry): WalkItem {
  return {
    path,
    name: entry.name,
    type: 'file',
    size: entry.size ?? 0,
    etag: entry.etag ?? null,
    // 数据面列表的 LastModified 就是元数据 mtime（导入时保真写入）。
    mtime: entry.mtime ?? null,
    mtime_source: entry.mtime ? 's3' : 'none',
  };
}

function dirItem(path: string, entry: ListEntry): WalkItem {
  return {
    path,
    name: entry.name,
    type: 'dir',
    // 目录不吃字节数，写 0 而不是列表里可能存在的占位值。
    size: 0,
    etag: null,
    // 目录时间**只**由本模块的 stat 批量提供，刻意忽略列表带来的目录 mtime：
    // 注入的 lister 可能自己附带目录时间（`listPrefix` 就会，且来源是控制面
    // `/foyer/stat`），在这里采信会把控制面的时间误标成数据面的 's3'。
    mtime: null,
    mtime_source: 'none',
  };
}

/** 二遍回填目录 mtime：必须在遍历结束后做，因为新建子项会把父目录时间刷掉。 */
async function fillDirMtimes(
  deps: WalkDeps,
  dirs: WalkItem[],
  batchSize: number,
  errors: ReportError[]
): Promise<void> {
  if (dirs.length === 0) return;
  const byPath = new Map(dirs.map(d => [d.path, d]));
  const paths = dirs.map(d => d.path);

  for (let i = 0; i < paths.length; i += batchSize) {
    const chunk = paths.slice(i, i + batchSize);
    let hits: Map<string, string>;
    try {
      hits = await deps.stat(chunk);
    } catch (err) {
      for (const p of chunk) {
        errors.push({ path: p, stage: 'stat', message: describe(err) });
      }
      continue;
    }
    hits.forEach((iso, p) => {
      const item = byPath.get(p);
      if (!item) return;
      item.mtime = iso;
      item.mtime_source = 'stat';
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: 运行确认 walk 测试通过**

```powershell
cd web
npm test -- src/report/walk.test.ts
```

预期：全绿。

- [ ] **Step 5: 全量测试与类型检查**

```powershell
cd web
npm test
npm run lint
```

预期：vitest 全绿；`tsc --noEmit` 无输出。

- [ ] **Step 6（可选）: 提交**

```powershell
git add web/src/report/walk.ts web/src/report/walk.test.ts
git commit -m "feat(web): recursive metadata walk with batched dir mtime"
```

---

### Task 4: 接上真实数据面（路径换算 + 导出编排）

**Files:**
- Create: `web/src/report/live.ts`
- Create: `web/src/report/live.test.ts`
- Create: `web/src/report/live.list.test.ts`（单独一个文件，因为需要模块级 mock 替换 `listPrefix`）
- Modify: `web/src/api/jfs.ts`（只给 `listPrefix` 加一个可选的 `withDirMtimes`，默认 true，行为向后兼容）

**Interfaces:**
- Consumes: `jfs.listPrefix` / `jfs.foyerStat` / `jfs.refToKey` / `jfs.joinRef` / `jfs.dirMtimesFromStats`（均已存在，`listPrefix` 本次加参数）、`walkMount` / `WalkDeps`（Task 3）、`buildReport`（Task 1）
- Produces（供 Task 5 使用）:

```ts
export function volumeKey(mount: string, path: string): string;
export function volumePath(mount: string, path: string): string;
export function liveWalkDeps(mount: string): WalkDeps;
export function defaultGenerator(operator: string): ReportGenerator;
export interface ExportOptions {
  scope: ReportScope; source: ReportSource; operator: string;
  maxEntries?: number; now?: () => Date;
}
export function runExport(opts: ExportOptions): Promise<MetadataReport>;
export function downloadReport(filename: string, text: string, format: ReportFormat): void;
```

**路径换算的依据**（已核实）：桶内对象的 key 就是「挂载内绝对路径去掉前导斜杠」——对卷挂载 `foyer` 而言是 `2026/a.jpg`，对普通挂载 `photos` 而言是 `photos/2026/a.jpg`。这正是 `jfs.refToKey('photos:/2026')` 的行为，也正是 foyer 导入时 `dest` 的语义。控制面 `/foyer/stat` 吃的是**卷内绝对路径**（带前导斜杠），即 `jfs` 里 `attachDirMtimes` 传的形态。

**为什么要给 `listPrefix` 加 `withDirMtimes`（消除冗余查询）**：`listPrefix` 内部会调 `attachDirMtimes`，把本层子目录的 mtime 从控制面查回来——文件管理器依赖它。但报表这条链上，`walk` 自己会批量 stat 全部目录，于是每个目录被查了两遍同一个元数据引擎（N 个目录约提交 2N 条路径）。给 `listPrefix` 加一个默认 true 的可选参数，报表路径传 `false` 跳过第一次，目录时间仍由 `walk` 的分批 stat 提供——既去掉冗余，又保住宽目录的 argv 保险（`attachDirMtimes` 把该层子目录一次性塞进一个请求，无分批）。默认 true 保证 `web/src/api/client.ts:164,174` 两个既有调用点行为不变。

---

- [ ] **Step 1: 先写失败测试**

创建 `web/src/report/live.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultGenerator, liveWalkDeps, volumeKey, volumePath } from './live';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('volumeKey', () => {
  it('prefixes a normal mount with its own name', () => {
    expect(volumeKey('photos', '/')).toBe('photos');
    expect(volumeKey('photos', '/2026')).toBe('photos/2026');
    expect(volumeKey('photos', '/2026/sub')).toBe('photos/2026/sub');
  });

  it('does not prefix the gateway volume itself', () => {
    expect(volumeKey('foyer', '/')).toBe('');
    expect(volumeKey('foyer', '/photos')).toBe('photos');
  });
});

describe('volumePath', () => {
  it('returns the volume-absolute path that /foyer/stat expects', () => {
    expect(volumePath('photos', '/2026')).toBe('/photos/2026');
    expect(volumePath('foyer', '/photos')).toBe('/photos');
  });
});

describe('liveWalkDeps', () => {
  it('translates stat results back to mount-relative keys', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            stats: [
              { path: '/photos/2026', type: 'directory', mtime: 1777690800 },
              { path: '/photos/ghost', error: 'no such file or directory' },
            ],
          }),
          text: async () => '',
        };
      })
    );

    const deps = liveWalkDeps('photos');
    const got = await deps.stat(['/2026', '/ghost']);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('path=%2Fphotos%2F2026');
    expect(urls[0]).toContain('path=%2Fphotos%2Fghost');
    expect(got.get('/2026')).toBe('2026-05-02T03:00:00.000Z');
    // 解析失败的路径必须缺席，让上层显示 null 而不是编一个时间。
    expect(got.has('/ghost')).toBe(false);
  });

  it('skips the request entirely when there is nothing to stat', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const got = await liveWalkDeps('photos').stat([]);
    expect(got.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('defaultGenerator', () => {
  it('stamps the generator identity and the operator', () => {
    expect(defaultGenerator('admin')).toEqual({
      name: 'foyer-web',
      version: '0.0.0',
      operator: 'admin',
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd web
npm test -- src/report/live.test.ts
```

预期：FAIL，`Failed to resolve import "./live"`。

- [ ] **Step 3: 给 `listPrefix` 加可选参数（消除冗余查询）**

修改 `web/src/api/jfs.ts`：把 `listPrefix` 的签名从 `(dirPath: string)` 改为 `(dirPath: string, opts: ListPrefixOptions = {})`，并在文件里 `ListEntry` 类型旁新增：

```ts
export interface ListPrefixOptions {
  /**
   * 是否顺带把本层子目录的 mtime 从控制面补上（`attachDirMtimes`）。
   *
   * 默认 true——文件管理器依赖它。导出报表这条链上必须传 false：`walk` 会自己
   * 按 500/批 stat 全部目录，若这里也补一次，每个目录会被查两遍同一个元数据
   * 引擎（N 个目录约提交 2N 条路径）。而 `attachDirMtimes` 没有分批，宽目录
   * （上万子目录）有 `juicefs stat` argv 超限的风险，所以不能反过来只留它。
   */
  withDirMtimes?: boolean;
}
```

并把函数体的最后两行改成：

```ts
  if (opts.withDirMtimes !== false) await attachDirMtimes(dirs);
  return entries;
```

默认 true 保证既有调用点（`web/src/api/client.ts:164,174`）行为完全不变。

- [ ] **Step 4: 实现 `live.ts`**

创建 `web/src/report/live.ts`：

```ts
import * as jfs from '../api/jfs';
import { dirMtimesFromStats } from '../api/jfs';
import { buildReport } from './build';
import type { ReportFormat } from './format';
import { REPORT_GENERATOR_NAME, REPORT_GENERATOR_VERSION } from './types';
import type { MetadataReport, ReportGenerator, ReportScope, ReportSource } from './types';
import { walkMount } from './walk';
import type { WalkDeps } from './walk';

/**
 * 挂载内绝对路径 -> 桶内 key（不带前导斜杠）。
 * 对卷挂载（`foyer`）不加前缀，对普通挂载（`photos`）加 `photos/`。
 */
export function volumeKey(mount: string, path: string): string {
  return jfs.refToKey(jfs.joinRef(mount, path));
}

/** 挂载内绝对路径 -> 卷内绝对路径，即控制面 `/foyer/stat` 的入参形态。 */
export function volumePath(mount: string, path: string): string {
  return `/${volumeKey(mount, path)}`;
}

/** 把一个挂载接到真实的 `jfs` 数据面/控制面，交给 `walkMount` 使用。 */
export function liveWalkDeps(mount: string): WalkDeps {
  return {
    list: (dirPath: string) => jfs.listPrefix(volumeKey(mount, dirPath), { withDirMtimes: false }),

    stat: async (paths: string[]): Promise<Map<string, string>> => {
      if (paths.length === 0) return new Map();

      // 请求里用的是卷内绝对路径，回来还要折回挂载内路径。
      const volToRel = new Map<string, string>();
      for (const p of paths) volToRel.set(volumePath(mount, p), p);

      const raw = await jfs.foyerStat([...volToRel.keys()]);
      const rel = new Map<string, jfs.FoyerStatResult>();
      raw.forEach((res, volPath) => {
        const relPath = volToRel.get(volPath);
        if (relPath) rel.set(relPath, res);
      });

      // dirMtimesFromStats 已经正确处理了 error 条目与非数值 mtime：缺席即缺时间。
      return dirMtimesFromStats(rel);
    },
  };
}

export function defaultGenerator(operator: string): ReportGenerator {
  return {
    name: REPORT_GENERATOR_NAME,
    version: REPORT_GENERATOR_VERSION,
    operator,
  };
}

export interface ExportOptions {
  scope: ReportScope;
  source: ReportSource;
  operator: string;
  maxEntries?: number;
  /** 注入时钟，便于测试断言 generated_at。 */
  now?: () => Date;
}

/** 导出编排：遍历 -> 构造报表。纯读取，不产生任何写操作。 */
export async function runExport(opts: ExportOptions): Promise<MetadataReport> {
  const generatedAt = (opts.now?.() ?? new Date()).toISOString();
  const walked = await walkMount(liveWalkDeps(opts.scope.mount), {
    mount: opts.scope.mount,
    path: opts.scope.path,
    recursive: opts.scope.recursive,
    includeDirs: opts.scope.include_dirs,
    maxEntries: opts.maxEntries,
  });

  return buildReport({
    scope: opts.scope,
    source: opts.source,
    generator: defaultGenerator(opts.operator),
    generatedAt,
    items: walked.items,
    errors: walked.errors,
    truncated: walked.truncated,
  });
}

/** 触发浏览器下载。文本已经在内存里，不需要服务端参与。 */
export function downloadReport(filename: string, text: string, format: ReportFormat): void {
  const mime = format === 'json' ? 'application/json' : 'text/csv';
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: 运行确认 live 测试通过**

```powershell
cd web
npm test -- src/report/live.test.ts
```

预期：全绿。

- [ ] **Step 6: 写接线断言，钉住「报表路径不重复查目录时间」**

`live.test.ts` 里 stub 的是 `fetch`，拦不到 S3 客户端，无法观察 `listPrefix` 的调用形态。所以单开一个文件，用模块级 mock 只替换 `listPrefix`，其余走真实实现（`vi.mock` 会被提升到 import 之前，工厂函数必须用 `vi.hoisted` 定义 spy）。

创建 `web/src/report/live.list.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';

// 只替换 listPrefix，其余（refToKey / joinRef / foyerStat / dirMtimesFromStats）用真实实现，
// 这样 volumeKey 的换算仍走线上逻辑。jfs.ts 的 S3Client 是惰性创建的，导入它无副作用。
const { listPrefix } = vi.hoisted(() => ({ listPrefix: vi.fn(async () => []) }));

vi.mock('../api/jfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/jfs')>();
  // 只替换 listPrefix；类型按真实签名标注，否则 `unknown[]` 展开会被 tsc 拒收
  // （TS2556）。运行时仍是同一个 spy，调用记录不变。
  return { ...actual, listPrefix: listPrefix as unknown as typeof actual.listPrefix };
});

import { liveWalkDeps } from './live';

describe('liveWalkDeps list wiring', () => {
  it('lists without asking for directory mtimes', async () => {
    await liveWalkDeps('photos').list('/2026');
    // 报表路径必须跳过 attachDirMtimes：walk 自己会分批 stat 全部目录。
    expect(listPrefix).toHaveBeenCalledWith('photos/2026', { withDirMtimes: false });
  });
});
```

- [ ] **Step 7: 运行确认接线断言通过**

```powershell
cd web
npm test -- src/report/live.list.test.ts
```

预期：全绿。若断言失败（例如只传了一个参数），说明 `live.ts` 没接上 `withDirMtimes: false`，冗余查询仍在。

- [ ] **Step 8: 全量测试与类型检查**

```powershell
cd web
npm test
npm run lint
```

预期：vitest 全绿；`tsc --noEmit` 无输出。

- [ ] **Step 9（可选）: 提交**

```powershell
git add web/src/api/jfs.ts web/src/report/live.ts web/src/report/live.test.ts web/src/report/live.list.test.ts
git commit -m "feat(web): wire metadata report to the foyer data plane"
```

---

### Task 5: 导出弹窗与入口

**Files:**
- Modify: `web/src/context/FileStoreContext.tsx`（接口约 65-68 行、state 约 129-134 行、value 约 597-604 行）
- Create: `web/src/components/ExportReportModal.tsx`
- Modify: `web/src/components/Header.tsx`（lucide 导入、解构、`currentTab === 'files'` 操作区）
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `runExport` / `downloadReport`（Task 4）、`toJSON` / `toCSV` / `reportFileName`（Task 2）、`REPORT_SCHEMA`、`jfs.JFS_BUCKET`
- Produces: 无新导出（用户可见的「导出元数据」入口）

**本任务无自动化测试**：vitest 是 `environment: 'node'`，没有 DOM，弹窗无法在此渲染。验收靠 `npm run lint`（类型正确）+ Step 4 的手工清单。这是本仓库既有的约束，不是遗漏。

---

- [ ] **Step 1: 在 Context 中挂上开关**

修改 `web/src/context/FileStoreContext.tsx`。

在接口里 `isCopyMoveMoveMode` 之后追加两行：

```ts
  isCopyMoveMoveMode: boolean;
  setIsCopyMoveMoveMode: (val: boolean) => void;
  isExportOpen: boolean;
  setIsExportOpen: (open: boolean) => void;
```

在 state 区里 `isCopyMoveMoveMode` 之后追加：

```ts
  const [isCopyMoveMoveMode, setIsCopyMoveMoveMode] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
```

在 `value={{ ... }}` 里 `setIsCopyMoveMoveMode,` 之后追加：

```ts
        setIsCopyMoveMoveMode,
        isExportOpen,
        setIsExportOpen,
```

- [ ] **Step 2: 新建弹窗组件**

创建 `web/src/components/ExportReportModal.tsx`：

```tsx
import React, { useState } from 'react';
import { Download, FileJson, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { JFS_BUCKET } from '../api/jfs';
import { useFileStore } from '../context/FileStoreContext';
import { reportFileName, toCSV, toJSON } from '../report/format';
import type { ReportFormat } from '../report/format';
import { downloadReport, runExport } from '../report/live';
import { REPORT_SCHEMA } from '../report/types';
import type { ReportScope, ReportSource } from '../report/types';

type ScopeKind = 'mount' | 'directory';

export const ExportReportModal: React.FC = () => {
  const { isExportOpen, setIsExportOpen, currentMount, currentPath, mounts, username } = useFileStore();

  const [kind, setKind] = useState<ScopeKind>('directory');
  const [format, setFormat] = useState<ReportFormat>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  if (!isExportOpen) return null;

  const close = () => {
    setError('');
    setDone('');
    setIsExportOpen(false);
  };

  const mountObj = mounts.find(m => m.name === currentMount);
  const path = kind === 'mount' ? '/' : currentPath || '/';
  const ref = `${currentMount}:${path}`;

  const handleExport = async () => {
    if (!currentMount) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const scope: ReportScope = {
        kind,
        mount: currentMount,
        path,
        ref,
        recursive: true,
        include_dirs: true,
        detail: 'basic',
      };
      const source: ReportSource = {
        volume: JFS_BUCKET,
        driver: mountObj?.type || '',
        mount_spec: { ...(mountObj?.spec || {}) },
      };

      const report = await runExport({ scope, source, operator: username || 'admin' });
      const text = format === 'json' ? toJSON(report) : toCSV(report);
      downloadReport(reportFileName(currentMount, format, report.generated_at), text, format);

      const s = report.summary;
      setDone(
        `已导出 ${s.entry_count} 条：文件 ${s.file_count} / 目录 ${s.dir_count}，` +
          `${s.error_count} 条读取失败${s.truncated ? '，已达上限被截断' : ''}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-indigo-600" />
            <span className="font-semibold text-sm text-slate-900">导出元数据报表</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
              {REPORT_SCHEMA.replace('foyer.metadata-report/', '')}
            </span>
          </div>
          <button
            onClick={close}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs text-slate-700">
          <div>
            <div className="font-medium text-slate-800 mb-1.5">导出范围</div>
            <label className="flex items-start gap-2 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <input
                type="radio"
                name="export-scope"
                checked={kind === 'mount'}
                onChange={() => setKind('mount')}
                className="mt-0.5"
              />
              <span>
                <span className="font-mono font-semibold">{currentMount}:</span>
                <span className="block text-[11px] text-slate-500">整个分区（递归整棵子树）</span>
              </span>
            </label>
            <label className="flex items-start gap-2 p-2 mt-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <input
                type="radio"
                name="export-scope"
                checked={kind === 'directory'}
                onChange={() => setKind('directory')}
                className="mt-0.5"
              />
              <span>
                <span className="font-mono font-semibold">{currentMount}:{currentPath || '/'}</span>
                <span className="block text-[11px] text-slate-500">当前目录（递归该目录）</span>
              </span>
            </label>
          </div>

          <div>
            <div className="font-medium text-slate-800 mb-1.5">输出格式</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setFormat('json')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors ${
                  format === 'json'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <FileJson className="w-3.5 h-3.5" />
                <span>JSON（规范格式）</span>
              </button>
              <button
                type="button"
                onClick={() => setFormat('csv')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors ${
                  format === 'csv'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>CSV（表格）</span>
              </button>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-[11px] text-slate-500 leading-relaxed">
            <div>
              目标：<span className="font-mono text-slate-700">{ref}</span>
            </div>
            <div className="mt-1">
              只读清单报表：含路径、大小、ETag、修改时间（含出处）与扩展名汇总。
              不含文件内容、权限/属主，也<strong>不能</strong>用于恢复元数据。
            </div>
            <div className="mt-1">导出会递归读取该范围内的全部对象，大目录可能较慢。</div>
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 text-[11px] text-rose-700">
              {error}
            </div>
          )}
          {done && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-[11px] text-emerald-800">
              {done}
            </div>
          )}
        </div>

        <div className="p-3.5 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50/40">
          <button
            type="button"
            onClick={close}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={busy || !currentMount}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
          >
            {busy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>导出中…</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>导出 {format.toUpperCase()}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: 加 Header 入口并挂载弹窗**

修改 `web/src/components/Header.tsx`。

lucide 导入块里追加 `Download`（放在 `UploadCloud` 附近）：

```tsx
  UploadCloud,
  Download,
```

解构块里 `refreshDirectory,` 之后追加：

```tsx
    refreshDirectory,
    setIsExportOpen,
```

`currentTab === 'files'` 的操作区里，在「新建目录」按钮之前插入：

```tsx
              <button
                onClick={() => setIsExportOpen(true)}
                disabled={!currentMount}
                title="把当前分区或当前目录的元数据导出为报表"
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors disabled:opacity-40"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>导出元数据</span>
              </button>
```

修改 `web/src/App.tsx`：导入并渲染。

```tsx
import { CopyMoveModal } from './components/CopyMoveModal';
import { ExportReportModal } from './components/ExportReportModal';
```

在 `<CopyMoveModal />` 之后追加：

```tsx
      <CopyMoveModal />
      <ExportReportModal />
```

- [ ] **Step 4: 类型检查与手工验收**

```powershell
cd web
npm run lint
npm run dev
```

手工清单（对着真实栈，stack 起法见 `deploy/compose.yml`）：

1. 登录控制台 → 文件页 → 顶部出现「导出元数据」按钮。
2. 进入某个导入的挂载（如 `photos:`），停在 `/2026` → 打开弹窗 → 默认选中「当前目录」→ 选 JSON → 导出 → 浏览器下载 `foyer-report-photos-<时间戳>.json`。
3. 打开该文件：`schema` 为 `foyer.metadata-report/v1`；`scope.path` 为 `/2026`；`entries` 按 `path` 升序；目录行的 `mtime_source` 为 `stat` 且时间等于文件页显示的目录时间（**不是**导出时刻）；`summary.entry_count` 与文件页条目数一致。
4. 切到「整个分区」→ 导出 CSV → 用 Excel 打开：中文文件名不乱码（BOM 生效）；`mtime` 列是可排序的 ISO 串；无时间的行该列为空而不是当前时间。
5. 重复导出同一范围两次 → 两个 JSON 除 `generated_at` 外逐字节一致（排序确定性）。
6. 导出挂载根 `photos:/`，确认根目录自身也有一条明细且 `name` 为 `photos`。
7. 对不存在的路径（先在某挂载里删掉一个目录再导出其父目录）→ 不报错崩溃，失败项计入 `summary.error_count` 与 `errors[]`。

- [ ] **Step 5（可选）: 提交**

```powershell
git add web/src/context/FileStoreContext.tsx web/src/components/ExportReportModal.tsx web/src/components/Header.tsx web/src/App.tsx
git commit -m "feat(web): metadata report export modal and entry point"
```

---

## 明确不做（本计划）

- **可 `juicefs load` 恢复的元数据备份**（dump 包装）：本篇是只读报表，受众、体积、安全边界都不同，另立一期。
- **文件内容导出**。
- **POSIX `inode/mode/uid/gid/nlink`**：`detail: 'full'` 只在 type 里预留 `ReportDetail`，本期不实现、不调用逐路径 stat。
- **`atime` / `ctime`**：上游 `object.Object` 接口不暴露（只有 `Key/Size/Mtime/IsDir/IsSymlink/StorageClass`）。
- **XLSX 多 sheet、NDJSON 流式、服务端生成、异步任务产物**。
- **`tags` / `custom_meta` 的真实值**：依赖「标签持久化」前置任务（`FileStatDrawer.tsx` 写入的标签目前只在 React state，`FileStoreContext.tsx:539` 更新，刷新即丢）。字段与 CSV 列已占位。
- **Web 端对导出挂载的写保护拦截**：导出本身只读，不涉及。

## 已知取舍

- `REPORT_GENERATOR_VERSION` 是 `types.ts` 里的常量（当前 `0.0.0`，与 `web/package.json` 一致）。页面构建不注入 package 元数据，为它改 vite 配置不划算；发版时手动同步。
- 弹窗不显示「预计条数」：那需要先跑一遍完整遍历，代价等于导出本身。改为导出完成后回显真实计数与是否截断。

## Spec 覆盖对照

| Spec 条目 | 任务 |
|---|---|
| `foyer.metadata-report/v1` 信封（schema / generated_at / generator / scope / source） | 1 |
| 明细行全部字段（含 `mtime_source`、`parent_path`、`ext`） | 1 |
| `summary`（计数、`by_extension`、`mtime_range`、`error_count`、`truncated`） | 1 |
| `errors[]` 与「失败不进计数」口径 | 1 + 3 |
| 排序确定性（`path` 升序） | 1 |
| CSV 13 列投影、转义、BOM | 2 |
| `kind=mount` / `kind=directory`、`recursive`、`include_dirs` | 3 + 5 |
| 目录 mtime 由控制面 stat 回填 | 3 + 4 |
| stat 按 ~500 path 分批 | 3 |
| 缺失即 `null`、禁止冒充时间 | 1 + 3（测试断言） |
| 纯前端、零后端改动 | 全部 |
| `tags`/`custom_meta` 字段占位 | 1 + 2 |
| 5 万条软上限与 `truncated` | 3 |
| 导出入口与范围/格式选择 | 5 |
| 标签持久化前置任务 | 不做（另立一期） |

---

## 落地后的偏差与增补（实施后追加）

以下为实施与多轮评审后相对上文计划正文的实际差异，以此为准：

1. **给 `listPrefix` 加了可选 `withDirMtimes`（默认 true）**，报表路径传 `false`。原计划让报表路径直接调 `listPrefix`，会与 walk 自己的分批 stat 对每个目录查两遍元数据引擎。既有调用点（`client.ts:164,174`）行为不变。
2. **`walk` 的 `dirItem` 改为忽略列表带来的目录 mtime**（硬编码 `mtime: null` / `mtime_source: 'none'`），目录时间只由本模块的 stat 提供。原计划在此采信列表值并标 `'s3'`，但 `listPrefix` 的目录时间实为控制面来源，会误标。
3. **新增 `WalkProgress`，`WalkOptions` 增 `onProgress` / `isCancelled`，`WalkResult` 增 `cancelled`**；`runExport` 返回类型由 `MetadataReport` 改为 `ExportOutcome { report, cancelled }`。计划正文没有进度/取消，是最终评审后用户明确要求的。
4. **`fillDirMtimes` 增加「批次级未解析错误」**：整批成功但个别路径没被解析时，该批只记一条 error（`path` 指向第一个未解析路径）。整批抛错仍按路径各记一条。
5. **`fillDirMtimes` 增加批间取消**：每批之前（含第一批）询问 `isCancelled`，已取回的时间保留；返回布尔值由 `walkMount` 并入 `cancelled`。
6. **导出弹窗增加了进度回显、取消按钮，以及严格「绝不下载」保证**：`downloadReport` 之前再确认一次取消标志；`close()` 在 busy 时置取消位。多出一个 UI-only 的 `stopping` 状态（ref 变更不触发重渲染）。
7. **`live.list.test.ts` 的 mock 用 `listPrefix as unknown as typeof actual.listPrefix`**：计划正文的 `(...args: unknown[]) => listPrefix(...args)` 过不了 `tsc`（TS2556）。
8. **`format.test.ts` / `build.test.ts` 的测试加固**：CSV 表头改为字面量断言、`tags`/`custom_meta` 改为整行 `toBe`、目录 fixture 用非 0 size 以真正钉住 `total_bytes` 只累加文件。
9. **`source.mount_spec` 仍原样带出**（用户确认接受的已知限制，见 spec「落地后的已知限制」）。

