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
const usageFixture: FoyerUsage = {
  volume: {
    capacity: 1099511627776,
    capacity_set: false,
    used: 1919472140288,
    used_inodes: 2538,
    disk_total: 1099511627776,
    disk_used: 16106127360,
    disk_free: 1083405500416,
  },
  summaries: [
    { path: '/photos', size: 596, length: 590, files: 800, dirs: 22, inodes: 822 },
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
  it('attaches real bytes and inodes per mount', () => {
    const list = mergeMounts([{ id: 'photos', name: 'photos', type: 'local', spec: { dest: '/photos' } }]);
    applyUsage(list, usageFixture);

    const photos = list.find(m => m.name === 'photos');
    expect(photos?.stats).toEqual({ total_bytes: 596, node_count: 822, capacity_bytes: 1099511627776 });
  });

  it('gives the volume mount the volume-level numbers', () => {
    const list = mergeMounts([]);
    applyUsage(list, usageFixture);

    expect(list[0].stats).toEqual({
      total_bytes: 1919472140288,
      node_count: 2538,
      capacity_bytes: 1099511627776,
    });
  });

  it('leaves stats absent when the control plane reported an error', () => {
    const list = mergeMounts([{ id: 'ghost', name: 'ghost', type: 'local', spec: { dest: '/ghost' } }]);
    applyUsage(list, usageFixture);
    expect(list.find(m => m.name === 'ghost')?.stats).toBeUndefined();
  });
});
