/**
 * VERIFY-08 — EDIT_STAT 周看板聚合
 *
 * 覆盖点:
 *   1. 只认 tag=EDIT_STAT 的行, 其它埋点 (COMPACT_STAT 等) 不污染分子分母
 *   2. 成功/失败计数与成功率 (含 already_done 算成功)
 *   3. 失败按分诊类型拆分, 降序
 *   4. 按自然周分桶 (周一为界), 跨年 ISO 周号正确
 *   5. --weeks 窗口裁剪
 *   6. 解析不了的行只进 badLines
 *   7. 单行摘要的达标判定 (≥98%)
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateEditStatsByWeek,
  formatEditStatLine,
  parseEditStatLine,
  parseEditStatLog,
  weekKeyOf,
  weekStartOf,
  EDIT_SUCCESS_TARGET_PCT,
} from '../editStatWeekly.js';

function line(ts: string, tag: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, level: 'info', tag, pid: 1, message, ...extra });
}

describe('VERIFY-08 EDIT_STAT 周看板', () => {
  it('只认 EDIT_STAT, 其它埋点忽略', () => {
    const text = [
      line('2026-10-14T10:00:00.000Z', 'EDIT_STAT', 'edit ok: 2 replacement(s)'),
      line('2026-10-14T10:01:00.000Z', 'COMPACT_STAT', 'compact ok'),
      line('2026-10-14T10:02:00.000Z', 'EDIT_STAT', 'edit failed: string_not_found'),
      'not json at all',
    ].join('\n');
    const { records } = parseEditStatLog(text);
    expect(records).toHaveLength(2);
    expect(records[0].ok).toBe(true);
    expect(records[1]).toMatchObject({ ok: false, errorCode: 'string_not_found' });
  });

  it('成功率与失败分诊拆分 (already_done 算成功)', () => {
    const records = [
      { ts: Date.parse('2026-10-14T10:00:00Z'), ok: true },
      { ts: Date.parse('2026-10-14T10:01:00Z'), ok: true, recovered: true },
      { ts: Date.parse('2026-10-14T10:02:00Z'), ok: false, errorCode: 'unread' },
      { ts: Date.parse('2026-10-14T10:03:00Z'), ok: false, errorCode: 'unread' },
      { ts: Date.parse('2026-10-14T10:04:00Z'), ok: false, errorCode: 'stale' },
    ];
    const report = aggregateEditStatsByWeek(records, { now: Date.parse('2026-10-15T00:00:00Z') });
    expect(report.overall.total).toBe(5);
    expect(report.overall.ok).toBe(2);
    expect(report.overall.failed).toBe(3);
    expect(report.overall.successRate).toBe(40);
    expect(report.overall.recovered).toBe(1);
    expect(report.overall.failuresByCode).toEqual([
      { code: 'unread', count: 2 },
      { code: 'stale', count: 1 },
    ]);
  });

  it('按自然周分桶 (周一为界), 最新周在前', () => {
    const records = [
      { ts: new Date(2026, 9, 5, 9).getTime(), ok: true },    // 上一周的周一
      { ts: new Date(2026, 9, 14, 9).getTime(), ok: false, errorCode: 'stale' }, // 本周三
    ];
    const report = aggregateEditStatsByWeek(records, { now: new Date(2026, 9, 18, 12).getTime() });
    expect(report.weeks).toHaveLength(2);
    expect(report.weeks[0].weekStartMs).toBeGreaterThan(report.weeks[1].weekStartMs);
    expect(report.weeks[0].total).toBe(1);
    expect(report.weeks[1].total).toBe(1);
  });

  it('周日归上一周 (周一 00:00 起点)', () => {
    const sunday = new Date(2026, 9, 18, 23, 0).getTime();
    const monday = new Date(2026, 9, 12, 0, 0).getTime();
    expect(weekStartOf(sunday)).toBe(monday);
  });

  it('ISO 周号: 跨年周归属正确', () => {
    expect(weekKeyOf(new Date(2026, 11, 31, 12).getTime())).toBe('2026-W53');
    expect(weekKeyOf(new Date(2027, 0, 1, 12).getTime())).toBe('2026-W53');
  });

  it('--weeks 只保留最近 N 周', () => {
    const records = [
      { ts: new Date(2026, 8, 1, 12).getTime(), ok: true },    // 很早
      { ts: new Date(2026, 9, 14, 12).getTime(), ok: true },   // 本周附近
    ];
    const report = aggregateEditStatsByWeek(records, {
      weeks: 2,
      now: new Date(2026, 9, 15, 12).getTime(),
    });
    expect(report.weeks).toHaveLength(1);
    expect(report.overall.total).toBe(1);
  });

  it('解析不了的行只计 badLines, 不进分母', () => {
    const text = [
      line('2026-10-14T10:00:00.000Z', 'EDIT_STAT', 'edit ok: 1 replacement(s)'),
      line('2026-10-14T10:01:00.000Z', 'EDIT_STAT', 'something we do not understand'),
    ].join('\n');
    const { records, badLines } = parseEditStatLog(text);
    expect(records).toHaveLength(1);
    expect(badLines).toBe(1);
    const report = aggregateEditStatsByWeek(records, { badLines, now: Date.parse('2026-10-15T00:00:00Z') });
    expect(report.overall.total).toBe(1);
    expect(report.badLines).toBe(1);
  });

  it('单行摘要按 98% 达标判定', () => {
    expect(EDIT_SUCCESS_TARGET_PCT).toBe(98);
    const pass = formatEditStatLine({
      key: '2026-W42', weekStartMs: 0, total: 100, ok: 99, failed: 1,
      successRate: 99, failuresByCode: [], recovered: 2,
    });
    expect(pass).toContain('99%');
    expect(pass).toContain('✅');
    expect(pass).toContain('容错 2');

    const fail = formatEditStatLine({
      key: '2026-W42', weekStartMs: 0, total: 100, ok: 90, failed: 10,
      successRate: 90, failuresByCode: [], recovered: 0,
    });
    expect(fail).toContain('⚠️');

    expect(formatEditStatLine(null)).toBe('');
  });

  it('ts 坏掉的行被丢弃 (不猜时间)', () => {
    expect(parseEditStatLine(JSON.stringify({ tag: 'EDIT_STAT', message: 'edit ok: 1' }))).toBeNull();
    expect(parseEditStatLine(JSON.stringify({ ts: 'not-a-date', tag: 'EDIT_STAT', message: 'edit ok: 1' }))).toBeNull();
  });
});
