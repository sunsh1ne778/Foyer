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
