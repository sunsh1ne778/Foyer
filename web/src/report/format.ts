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
