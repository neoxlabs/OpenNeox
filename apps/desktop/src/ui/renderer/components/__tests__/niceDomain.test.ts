import { describe, expect, test } from 'vitest';
import { niceDomain } from '../NeoxCards';

describe('niceDomain', () => {
  test('实拍数据 169~240: 定义域贴着数据, 不从 0 起', () => {
    const [lo, hi] = niceDomain([212, 198, 240, 187, 176, 181, 169]);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThanOrEqual(169);
    expect(hi).toBeGreaterThanOrEqual(240);
    /* 数据至少占据定义域的一半, 否则又是一条贴边的线 */
    expect((240 - 169) / (hi - lo)).toBeGreaterThan(0.5);
  });
  test('数据本来就跨到接近 0 (波动 ≥ 60%) → 零基线', () => {
    expect(niceDomain([2, 50, 100])[0]).toBe(0);
  });
  test('有负数 / 有 0 → 零基线', () => {
    expect(niceDomain([0, 30, 60])[0]).toBe(0);
    expect(niceDomain([-5, 30])[0]).toBe(-5);
  });
  test('全相等也给出非空定义域', () => {
    const [lo, hi] = niceDomain([50, 50, 50]);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeLessThanOrEqual(50);
    expect(hi).toBeGreaterThanOrEqual(50);
  });
});
