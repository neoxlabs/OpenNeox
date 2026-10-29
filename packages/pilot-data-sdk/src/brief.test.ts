import { describe, expect, it } from 'vitest';
import {
  BRIEF_DEFAULT_TIME,
  BRIEF_MAX_ITEMS,
  briefDue,
  briefEnabled,
  briefOnTime,
  briefTimeOf,
  nextBriefAt,
} from './brief.js';
import { composeBrief } from './triggers.js';
import type { Insight } from './insights.js';

const ins = (id: string, tone: Insight['tone'], score: number, action = false): Insight =>
  ({ id, domain: 'money', tone, score, title: id, detail: '', ...(action ? { action: { kind: 'ask', label: 'x', prompt: 'y' } } : {}) });

describe('早报 (pilot:P-01): 8:00 ±5 分钟, ≤3 件', () => {
  it('默认 08:00; 写坏退回 08:00; 可改', () => {
    expect(BRIEF_DEFAULT_TIME).toBe('08:00');
    expect(BRIEF_MAX_ITEMS).toBe(3);
    expect(briefTimeOf({})).toBe('08:00');
    expect(briefTimeOf({ 'pilot.brief_time': '25:00' })).toBe('08:00');
    expect(briefTimeOf({ 'pilot.brief_time': '07:45' })).toBe('07:45');
  });

  it('开关: 只有 off 才关', () => {
    expect(briefEnabled({})).toBe(true);
    expect(briefEnabled({ 'pilot.brief': 'on' })).toBe(true);
    expect(briefEnabled({ 'pilot.brief': 'off' })).toBe(false);
  });

  it('到点才发; 当天发过不再发; 关掉不发', () => {
    const facts = {};
    const day = '2026-10-18';
    expect(briefDue({ facts, now: { day, time: '07:59' } })).toBe(false);
    expect(briefDue({ facts, now: { day, time: '08:00' } })).toBe(true);
    expect(briefDue({ facts, now: { day, time: '08:05' } })).toBe(true);
    expect(briefDue({ facts, now: { day, time: '11:00' } })).toBe(true);
    expect(briefDue({ facts, now: { day, time: '11:01' } })).toBe(false); // 错过 >3 小时不补发
    expect(briefDue({ facts, now: { day, time: '08:00' }, lastSentDay: day })).toBe(false);
    expect(briefDue({ facts, now: { day, time: '08:00' }, lastSentDay: '2026-10-17' })).toBe(true);
    expect(briefDue({ facts: { 'pilot.brief': 'off' }, now: { day, time: '08:00' } })).toBe(false);
  });

  it('准点口径 ±5 分钟', () => {
    const facts = {};
    expect(briefOnTime(facts, '08:00')).toBe(true);
    expect(briefOnTime(facts, '08:05')).toBe(true);
    expect(briefOnTime(facts, '07:55')).toBe(true);
    expect(briefOnTime(facts, '08:06')).toBe(false);
    expect(briefOnTime(facts, '07:54')).toBe(false);
    expect(briefOnTime({ 'pilot.brief_time': '07:45' }, '07:47')).toBe(true);
  });

  it('连续 7 天: 每天 8:00 那个整点该发, 且到点都在窗口内', () => {
    for (let i = 0; i < 7; i++) {
      const day = `2026-10-${String(18 + i).padStart(2, '0')}`;
      expect(briefDue({ facts: {}, now: { day, time: '08:00' } })).toBe(true);
      expect(briefOnTime({}, '08:00')).toBe(true);
    }
  });

  it('内容封顶三件, 今天的事在前, 重复的不占位', () => {
    const many = Array.from({ length: 8 }, (_, i) => ins(`x${i}`, 'watch', 0.9 - i * 0.05));
    const b = composeBrief({ today: ['a', 'b'], deferred: ['b', 'c'], insights: many });
    expect(b?.items).toHaveLength(3);
    expect(b?.items).toEqual(['a', 'b', 'c']);
    expect(b?.title).toBe('早上好 · 今天 3 件事');
    /* 今天的事本身就超过三件: 仍然只发三件 */
    const crowd = composeBrief({ today: ['一', '二', '三', '四', '五'], deferred: [], insights: [] });
    expect(crowd?.items).toEqual(['一', '二', '三']);
  });

  it('下一次排期: 过点算明天', () => {
    expect(nextBriefAt({ facts: {}, now: { day: '2026-10-18', time: '07:00' } })).toBe('2026-10-18 08:00');
    expect(nextBriefAt({ facts: {}, now: { day: '2026-10-18', time: '08:00' } })).toBe('2026-10-19 08:00');
    expect(nextBriefAt({ facts: { 'pilot.brief': 'off' }, now: { day: '2026-10-18', time: '07:00' } })).toBeNull();
  });
});
