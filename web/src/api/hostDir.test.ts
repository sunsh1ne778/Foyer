import { afterEach, describe, expect, it, vi } from 'vitest';
import { foyerPickHostDir } from './hostDir';

type FetchLike = () => Promise<unknown>;

function stubFetch(impl: FetchLike): void {
  vi.stubGlobal('fetch', impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('foyerPickHostDir', () => {
  it('returns the chosen host path verbatim', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ path: 'G:\\20260619\\#整理完成' }),
    }));

    // 路径必须原样带出来：# 与中文都不能被编码/截断——这正是最初挂载被截成
    // G:\20260619 的那个坑。
    expect(await foyerPickHostDir()).toEqual({
      status: 'picked',
      path: 'G:\\20260619\\#整理完成',
    });
  });

  it('treats an empty path as a cancel, not as unavailable', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ path: '' }) }));

    // 用户自己关掉了框：不能被当成"弹不了"，否则会莫名其妙弹出网页内选择器。
    expect(await foyerPickHostDir()).toEqual({ status: 'cancelled' });
  });

  it('falls back when the endpoint is not served here', async () => {
    stubFetch(async () => ({ ok: false, status: 501, json: async () => ({}) }));
    expect(await foyerPickHostDir()).toEqual({ status: 'unavailable' });
  });

  it('falls back when the request fails outright', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    expect(await foyerPickHostDir()).toEqual({ status: 'unavailable' });
  });

  it('falls back when the body is not the expected JSON shape', async () => {
    // Vite 的 SPA fallback 可能把未知路径兜成 index.html，此时 json() 会抛。
    stubFetch(async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    }));
    expect(await foyerPickHostDir()).toEqual({ status: 'unavailable' });

    stubFetch(async () => ({ ok: true, json: async () => ({ nope: 1 }) }));
    expect(await foyerPickHostDir()).toEqual({ status: 'unavailable' });
  });
});
