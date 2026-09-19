import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliApi } from './run';

function fakeApi(overrides: Partial<CliApi> = {}): CliApi {
  return {
    listFiles: vi.fn(),
    statFile: vi.fn(),
    mkdir: vi.fn(),
    deletePath: vi.fn(),
    copyPath: vi.fn(),
    movePath: vi.fn(),
    getJob: vi.fn(),
    listMounts: vi.fn(),
    createMount: vi.fn(),
    deleteMount: vi.fn(),
    probeMount: vi.fn(),
    unmount: vi.fn(),
    remount: vi.fn(),
    ...overrides,
  };
}

describe('runCli', () => {
  it('aliases mount list to mount ls and does not hit fs', async () => {
    const api = fakeApi({
      listMounts: vi.fn(async () => ({ mounts: [{ id: '1', name: 'photos', type: 's3', status: 'active' }] })),
    });
    const out = await runCli('mount list', api);
    expect(api.listMounts).toHaveBeenCalledOnce();
    expect(out.kind).toBe('ok');
    expect(out.text).toContain('photos');
  });

  it('does not call API for put/get', async () => {
    const api = fakeApi();
    const put = await runCli('put ./a photos:/a', api);
    const get = await runCli('get photos:/a ./a', api);
    expect(put.kind).toBe('unsupported');
    expect(get.kind).toBe('unsupported');
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(api.mkdir).not.toHaveBeenCalled();
  });

  it('returns usage when ls has no ref', async () => {
    const api = fakeApi();
    const out = await runCli('ls', api);
    expect(out.kind).toBe('usage');
    expect(out.text).toMatch(/usage:/);
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('maps ls to listFiles and formats a table', async () => {
    const api = fakeApi({
      listFiles: vi.fn(async () => ({
        entries: [
          { name: '2026', key: '/2026', is_dir: true, mtime: '2026-03-16T14:30:00Z' },
          { name: 'a.png', key: '/a.png', is_dir: false, size: 1024, etag: 'abc', mtime: '2026-03-15T09:12:00Z' },
        ],
      })),
    });
    const out = await runCli('ls photos:/', api);
    expect(api.listFiles).toHaveBeenCalledWith('photos:/');
    expect(out.kind).toBe('ok');
    expect(out.text).toContain('NAME');
    expect(out.text).toContain('2026/');
    expect(out.text).toContain('a.png');
  });

  it('--json dumps list payload', async () => {
    const payload = { entries: [] };
    const api = fakeApi({ listFiles: vi.fn(async () => payload) });
    const out = await runCli('filestore ls --json photos:/', api);
    expect(out.text).toBe(JSON.stringify(payload, null, 2));
  });
});
