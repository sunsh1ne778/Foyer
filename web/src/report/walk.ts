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

export interface WalkProgress {
  /** 已收集的明细条数。 */
  entries: number;
  /** 已列过的目录数。 */
  dirs: number;
}

export interface WalkOptions {
  mount: string;
  path: string;
  recursive: boolean;
  includeDirs: boolean;
  maxEntries?: number;
  statBatchSize?: number;
  /** 每列完一个目录回调一次，用于进度回显。 */
  onProgress?: (p: WalkProgress) => void;
  /**
   * 返回 true 时停止后续读取：遍历阶段在当前目录边界停下，stat 阶段在下一批之前停下。
   * 已经收集的明细与已经取回的目录时间都会保留。
   */
  isCancelled?: () => boolean;
}

export interface WalkResult {
  items: WalkItem[];
  errors: ReportError[];
  truncated: boolean;
  /** 因 isCancelled 提前停止。与 truncated 区分：截断是撞上上限，取消是用户要求。 */
  cancelled: boolean;
}

/**
 * 递归收集一个挂载内某路径下的元数据。
 *
 * 顺序**不作保证**——排序由 `buildReport` 统一负责，那是报表可比性的唯一来源。
 * 读取失败不中断遍历：`list` 失败记一条 error 并跳过该子树，`stat` 失败给该批
 * 每个路径各记一条；批次成功但个别路径未被解析时，按批记一条。失败的路径永远保持
 * `mtime: null` / `mtime_source: 'none'`。
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
  let cancelled = false;
  let listed = 0;

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
    if (opts.isCancelled?.()) {
      cancelled = true;
      break;
    }
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
    listed++;
    opts.onProgress?.({ entries: count, dirs: listed });
    if (truncated) break;
  }

  const statCancelled = await fillDirMtimes(deps, dirs, batchSize, errors, opts.isCancelled);

  return { items: [...files, ...dirs], errors, truncated, cancelled: cancelled || statCancelled };
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
  errors: ReportError[],
  isCancelled?: () => boolean
): Promise<boolean> {
  if (dirs.length === 0) return false;
  const byPath = new Map(dirs.map(d => [d.path, d]));
  const paths = dirs.map(d => d.path);

  for (let i = 0; i < paths.length; i += batchSize) {
    // 每批之前都看一次取消（含第一批）：遍历阶段就取消的，整个 stat 阶段不发请求；
    // stat 阶段取消的，已取回的时间保留、剩下的批次不再发。
    if (isCancelled?.()) return true;
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
    // 批次本身没抛错，但个别路径没被解析（控制面报错、或无 mtime）。目录时间只有一个
    // 来源，缺席就无法给出时间，必须记账：`mtime_source: 'none'` 于是不再把「源没有」
    // 与「读失败」混为一谈。按批次只记一条，避免宽目录下错误列表爆炸。
    const missing = chunk.filter(p => !hits.has(p));
    if (missing.length > 0) {
      errors.push({
        path: missing[0],
        stage: 'stat',
        message:
          missing.length === chunk.length
            ? `${missing.length} 个目录未返回时间`
            : `${missing.length}/${chunk.length} 个目录未返回时间（含 ${missing[0]}）`,
      });
    }
  }
  return false;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
