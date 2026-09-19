import { describe, expect, it } from 'vitest';
import { dirMtimesFromStats, mtimeISO, type FoyerStatResult } from './jfs';
import { mapListEntry } from './mappers';
import type { Mount } from '../types';

describe('mtimeISO', () => {
  it('folds JuiceFS seconds + nanoseconds into the S3 LastModified shape', () => {
    // 2026-05-02T03:00:00Z，正是导入保真用例里 /sub 的源时间。
    expect(mtimeISO(1777690800)).toBe('2026-05-02T03:00:00.000Z');
    expect(mtimeISO(1777690800, 123456789)).toBe('2026-05-02T03:00:00.123Z');
    // 纳秒不足 1ms 时不能变成 1ms。
    expect(mtimeISO(1777690800, 999)).toBe('2026-05-02T03:00:00.000Z');
  });
});

describe('dirMtimesFromStats', () => {
  it('keeps only paths that resolved with a numeric mtime', () => {
    const stats = new Map<string, FoyerStatResult>([
      ['/photos/sub', { path: '/photos/sub', type: 'directory', mtime: 1777690800 }],
      ['/photos/ghost', { path: '/photos/ghost', error: 'lookup ghost: no such file or directory' }],
      ['/photos/weird', { path: '/photos/weird', type: 'directory' }],
    ]);

    const got = dirMtimesFromStats(stats);

    expect(got.get('/photos/sub')).toBe('2026-05-02T03:00:00.000Z');
    // 失败与缺字段的目录必须缺席，这样上层才会显示 '-' 而不是编一个时间。
    expect(got.has('/photos/ghost')).toBe(false);
    expect(got.has('/photos/weird')).toBe(false);
    expect(got.size).toBe(1);
  });
});

describe('mapListEntry', () => {
  const mount = { id: 'photos', name: 'photos', type: 'local' } as Mount;

  it('does not invent a timestamp for entries the listing had none for', () => {
    const node = mapListEntry({ name: 'sub', key: '/photos/sub', is_dir: true }, mount);
    // 曾经的实现回退成 new Date()，于是界面上每个文件夹都显示"刚刚"。
    expect(node.mtime).toBe('');
    expect(node.updated_at).toBe('');
  });

  it('passes through a real timestamp', () => {
    const node = mapListEntry(
      { name: 'a.txt', key: '/photos/a.txt', is_dir: false, mtime: '2026-06-01T01:00:00.000Z' },
      mount
    );
    expect(node.mtime).toBe('2026-06-01T01:00:00.000Z');
  });
});
