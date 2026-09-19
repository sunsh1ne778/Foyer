import { describe, expect, it } from 'vitest';
import { applyUsage, isMetadataImport, mergeMounts, mountVolumePath, volumeMount } from './mounts';
import type { ApiMount } from './client';
import type { FoyerUsage } from './jfs';

const imported: ApiMount = {
  id: 'photos',
  name: 'photos',
  type: 'local',
  status: 'mounted',
  spec: { root: 'E:\\photos', container: '/mnt/e/photos', dest: '/photos', mode: 'metadata' },
};

describe('mounts merge', () => {
  it('always puts the gateway volume first', () => {
    const list = mergeMounts([imported]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(volumeMount());
    expect(list[0].name).toBe('foyer');
    expect(list[1].name).toBe('photos');
  });

  it('skips entries that shadow the volume mount', () => {
    const list = mergeMounts([{ ...imported, id: 'foyer', name: 'foyer' }, imported]);
    expect(list.map(m => m.name)).toEqual(['foyer', 'photos']);
  });

  it('skips nameless entries', () => {
    const list = mergeMounts([{ id: 'x', name: '', type: 'local' }]);
    expect(list).toHaveLength(1);
  });

  it('defaults type and status', () => {
    const list = mergeMounts([{ id: 'a', name: 'a' }]);
    expect(list[1].type).toBe('local');
    expect(list[1].status).toBe('mounted');
  });
});

describe('isMetadataImport', () => {
  it('detects the metadata import mode', () => {
    expect(isMetadataImport(imported)).toBe(true);
    expect(isMetadataImport({ spec: { mode: 'copy' } })).toBe(false);
    expect(isMetadataImport({})).toBe(false);
    expect(isMetadataImport({ spec: { bucket: 'foyer' } })).toBe(false);
  });
});

// 数值取自真实环境实测：卷逻辑已用 ≈ 1.75 TiB、物理盘 1 TiB。注意 size/length
// 是「字节」原值（DirStats 对齐后的字节数），不是 GiB——这里刻意保留未缩放的
// 数字，断言只做透传相等性。
//
// 载荷里**没有** capacity/capacity_set（Task 8 已删）：进度条改用每条的 disk_*。
// `/host` 那条刻意不带 disk_*，模拟「源盘解析不到」的挂载——它没有池，但有真实
// 的逻辑用量与 inode，是合法且必须与「完全没有 stats」区分开的独立状态。
const usageFixture: FoyerUsage = {
  volume: {
    used: 1919472140288,
    used_inodes: 2538,
    disk_total: 1099511627776,
    disk_used: 16106127360,
    disk_free: 1083405500416,
  },
  summaries: [
    {
      path: '/photos',
      size: 596,
      length: 590,
      files: 800,
      dirs: 22,
      inodes: 822,
      disk_total: 2000381014016,
      disk_used: 921854009344,
      disk_free: 1078527004672,
    },
    // 有逻辑用量、没有池：源盘不在容器里，读不到 disk_*（omitempty 整体缺席）。
    { path: '/host', size: 2433320140800, length: 2433320139000, files: 10, dirs: 3, inodes: 13 },
    {
      path: '/ghost',
      error: 'lookup ghost: no such file or directory',
      size: 0,
      length: 0,
      files: 0,
      dirs: 0,
      inodes: 0,
    },
  ],
};

describe('mountVolumePath', () => {
  it('prefers spec.dest and falls back to /name', () => {
    expect(mountVolumePath({ id: 'a', name: 'a', spec: { dest: '/photos' } })).toBe('/photos');
    expect(mountVolumePath({ id: 'b', name: 'b' })).toBe('/b');
    expect(mountVolumePath({ id: 'c', name: 'c', spec: { dest: '  ' } })).toBe('/c');
  });
});

describe('applyUsage', () => {
  it('carries the mount’s logical size and its backing pool occupancy as separate quantities', () => {
    const list = mergeMounts([{ id: 'photos', name: 'photos', type: 'local', spec: { dest: '/photos' } }]);
    applyUsage(list, usageFixture);

    const photos = list.find(m => m.name === 'photos');
    // total_bytes 是逻辑 size（596），pool_* 是那块盘自己的占用 —— 两者不可混。
    expect(photos?.stats).toEqual({
      total_bytes: 596,
      node_count: 822,
      pool_total_bytes: 2000381014016,
      pool_used_bytes: 921854009344,
      pool_free_bytes: 1078527004672,
    });
  });

  it('gives the volume mount the volume-level numbers and the volume disk pool', () => {
    const list = mergeMounts([]);
    applyUsage(list, usageFixture);

    expect(list[0].stats).toEqual({
      total_bytes: 1919472140288,
      node_count: 2538,
      pool_total_bytes: 1099511627776,
      pool_used_bytes: 16106127360,
      pool_free_bytes: 1083405500416,
    });
  });

  it('keeps logical numbers but sets no pool_* when the pool is unknown (never 0)', () => {
    const list = mergeMounts([{ id: 'host', name: 'host', type: 'local', spec: { dest: '/host' } }]);
    applyUsage(list, usageFixture);

    const host = list.find(m => m.name === 'host');
    // 「有逻辑用量但没有池」是合法状态：数字仍在……
    expect(host?.stats).toEqual({ total_bytes: 2433320140800, node_count: 13 });
    // ……池三项必须缺席（不是 0），否则 UI 会把未知画成 0%。
    expect(host?.stats?.pool_total_bytes).toBeUndefined();
    expect(host?.stats?.pool_used_bytes).toBeUndefined();
    expect(host?.stats?.pool_free_bytes).toBeUndefined();
    // 与「完全没有 stats」区分得开。
    expect(host?.stats).toBeDefined();
  });

  it('leaves stats entirely absent for a mount with no summary at all', () => {
    const list = mergeMounts([{ id: 'nope', name: 'nope', type: 'local', spec: { dest: '/nope' } }]);
    applyUsage(list, usageFixture);
    expect(list.find(m => m.name === 'nope')?.stats).toBeUndefined();
  });

  it('leaves stats absent when the control plane reported an error', () => {
    const list = mergeMounts([{ id: 'ghost', name: 'ghost', type: 'local', spec: { dest: '/ghost' } }]);
    applyUsage(list, usageFixture);
    expect(list.find(m => m.name === 'ghost')?.stats).toBeUndefined();
  });
});
