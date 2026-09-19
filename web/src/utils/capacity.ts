/**
 * 已用 ÷ 容量的整数百分比。
 *
 * 容量未知（0/负数/NaN）时返回 0，且调用方应据此**不画**进度条：旧实现用
 * `Math.max(pct, 4)` 给 0 也画 4%，再加上硬编码的 2TB 分母，整条进度条都是假的。
 */
export function usagePercent(usedBytes: number, capacityBytes: number): number {
  if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) return 0;
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 0;
  return Math.min(100, Math.round((usedBytes / capacityBytes) * 100));
}
