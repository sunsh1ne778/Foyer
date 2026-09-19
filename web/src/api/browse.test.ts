import { afterEach, describe, expect, it, vi } from 'vitest';
import { foyerBrowse } from './jfs';

function stubFetch(payload: unknown, ok = true): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    return {
      ok,
      status: ok ? 200 : 400,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('foyerBrowse', () => {
  it('percent-encodes # so it cannot be read as a fragment', async () => {
    const calls = stubFetch({ ok: true, path: 'G:\\20260619\\#整理完成', entries: [] });
    await foyerBrowse('G:\\20260619\\#整理完成');
    expect(calls[0]).toContain('%23');
    expect(calls[0]).not.toContain('#');
  });

  it('omits the query entirely for the drive-list level', async () => {
    const calls = stubFetch({ ok: true, drives: ['C:\\'] });
    await foyerBrowse();
    expect(calls[0]).toBe('/foyer/browse');
  });

  it('defaults missing collections instead of throwing', async () => {
    stubFetch({ ok: true });
    const res = await foyerBrowse('');
    expect(res.entries).toEqual([]);
    expect(res.drives).toEqual([]);
    expect(res.path).toBe('');
    expect(res.parent).toBe('');
  });

  it('surfaces the server message on failure', async () => {
    stubFetch('path is outside the allowed root', false);
    await expect(foyerBrowse('/etc')).rejects.toThrow(/outside the allowed root/);
  });
});
