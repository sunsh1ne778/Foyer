import { describe, expect, it } from 'vitest';
import { hostPathSegments } from './hostPath';

describe('hostPathSegments', () => {
  it('returns nothing for the drive-list level', () => {
    expect(hostPathSegments('')).toEqual([]);
    expect(hostPathSegments('   ')).toEqual([]);
  });

  it('makes the drive root the first clickable crumb', () => {
    expect(hostPathSegments('G:\\')).toEqual([{ label: 'G:\\', value: 'G:\\' }]);
  });

  it('accumulates each level and keeps # verbatim', () => {
    expect(hostPathSegments('G:\\20260619\\#整理完成')).toEqual([
      { label: 'G:\\', value: 'G:\\' },
      { label: '20260619', value: 'G:\\20260619' },
      { label: '#整理完成', value: 'G:\\20260619\\#整理完成' },
    ]);
  });

  it('ignores a trailing separator (round-trips to the same values)', () => {
    expect(hostPathSegments('G:\\20260619\\')).toEqual([
      { label: 'G:\\', value: 'G:\\' },
      { label: '20260619', value: 'G:\\20260619' },
    ]);
  });

  it('accumulates paths deeper than two levels', () => {
    expect(hostPathSegments('G:\\20260619\\#整理完成\\sub')).toEqual([
      { label: 'G:\\', value: 'G:\\' },
      { label: '20260619', value: 'G:\\20260619' },
      { label: '#整理完成', value: 'G:\\20260619\\#整理完成' },
      { label: 'sub', value: 'G:\\20260619\\#整理完成\\sub' },
    ]);
  });

  it('tolerates spaces in segment names', () => {
    const got = hostPathSegments('C:\\Program Files\\a');
    expect(got[1]).toEqual({ label: 'Program Files', value: 'C:\\Program Files' });
  });

  it('does not treat a non-drive path as a host path', () => {
    expect(hostPathSegments('/mnt/g/x')).toEqual([]);
  });
});
