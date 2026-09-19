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

  it('pins the exact header row, in order', () => {
    const header = toCSV(report([])).split('\r\n')[0];
    expect(header).toBe(
      '\uFEFFref,mount,path,parent_path,name,type,ext,size,etag,mtime,mtime_source,tags,custom_meta'
    );
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
    // 整行 toBe：钉死列序——只做 toContain 的话，交换 tags / custom_meta 两列仍会通过。
    expect(row).toBe(
      'photos:/2026/a.jpg,photos,/2026/a.jpg,/2026,a.jpg,file,jpg,16384,9c1f,2020-01-02T03:04:05.123Z,s3,"[""财务"",""a,b""]","{""来源"":""扫描""}"'
    );
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
