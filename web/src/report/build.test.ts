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
  { path: '/2026', name: '2026', type: 'dir', size: 4096, etag: null, mtime: '2020-01-01T00:00:00.000Z', mtime_source: 'stat' },
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
    // 目录那条 fixture 的 size 是 4096，明确断言它不计入 total_bytes：
    // 115 = 10 + 100 + 5（三个文件），正是钉死「目录不吃字节数」这条规则。
    expect(r.entries.find(e => e.type === 'dir')?.size).toBe(4096);
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
