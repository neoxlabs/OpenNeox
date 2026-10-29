import { describe, it, expect } from 'vitest';
import { classifyQuotaError } from '../services/quotaBridge.js';

/** modal 认识的全部 reason —— 跟 renderer/billing/quotaEvents.ts 对齐 */
const RENDERER_REASONS = new Set(['window5h', 'windowWeekly', 'plan', 'unknown']);

describe('quotaBridge.classifyQuotaError 只能产出 renderer 认识的 reason', () => {
  const cases = [
    [402, 'points_insufficient'],
    [402, '积分不足, 请充值'],
    [402, 'quota_exceeded'],
    [402, '本月额度已用尽'],
    [402, '5 小时窗口额度已用尽'],
    [402, '本周额度已用尽'],
    [402, 'quota.window.5h_exhausted'],
    [402, 'quota.window.weekly_exhausted'],
    [403, 'model_denied'],
    [402, ''],
    [402, undefined],
  ] as const;

  for (const [status, msg] of cases) {
    it(`status=${status} msg=${JSON.stringify(msg)} 产出的 reason 必须在 modal 表里`, () => {
      const r = classifyQuotaError(status, msg as string | undefined);
      if (r === null) return; /* null = 不是额度错误, 合法 */
      expect(RENDERER_REASONS.has(r), `产出了 modal 不认识的 reason: ${r}`).toBe(true);
    });
  }

  it('窗口种类判得出来就给准的, 不要一律 unknown', () => {
    expect(classifyQuotaError(402, 'quota.window.5h_exhausted')).toBe('window5h');
    expect(classifyQuotaError(402, '本周额度已用尽')).toBe('windowWeekly');
  });

  it('模型不在套餐内仍归 plan', () => {
    expect(classifyQuotaError(403, 'model_denied')).toBe('plan');
  });

  it('不是额度错误的返 null, 不误报', () => {
    expect(classifyQuotaError(500, 'internal error')).toBeNull();
    expect(classifyQuotaError(undefined, undefined)).toBeNull();
  });
});
