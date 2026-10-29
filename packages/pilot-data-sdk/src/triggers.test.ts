import { describe, expect, it } from 'vitest';
import { birthdayTriggers, composeBrief, dueOccurrences, inQuietHours, isoWeekday, localParts, triggerSpecOf } from './triggers.js';
import type { Insight } from './insights.js';

describe('触发引擎 · 纯函数', () => {
  const anniversary = triggerSpecOf('t1', { when: 'yearly', date: '10-20', text: '恋爱纪念日', leadDays: 10, time: '09:00' })!;
  const sundayCall = triggerSpecOf('t2', { when: 'weekly', weekday: 7, time: '20:00', text: '给爸妈打电话' })!;

  it('每年: 提前那天响「还有 N 天」, 正日子响原话; 没到钟点不响', () => {
    expect(dueOccurrences([anniversary], { day: '2026-10-10', time: '08:59' })).toEqual([]);
    const lead = dueOccurrences([anniversary], { day: '2026-10-10', time: '09:00' });
    expect(lead).toEqual([{ key: 't1|2026-10-10|lead', triggerId: 't1', phase: 'lead', text: '还有 10 天：恋爱纪念日' }]);
    expect(dueOccurrences([anniversary], { day: '2026-10-20', time: '21:00' })[0]).toMatchObject({ phase: 'day', text: '恋爱纪念日' });
    expect(dueOccurrences([anniversary], { day: '2026-10-15', time: '12:00' })).toEqual([]);
  });

  it('每周: 只在那个周几的钟点之后', () => {
    expect(isoWeekday('2026-10-11')).toBe(7);
    expect(dueOccurrences([sundayCall], { day: '2026-10-11', time: '19:59' })).toEqual([]);
    expect(dueOccurrences([sundayCall], { day: '2026-10-11', time: '20:05' })[0].key).toBe('t2|2026-10-11|day');
    expect(dueOccurrences([sundayCall], { day: '2026-10-12', time: '20:05' })).toEqual([]);
  });

  it('地点 / 人类的不归引擎; 档案生日自动变每年触发', () => {
    expect(triggerSpecOf('x', { when: 'place', place: '公司', text: '拿快递' })).toBeNull();
    /* 「自动化」页暂停了的不响 */
    expect(triggerSpecOf('p', { when: 'weekly', weekday: 7, time: '20:00', text: '给爸妈打电话', paused: true })).toBeNull();
    const b = birthdayTriggers({ 'person.妈妈.birthday': '10-14', 'person.妈妈.likes': '桂花糕', 'me.birthday': '1990-03-02' });
    expect(b).toHaveLength(1);
    expect(dueOccurrences(b, { day: '2026-10-11', time: '09:30' })[0].text).toBe('还有 3 天：妈妈生日');
  });

  it('本地时间按时区切; 免打扰 22:30 ~ 7:30', () => {
    expect(localParts(Date.UTC(2026, 9, 11, 16, 30), 'Asia/Shanghai')).toEqual({ day: '2026-10-12', time: '00:30' });
    expect(inQuietHours('23:00')).toBe(true);
    expect(inQuietHours('07:29')).toBe(true);
    expect(inQuietHours('07:30')).toBe(false);
  });

  it('简报: 夜里攒的在前, 洞察里要留神的优先, 「知道一下」又没动作的不进; 没事返回 null', () => {
    const ins = (id: string, tone: Insight['tone'], score: number, action = false): Insight =>
      ({ id, domain: 'money', tone, score, title: id, detail: '', ...(action ? { action: { kind: 'ask', label: 'x', prompt: 'y' } } : {}) });
    const b = composeBrief({ today: [], deferred: ['给爸妈打电话'], insights: [ins('info-noact', 'info', 0.99), ins('花得快', 'watch', 0.6), ins('妈妈生日', 'info', 0.9, true), ins('多余', 'watch', 0.1)] });
    expect(b).toEqual({ title: '早上好 · 今天 3 件事', body: '给爸妈打电话；妈妈生日；花得快', items: ['给爸妈打电话', '妈妈生日', '花得快'] });
    expect(composeBrief({ today: [], deferred: [], insights: [ins('a', 'info', 0.5)] })).toBeNull();
  });
});
