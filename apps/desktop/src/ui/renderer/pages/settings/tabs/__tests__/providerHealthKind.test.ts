import { describe, it, expect } from 'vitest';
import { resolveHealthKind } from '../ProvidersTab';

describe('resolveHealthKind', () => {
  it('没测过 (缺席) = 未检测, 不是 offline', () => {
    expect(resolveHealthKind(undefined)).toBe('idle');
  });

  it('卡片与统计对「缺席」给出同一结论', () => {
    const healthMap: Record<string, { current?: string }> = {};
    const card = resolveHealthKind(healthMap['claude']?.current, { skipped: false });
    const stat = resolveHealthKind(healthMap['claude']?.current);
    expect(card).toBe(stat);
    expect(card).toBe('idle');
  });

  it('真 offline / error 仍然是 err', () => {
    expect(resolveHealthKind('offline')).toBe('err');
    expect(resolveHealthKind('error')).toBe('err');
  });

  it('慢 = slow (可用), 不是告警', () => {
    expect(resolveHealthKind('poor')).toBe('slow');
  });

  it('excellent / good = ok', () => {
    expect(resolveHealthKind('excellent')).toBe('ok');
    expect(resolveHealthKind('good')).toBe('ok');
  });

  it('标记「不测速」的服务商一律 idle, 即便有旧的 error 残留', () => {
    expect(resolveHealthKind('error', { skipped: true })).toBe('idle');
    expect(resolveHealthKind('excellent', { skipped: true })).toBe('idle');
  });
});
