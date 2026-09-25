/**
 * ScheduledWakeupRegistry — 自主 pacing 核心链路
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ScheduledWakeupRegistry,
  __resetScheduledWakeupRegistryForTest,
  MIN_WAKEUP_SECONDS,
  MAX_WAKEUP_SECONDS,
  SCHEDULED_WAKEUP_TAG,
} from '../scheduledWakeupRegistry.js';
import {
  BackgroundTaskNotifier,
  __resetBackgroundTaskNotifierForTest,
  getBackgroundTaskNotifier,
} from '../backgroundTaskNotifier.js';

describe('ScheduledWakeupRegistry', () => {
  beforeEach(() => {
    __resetScheduledWakeupRegistryForTest();
    __resetBackgroundTaskNotifierForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule clamps delay below MIN', () => {
    const reg = new ScheduledWakeupRegistry();
    const { clamped, id } = reg.schedule({
      sessionId: 's1',
      delaySeconds: 5,
      reason: 'too short',
      prompt: 'do x',
    });
    expect(clamped).toBe(true);
    expect(reg.listForSession('s1')).toHaveLength(1);
    reg.cancel(id);
  });

  it('schedule clamps delay above MAX', () => {
    const reg = new ScheduledWakeupRegistry();
    const { clamped, id, dueAt } = reg.schedule({
      sessionId: 's1',
      delaySeconds: 99999,
      reason: 'too long',
      prompt: 'do x',
    });
    expect(clamped).toBe(true);
    // dueAt 应在 max 附近
    const diffSec = (dueAt - Date.now()) / 1000;
    expect(diffSec).toBeLessThanOrEqual(MAX_WAKEUP_SECONDS + 1);
    reg.cancel(id);
  });

  it('fire enqueues XML into notifier for correct session', () => {
    // 因为 scheduledWakeupRegistry.fire 内部 getBackgroundTaskNotifier(),
    // 我们先 reset 再访问确保拿到新实例
    const notifier = getBackgroundTaskNotifier();
    const reg = new ScheduledWakeupRegistry();
    reg.schedule({
      sessionId: 'my-session',
      delaySeconds: 60,
      reason: 'check build',
      prompt: 'bash_output(pid=12345)',
    });
    expect(notifier.hasNotificationsFor('my-session')).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(notifier.hasNotificationsFor('my-session')).toBe(true);
    const drained = notifier.drainForSession('my-session');
    expect(drained).toHaveLength(1);
    expect(drained[0].xml).toContain(`<${SCHEDULED_WAKEUP_TAG}>`);
    expect(drained[0].xml).toContain('<reason>check build</reason>');
    expect(drained[0].xml).toContain('<prompt>bash_output(pid=12345)</prompt>');
  });

  it('cancel prevents firing', () => {
    const notifier = getBackgroundTaskNotifier();
    const reg = new ScheduledWakeupRegistry();
    const { id } = reg.schedule({
      sessionId: 's',
      delaySeconds: 60,
      reason: 'r',
      prompt: 'p',
    });
    expect(reg.cancel(id)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(notifier.hasNotificationsFor('s')).toBe(false);
    // 二次 cancel 返回 false
    expect(reg.cancel(id)).toBe(false);
  });

  it('cancelAllForSession clears only matching session', () => {
    const reg = new ScheduledWakeupRegistry();
    reg.schedule({ sessionId: 'A', delaySeconds: 60, reason: 'a1', prompt: 'x' });
    reg.schedule({ sessionId: 'A', delaySeconds: 60, reason: 'a2', prompt: 'y' });
    reg.schedule({ sessionId: 'B', delaySeconds: 60, reason: 'b1', prompt: 'z' });

    const n = reg.cancelAllForSession('A');
    expect(n).toBe(2);
    expect(reg.listForSession('A')).toHaveLength(0);
    expect(reg.listForSession('B')).toHaveLength(1);
  });

  it('XML escapes special chars in reason & prompt', () => {
    const notifier = getBackgroundTaskNotifier();
    const reg = new ScheduledWakeupRegistry();
    reg.schedule({
      sessionId: 's',
      delaySeconds: 60,
      reason: 'retry <foo> & <bar>',
      prompt: 'run "echo >file"',
    });
    vi.advanceTimersByTime(60_000);
    const [n] = notifier.drainForSession('s');
    expect(n.xml).toContain('&lt;foo&gt;');
    expect(n.xml).toContain('&amp;');
    expect(n.xml).toContain('&lt;bar&gt;');
    expect(n.xml).toContain('&gt;file');
  });

  it('MIN/MAX constants are 60/3600', () => {
    // 确保契约
    expect(MIN_WAKEUP_SECONDS).toBe(60);
    expect(MAX_WAKEUP_SECONDS).toBe(3600);
  });
});
