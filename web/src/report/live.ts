import * as jfs from '../api/jfs';
import { dirMtimesFromStats } from '../api/jfs';
import { buildReport } from './build';
import type { ReportFormat } from './format';
import { REPORT_GENERATOR_NAME, REPORT_GENERATOR_VERSION } from './types';
import type { MetadataReport, ReportGenerator, ReportScope, ReportSource } from './types';
import { walkMount } from './walk';
import type { WalkDeps, WalkProgress } from './walk';

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
  onProgress?: (p: WalkProgress) => void;
  isCancelled?: () => boolean;
}

export interface ExportOutcome {
  report: MetadataReport;
  /** 用户在导出过程中按了取消；report 是截至取消时已收集的部分。 */
  cancelled: boolean;
}

/** 导出编排：遍历 -> 构造报表。纯读取，不产生任何写操作。 */
export async function runExport(opts: ExportOptions): Promise<ExportOutcome> {
  const generatedAt = (opts.now?.() ?? new Date()).toISOString();
  const walked = await walkMount(liveWalkDeps(opts.scope.mount), {
    mount: opts.scope.mount,
    path: opts.scope.path,
    recursive: opts.scope.recursive,
    includeDirs: opts.scope.include_dirs,
    maxEntries: opts.maxEntries,
    onProgress: opts.onProgress,
    isCancelled: opts.isCancelled,
  });

  const report = buildReport({
    scope: opts.scope,
    source: opts.source,
    generator: defaultGenerator(opts.operator),
    generatedAt,
    items: walked.items,
    errors: walked.errors,
    truncated: walked.truncated,
  });

  return { report, cancelled: walked.cancelled };
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
