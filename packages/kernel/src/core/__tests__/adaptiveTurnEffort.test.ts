import { describe, it, expect } from 'vitest';
import { pickAdaptiveTurnEffort } from '../adaptiveTurnEffort.js';

const base = { model: 'deepseek-v4.1-flash', iteration: 5, lastTurnReasoningChars: 300, lastToolRoundFailed: false };

describe('pickAdaptiveTurnEffort', () => {
  it('例行轮次 (上一轮想得短 + 工具全成功) → low', () => {
    expect(pickAdaptiveTurnEffort(base)).toBe('low');
  });
  it('第一轮、工具失败、上一轮长考 → 保持默认档', () => {
    expect(pickAdaptiveTurnEffort({ ...base, iteration: 1 })).toBeUndefined();
    expect(pickAdaptiveTurnEffort({ ...base, lastToolRoundFailed: true })).toBeUndefined();
    expect(pickAdaptiveTurnEffort({ ...base, lastTurnReasoningChars: 6000 })).toBeUndefined();
  });
  it('非 deepseek 家族不动', () => {
    expect(pickAdaptiveTurnEffort({ ...base, model: 'claude-sonnet-5-5' })).toBeUndefined();
  });
});
