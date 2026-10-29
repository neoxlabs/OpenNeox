import { describe, expect, it } from 'vitest';
import {
  READ_LIKE_BUDGET_MAX_CHARS,
  READ_LIKE_BUDGET_MIN_CHARS,
  readLikeBudgetChars,
} from '../toolOutputBudget.js';

describe('readLikeBudgetChars', () => {
  it('窗口未知 / 非法 → 保底 12,000 (改动前的老行为)', () => {
    expect(readLikeBudgetChars(undefined)).toBe(READ_LIKE_BUDGET_MIN_CHARS);
    expect(readLikeBudgetChars(0)).toBe(READ_LIKE_BUDGET_MIN_CHARS);
    expect(readLikeBudgetChars(-1)).toBe(READ_LIKE_BUDGET_MIN_CHARS);
    expect(readLikeBudgetChars(Number.NaN)).toBe(READ_LIKE_BUDGET_MIN_CHARS);
  });

  it('小窗口 (32K / 128K) 落保底, 不比现状少', () => {
    expect(readLikeBudgetChars(32_000)).toBe(12_000);
    expect(readLikeBudgetChars(128_000)).toBe(12_000);
  });

  it('200K → 15,000 字符', () => {
    expect(readLikeBudgetChars(200_000)).toBe(15_000);
  });

  it('1M 窗口封顶 60,000 字符', () => {
    expect(readLikeBudgetChars(1_000_000)).toBe(READ_LIKE_BUDGET_MAX_CHARS);
    expect(readLikeBudgetChars(2_000_000)).toBe(READ_LIKE_BUDGET_MAX_CHARS);
  });

  it('预算随窗口单调不减', () => {
    const windows = [16_000, 32_000, 128_000, 160_000, 200_000, 400_000, 1_000_000];
    const budgets = windows.map((w) => readLikeBudgetChars(w));
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
  });
});
