import { describe, expect, it, vi } from 'vitest';

// 只替换 listPrefix，其余（refToKey / joinRef / foyerStat / dirMtimesFromStats）用真实实现，
// 这样 volumeKey 的换算仍走线上逻辑。jfs.ts 的 S3Client 是惰性创建的，导入它无副作用。
const { listPrefix } = vi.hoisted(() => ({ listPrefix: vi.fn(async () => []) }));

vi.mock('../api/jfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/jfs')>();
  // 只替换 listPrefix；类型按真实签名标注，否则 `unknown[]` 展开会被 tsc 拒收
  // （TS2556）。运行时仍是同一个 spy，调用记录不变。
  return { ...actual, listPrefix: listPrefix as unknown as typeof actual.listPrefix };
});

import { liveWalkDeps } from './live';

describe('liveWalkDeps list wiring', () => {
  it('lists without asking for directory mtimes', async () => {
    await liveWalkDeps('photos').list('/2026');
    // 报表路径必须跳过 attachDirMtimes：walk 自己会分批 stat 全部目录。
    expect(listPrefix).toHaveBeenCalledWith('photos/2026', { withDirMtimes: false });
  });
});
