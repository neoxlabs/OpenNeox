import { describe, it, expect } from 'vitest';
import { UserStopGate } from '../userStopGate.js';

describe('UserStopGate — 按了停止就停到用户再开口', () => {
  it('没停过: 不拦, 照常代用户起轮', () => {
    const g = new UserStopGate();
    expect(g.hold('s', '<background-task-notification>x</background-task-notification>', 'bg-task')).toBe(false);
  });

  it('用户停止后: 后台结果 / 唤醒都攒下, 用户开口时一次取走并解除停止', () => {
    const g = new UserStopGate();
    g.onAbort('s');
    expect(g.hold('s', 'A', 'bg-task')).toBe(true);
    expect(g.hold('s', 'B', 'wakeup')).toBe(true);
    expect(g.takeHeld('s')).toEqual(['A', 'B']);
    expect(g.hold('s', 'C', 'bg-task')).toBe(false);
    expect(g.takeHeld('s')).toEqual([]);
  });

  it('用户自己定的定时任务 / 提醒照常触发', () => {
    const g = new UserStopGate();
    g.onAbort('s');
    expect(g.hold('s', '<scheduled-task-fired><cron>* * * * *</cron></scheduled-task-fired>', 'bg-task')).toBe(false);
    expect(g.hold('s', '<life-reminder-fired>x</life-reminder-fired>', 'bg-task')).toBe(false);
  });

  it('运行时自己的中断 (停滞兜底) 不算用户停止', () => {
    const g = new UserStopGate();
    g.runInternalAbort('s', () => g.onAbort('s'));
    expect(g.hold('s', 'A', 'bg-task')).toBe(false);
  });

  it('攒的事件有上限, 只留最新的', () => {
    const g = new UserStopGate();
    g.onAbort('s');
    for (let i = 0; i < 25; i++) g.hold('s', String(i), 'bg-task');
    const held = g.takeHeld('s');
    expect(held).toHaveLength(20);
    expect(held[0]).toBe('5');
  });
});
