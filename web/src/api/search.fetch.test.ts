import { afterEach, describe, expect, it, vi } from 'vitest';
import { foyerSearch } from './jfs';

/** 记下 fetch 收到的 URL，并回一份最小可用的检索载荷。 */
function stubFetch(body: unknown = { keyword: 'raw', matches: [], scanned: 0, truncated: false }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('foyerSearch', () => {
  it('encodes #, spaces and CJK so the server can read them back', () => {
    const calls = stubFetch();
    return foyerSearch('#整理 完成').then(() => {
      // 手工拼串会把 # 变成 fragment；URLSearchParams 必须把它编成 %23。
      expect(calls[0]).toBe('/foyer/search?q=%23%E6%95%B4%E7%90%86+%E5%AE%8C%E6%88%90');
    });
  });

  it('omits path when blank and adds it when given', async () => {
    const calls = stubFetch();
    await foyerSearch('raw');
    expect(calls[0]).toBe('/foyer/search?q=raw');

    await foyerSearch('raw', '/av_20260619');
    expect(calls[1]).toBe('/foyer/search?q=raw&path=%2Fav_20260619');

    await foyerSearch('raw', '   ');
    expect(calls[2]).toBe('/foyer/search?q=raw');
  });

  it('sends case=1 only when case sensitivity is requested', async () => {
    const calls = stubFetch();
    await foyerSearch('raw', undefined, { caseSensitive: true });
    expect(calls[0]).toContain('case=1');
    await foyerSearch('raw');
    expect(calls[1]).not.toContain('case=');
  });

  it('defaults missing collections instead of returning undefined', async () => {
    stubFetch({ keyword: '', scanned: 3 });
    const res = await foyerSearch('raw');
    expect(res.matches).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.scanned).toBe(3);
    // 关键词以服务端回显为准，缺失时退回请求值。
    expect(res.keyword).toBe('raw');
  });

  it('throws ApiError with the server text on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'q required' }) as unknown as Response)
    );
    await expect(foyerSearch('')).rejects.toThrow(/q required/);
  });
});
