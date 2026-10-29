import { describe, it, expect } from 'vitest';
import {
  toDayKey, parseDayKey, daysBetween, presetRange, customRange, sliceToRange, MAX_RANGE_DAYS,
} from './usageRange';

describe('toDayKey', () => {
  it('取本地日期分量 —— 用 toISOString 会让东八区的 00:30 变成前一天', () => {
    /* 不跟 toISOString() 对比断言: 那个结果取决于**跑测试的机器时区**,
       在 UTC 上跑两者相同, 断言就会随环境闪烁。这里只钉住契约本身:
       给定本地时刻, 输出必须等于该时刻的本地年月日。 */
    for (const d of [
      new Date(2026, 7, 10, 0, 30, 0),    /* 本地凌晨 —— UTC 可能还在前一天 */
      new Date(2026, 7, 10, 23, 30, 0),   /* 本地深夜 —— UTC 可能已到后一天 */
    ]) {
      const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      expect(toDayKey(d)).toBe(expected);
      expect(toDayKey(d)).toBe('2026-08-10');
    }
  });

  it('月/日补零', () => {
    expect(toDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('daysBetween 是闭区间', () => {
  it('同一天 = 1 天', () => {
    expect(daysBetween('2026-07-01', '2026-07-01')).toBe(1);
  });
  it('跨月正确', () => {
    expect(daysBetween('2026-07-30', '2026-08-02')).toBe(4);
  });
  it('脏输入不炸', () => {
    expect(daysBetween('bad', '2026-08-02')).toBe(1);
  });
});

describe('presetRange', () => {
  it('7d 是含今天的 7 天', () => {
    const r = presetRange('7d');
    expect(r.days).toBe(7);
    expect(daysBetween(r.startDay, r.endDay)).toBe(7);
    expect(r.endDay).toBe(toDayKey(new Date()));
  });
  it('30d 同理', () => {
    const r = presetRange('30d');
    expect(r.days).toBe(30);
    expect(daysBetween(r.startDay, r.endDay)).toBe(30);
  });
});

describe('customRange 的三个防呆', () => {
  it('填反了自动正过来', () => {
    const r = customRange('2026-08-05', '2026-08-01')!;
    expect(r.startDay).toBe('2026-08-01');
    expect(r.endDay).toBe('2026-08-05');
    expect(r.days).toBe(5);
  });

  it('结束日夹到今天 —— 未来没有数据, 选了只会看到一段空白', () => {
    const future = toDayKey(new Date(Date.now() + 30 * 86_400_000));
    const r = customRange('2026-01-01', future)!;
    expect(r.endDay).toBe(toDayKey(new Date()));
  });

  it(`超长区间收到 ${MAX_RANGE_DAYS} 天以内`, () => {
    const r = customRange('2000-01-01', toDayKey(new Date()))!;
    expect(r.days).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });

  it('非法日期返回 null 而不是编一个区间出来', () => {
    expect(customRange('', '2026-08-01')).toBeNull();
    expect(customRange('2026-8-1', '2026-08-01')).toBeNull();   /* 必须补零格式 */
  });
});

describe('sliceToRange 补齐缺失的天', () => {
  const mk = (day: string) => ({ day, totalTokens: 0 });

  it('缺的那天补 0, 不能跳过 —— 跳过会让折线假装中间一直在用', () => {
    const rows = [{ day: '2026-08-01', totalTokens: 100 }, { day: '2026-08-04', totalTokens: 400 }];
    const out = sliceToRange(rows, customRange('2026-08-01', '2026-08-04')!, mk);
    expect(out.map(r => r.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
    expect(out.map(r => r.totalTokens)).toEqual([100, 0, 0, 400]);
  });

  it('区间外的行被裁掉', () => {
    const rows = [{ day: '2026-07-01', totalTokens: 999 }, { day: '2026-08-01', totalTokens: 1 }];
    const out = sliceToRange(rows, customRange('2026-08-01', '2026-08-01')!, mk);
    expect(out).toHaveLength(1);
    expect(out[0].totalTokens).toBe(1);
  });
});
