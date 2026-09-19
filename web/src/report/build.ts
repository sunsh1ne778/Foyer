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
