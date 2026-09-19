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
    expect(res.cancelled).toBe(false);
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

  it('records one batch error when some requested dirs come back unresolved', async () => {
    // stat 不抛错，但对 /2026/sub 不给时间——这正是 live.ts 经 dirMtimesFromStats 过滤后
    // 的形态。目录时间只有一个来源，读不到必须记账。
    const deps = fakeDeps({
      stat: async (paths: string[]) => {
        const out = new Map<string, string>();
        for (const p of paths) {
          const iso = dirTimes[p];
          if (iso && p !== '/2026/sub') out.set(p, iso);
        }
        return out;
      },
    });
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].stage).toBe('stat');
    expect(res.errors[0].path).toBe('/2026/sub');
    // 该目录仍必须留空，而不是拿列表或猜测的值充数。
    expect(byPath(res.items).get('/2026/sub')?.mtime).toBeNull();
    expect(byPath(res.items).get('/2026/sub')?.mtime_source).toBe('none');
  });

  it('reports progress after each listed directory', async () => {
    const seen: number[] = [];
    await walkMount(fakeDeps(), {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
      onProgress: p => seen.push(p.entries),
    });
    // 三个目录：/、/2026、/2026/sub，条目数单调不减。
    expect(seen).toHaveLength(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(6);
  });

  it('stops at a directory boundary when cancelled', async () => {
    const statCalls: string[][] = [];
    const base = fakeDeps();
    const deps: WalkDeps = {
      ...base,
      stat: async (paths: string[]) => {
        statCalls.push([...paths]);
        return base.stat(paths);
      },
    };
    let calls = 0;
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
      isCancelled: () => calls++ > 0,
    });
    expect(res.cancelled).toBe(true);
    // 根目录已列完，/2026 与 /2026/sub 不再进入。
    expect(paths(res.items)).toEqual(['/', '/2026', '/top.txt']);
    expect(res.truncated).toBe(false);
    // 遍历阶段就取消了，整个 stat 阶段不应发出任何请求。
    expect(statCalls).toHaveLength(0);
  });

  it('stops the stat pass between batches when cancelled', async () => {
    const statCalls: string[][] = [];
    let calls = 0;
    const deps = fakeDeps({
      stat: async (paths: string[]) => {
        statCalls.push([...paths]);
        const out = new Map<string, string>();
        for (const p of paths) {
          const iso = dirTimes[p];
          if (iso) out.set(p, iso);
        }
        return out;
      },
    });
    const res = await walkMount(deps, {
      mount: 'photos', path: '/', recursive: true, includeDirs: true,
      statBatchSize: 1,
      // 遍历阶段（3 个目录）不取消；stat 阶段第一批照发，第二批之前才取消。
      // 调用计数：list 循环问 3 次（计数 0,1,2 → false）；stat 循环每批之前问一次，
      // 计数 3 → false（第一批发出），计数 4 → true（后续批次跳过）。
      isCancelled: () => calls++ >= 4,
    });
    expect(res.cancelled).toBe(true);
    // 第一批已发出，剩下的批次不再发。
    expect(statCalls).toHaveLength(1);
    expect(res.truncated).toBe(false);
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
