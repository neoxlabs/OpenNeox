/**
 * systemReminder 单元测试
 *
 * 覆盖:
 *   - push / peek / consume / remove / clear 基础流程
 *   - oneshot: 消费后即清
 *   - persistent: 多轮重复输出直到 clear
 *   - ttl: 倒数到 0 自动清
 *   - priority: critical 在 consume 输出排前
 *   - formatRemindersForMessage 输出 `<system-reminder>` 标签
 *   - scope 隔离: 不同 scope 互不干扰
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pushSystemReminder,
  peekSystemReminders,
  consumeSystemReminders,
  removeSystemReminderById,
  clearSystemReminders,
  formatRemindersForMessage,
  getReminderDebugInfo,
  __resetSystemRemindersForTests,
} from '../systemReminder.js';

beforeEach(() => {
  __resetSystemRemindersForTests();
});

afterEach(() => {
  __resetSystemRemindersForTests();
});

describe('systemReminder', () => {
  it('push + peek 基础', () => {
    const id = pushSystemReminder('s1', 'hello world');
    expect(id).toBeGreaterThan(0);
    const list = peekSystemReminders('s1');
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('hello world');
    expect(list[0].priority).toBe('normal');
    expect(list[0].oneshot).toBe(false);
  });

  it('空内容 push no-op (返 0, 不入队)', () => {
    const id = pushSystemReminder('s1', '   \n  ');
    expect(id).toBe(0);
    expect(peekSystemReminders('s1')).toHaveLength(0);
  });

  it('content 自动 trim', () => {
    pushSystemReminder('s1', '  inner  ');
    expect(peekSystemReminders('s1')[0].content).toBe('inner');
  });

  it('consume 返回排序副本 + clear oneshot', () => {
    pushSystemReminder('s1', 'first', { oneshot: true });
    pushSystemReminder('s1', 'second');

    const consumed = consumeSystemReminders('s1');
    expect(consumed).toHaveLength(2);
    expect(consumed.map((r) => r.content)).toEqual(['first', 'second']);

    /* second 是 persistent, 应该还在 */
    expect(peekSystemReminders('s1').map((r) => r.content)).toEqual(['second']);
  });

  it('priority critical 在 consume 排前', () => {
    pushSystemReminder('s1', 'normal-1');
    pushSystemReminder('s1', 'critical-1', { priority: 'critical' });
    pushSystemReminder('s1', 'normal-2');
    pushSystemReminder('s1', 'critical-2', { priority: 'critical' });

    const consumed = consumeSystemReminders('s1');
    expect(consumed.map((r) => r.content)).toEqual([
      'critical-1', 'critical-2', 'normal-1', 'normal-2',
    ]);
  });

  it('ttl 倒数: ttl=2 出现 2 次后清', () => {
    pushSystemReminder('s1', 'ttl2', { ttl: 2 });

    expect(consumeSystemReminders('s1')).toHaveLength(1);  // 第 1 次, ttl: 2 → 1
    expect(consumeSystemReminders('s1')).toHaveLength(1);  // 第 2 次, ttl: 1 → 0 (即将清)
    expect(consumeSystemReminders('s1')).toHaveLength(0);  // 第 3 次 — 已清
  });

  it('ttl=1 只出现 1 次', () => {
    pushSystemReminder('s1', 'ttl1', { ttl: 1 });
    expect(consumeSystemReminders('s1')).toHaveLength(1);
    expect(consumeSystemReminders('s1')).toHaveLength(0);
  });

  it('无 ttl 无 oneshot 的 reminder 持续输出', () => {
    pushSystemReminder('s1', 'persistent');
    for (let i = 0; i < 10; i++) {
      expect(consumeSystemReminders('s1')).toHaveLength(1);
    }
  });

  it('scope 隔离: 不同 scope 互不影响', () => {
    pushSystemReminder('A', 'a-only');
    pushSystemReminder('B', 'b-only');

    expect(consumeSystemReminders('A').map((r) => r.content)).toEqual(['a-only']);
    expect(consumeSystemReminders('B').map((r) => r.content)).toEqual(['b-only']);
    expect(consumeSystemReminders('Z')).toEqual([]);
  });

  it('removeSystemReminderById 精确删除', () => {
    const id1 = pushSystemReminder('s1', 'r1');
    pushSystemReminder('s1', 'r2');
    const id3 = pushSystemReminder('s1', 'r3');

    expect(removeSystemReminderById('s1', id1)).toBe(true);
    expect(removeSystemReminderById('s1', 99999)).toBe(false);

    const remaining = peekSystemReminders('s1');
    expect(remaining.map((r) => r.content)).toEqual(['r2', 'r3']);

    /* 删 r3 让 s1 空, scope key 应被删 */
    pushSystemReminder('s2', 'other');
    removeSystemReminderById('s1', id3);
    /* 还剩 r2 */
    expect(peekSystemReminders('s1')).toHaveLength(1);
  });

  it('clearSystemReminders(scope) 清单 scope', () => {
    pushSystemReminder('A', 'a');
    pushSystemReminder('B', 'b');

    clearSystemReminders('A');
    expect(peekSystemReminders('A')).toHaveLength(0);
    expect(peekSystemReminders('B')).toHaveLength(1);
  });

  it('clearSystemReminders() 清全部', () => {
    pushSystemReminder('A', 'a');
    pushSystemReminder('B', 'b');
    pushSystemReminder('C', 'c');

    clearSystemReminders();
    expect(peekSystemReminders('A')).toHaveLength(0);
    expect(peekSystemReminders('B')).toHaveLength(0);
    expect(peekSystemReminders('C')).toHaveLength(0);
  });

  it('formatRemindersForMessage 输出 <system-reminder> 标签', () => {
    pushSystemReminder('s1', '现在是 plan mode');
    pushSystemReminder('s1', '用户已中断', { priority: 'critical' });

    const consumed = consumeSystemReminders('s1');
    const formatted = formatRemindersForMessage(consumed);

    expect(formatted).toContain('<system-reminder>');
    expect(formatted).toContain('</system-reminder>');
    expect(formatted).toContain('authoritative directive');
    expect(formatted).toContain('用户已中断');
    expect(formatted).toContain('现在是 plan mode');
    /* critical 在前 */
    const userIdx = formatted!.indexOf('用户已中断');
    const planIdx = formatted!.indexOf('现在是 plan mode');
    expect(userIdx).toBeLessThan(planIdx);
  });

  it('formatRemindersForMessage 空列表返 null', () => {
    expect(formatRemindersForMessage([])).toBeNull();
  });

  it('getReminderDebugInfo 列出所有 scope 状态', () => {
    pushSystemReminder('A', 'a1');
    pushSystemReminder('A', 'a2', { priority: 'critical' });
    pushSystemReminder('B', 'b1');

    const info = getReminderDebugInfo();
    const aInfo = info.find((x) => x.scope === 'A');
    const bInfo = info.find((x) => x.scope === 'B');

    expect(aInfo).toBeDefined();
    expect(aInfo!.count).toBe(2);
    expect(aInfo!.priorities.sort()).toEqual(['critical', 'normal']);
    expect(bInfo).toBeDefined();
    expect(bInfo!.count).toBe(1);
  });

  it('source 标签保留到 reminder 对象', () => {
    pushSystemReminder('s1', 'x', { source: 'plan-mode-toggle' });
    const r = peekSystemReminders('s1')[0];
    expect(r.source).toBe('plan-mode-toggle');
  });
});
