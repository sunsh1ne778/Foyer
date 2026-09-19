import { describe, expect, it } from 'vitest';
import { SEARCH_PAGE_SIZE, attributeMatches, matchesDest, mountRoot, pageSlice, parentKey } from './search';
import type { ApiMount } from './client';
import type { FoyerSearchMatch } from './jfs';

const volume: ApiMount = { id: 'foyer', name: 'foyer', type: 's3' };
const photos: ApiMount = {
  id: 'photos',
  name: 'photos',
  type: 'local',
  spec: { dest: '/av_20260619', mode: 'metadata' },
};
const probe: ApiMount = {
  id: 'probe',
  name: 'probe',
  type: 'local',
  spec: { dest: '/av', mode: 'metadata' },
};

function hit(path: string, name = path.split('/').pop() || '', type = 'file'): FoyerSearchMatch {
  return { path, name, type, size: 1, mtime: 0, mtimensec: 0 };
}

describe('mountRoot', () => {
  it('treats the gateway volume as the volume root, not /foyer', () => {
    // 卷挂载的 spec 里没有 dest，直接套 mountVolumePath 会得到 /foyer（错误）。
    expect(mountRoot(volume)).toBe('/');
    expect(mountRoot(photos)).toBe('/av_20260619');
  });

  it('falls back to /name for a mount without dest', () => {
    // 绑成 ApiMount 再传入：字面量会触发多余属性检查（mountRoot 的形参只声明 name/spec）。
    const noDest: ApiMount = { id: 'x', name: 'x', type: 'local' };
    expect(mountRoot(noDest)).toBe('/x');
  });
});

describe('matchesDest', () => {
  it('aligns on segment boundaries so /av never matches /av_20260619', () => {
    expect(matchesDest('/av', '/av')).toBe(true);
    expect(matchesDest('/av/2026', '/av')).toBe(true);
    expect(matchesDest('/av_20260619', '/av')).toBe(false);
    expect(matchesDest('/av_20260619/x', '/av')).toBe(false);
  });

  it('matches everything for the volume root', () => {
    expect(matchesDest('/anything', '/')).toBe(true);
    expect(matchesDest('/', '/')).toBe(true);
  });
});

describe('attributeMatches', () => {
  it('prefers the longest dest so a nested mount wins over the volume', () => {
    const got = attributeMatches([volume, photos], [hit('/av_20260619/raw/a.dng', 'a.dng')]);
    expect(got).toHaveLength(1);
    expect(got[0].mount).toBe('photos');
    expect(got[0].key).toBe('/raw/a.dng');
  });

  it('picks the deeper of two overlapping mounts regardless of list order', () => {
    const nested = attributeMatches([probe, photos], [hit('/av_20260619/raw/a.dng', 'a.dng')]);
    expect(nested[0].mount).toBe('photos');
    expect(nested[0].key).toBe('/raw/a.dng');
  });

  it('attributes the mount root itself to that mount with key /', () => {
    const got = attributeMatches([volume, photos], [hit('/av_20260619', 'av_20260619', 'directory')]);
    expect(got[0].mount).toBe('photos');
    expect(got[0].key).toBe('/');
    expect(got[0].isDir).toBe(true);
  });

  it('falls back to the volume mount for paths outside every dest', () => {
    const got = attributeMatches([volume, photos], [hit('/capacity-gate-probe.txt')]);
    expect(got[0].mount).toBe('foyer');
    expect(got[0].key).toBe('/capacity-gate-probe.txt');
  });

  it('converts mtime seconds plus nanoseconds to ISO', () => {
    const got = attributeMatches([volume], [{ ...hit('/a.txt'), mtime: 1777690800, mtimensec: 500000000 }]);
    expect(got[0].mtime).toBe(new Date(1777690800 * 1000 + 500).toISOString());
  });

  it('skips malformed entries instead of emitting a bogus hit', () => {
    const got = attributeMatches([volume], [
      { path: '', name: 'x', type: 'file', size: 0, mtime: 0, mtimensec: 0 },
      hit('/ok.txt'),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].key).toBe('/ok.txt');
  });
});

describe('parentKey', () => {
  it('walks up one level and clamps at the mount root', () => {
    expect(parentKey('/a/b/c')).toBe('/a/b');
    expect(parentKey('/a')).toBe('/');
    expect(parentKey('/')).toBe('/');
    expect(parentKey('a/b')).toBe('/a');
  });
});

describe('pageSlice', () => {
  const items = Array.from({ length: 250 }, (_, i) => i);

  it('slices pages of the default size', () => {
    const first = pageSlice(items, 1);
    expect(first.items).toHaveLength(SEARCH_PAGE_SIZE);
    expect(first.items[0]).toBe(0);
    expect(first.totalPages).toBe(3);
  });

  it('returns the tail on the last page', () => {
    const last = pageSlice(items, 3);
    expect(last.page).toBe(3);
    expect(last.items).toHaveLength(50);
    expect(last.items[49]).toBe(249);
  });

  it('clamps out-of-range pages instead of returning nothing', () => {
    expect(pageSlice(items, 99).page).toBe(3);
    expect(pageSlice(items, 0).page).toBe(1);
    expect(pageSlice(items, -5).page).toBe(1);
    expect(pageSlice(items, Number.NaN).page).toBe(1);
  });

  it('always reports at least one page so the UI has a sane counter', () => {
    expect(pageSlice([], 1)).toEqual({ items: [], page: 1, totalPages: 1 });
  });
});
