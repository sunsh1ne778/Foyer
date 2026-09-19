import { describe, expect, it } from 'vitest';
import { usagePercent } from './capacity';

describe('usagePercent', () => {
  it('computes a clamped percentage', () => {
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(0, 100)).toBe(0);
    expect(usagePercent(150, 100)).toBe(100);
  });

  it('returns 0 when capacity is unknown, never a fake floor', () => {
    // 旧实现是 Math.max(pct, 4)，把 0 也画成 4% —— 这正是「假的」。
    expect(usagePercent(12345, 0)).toBe(0);
    expect(usagePercent(12345, -1)).toBe(0);
    expect(usagePercent(12345, Number.NaN)).toBe(0);
  });
});
