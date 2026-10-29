/**
 * 后台任务的会话归属 —— 规则见 filterTasksForSession 上方注释。
 *
 *   核心: 默认会话级临时, 跨会话可见**只**认用户显式确认 (persistent)。
 *   刻意不按端口 / config_id / 存活时长自动晋升 —— 那是猜意图, 而一个跑三分钟的
 *   构建照样占端口、照样活很久, 它并不是"服务"。
 */
import { describe, it, expect } from 'vitest';
import { filterTasksForSession, type BackgroundTask } from '../backgroundTasksStore';

const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
  taskId: 1, pid: 1, command: 'cmd', startedAtMs: 0, status: 'running', ...over,
});

describe('filterTasksForSession', () => {
  it('自己会话起的任务可见', () => {
    const t = task({ pid: 1, ownerSessionId: 'A' });
    expect(filterTasksForSession([t], 'A')).toEqual([t]);
  });

  it('别的会话起的临时任务不可见 —— 这是本次要修的主症状', () => {
    const t = task({ pid: 1, ownerSessionId: 'B' });
    expect(filterTasksForSession([t], 'A')).toEqual([]);
  });

  it('用户确认转正的跨会话可见', () => {
    const t = task({ pid: 1, ownerSessionId: 'B', persistent: true });
    expect(filterTasksForSession([t], 'A')).toEqual([t]);
  });

  it('占着端口但没转正 → 仍然只在自己会话里 (不按启发式晋升)', () => {
    /* 一个跑三分钟的构建/测试照样可能占端口, 占端口 ≠ 用户要它常驻 */
    const t = task({ pid: 1, ownerSessionId: 'B', port: 3000 });
    expect(filterTasksForSession([t], 'A')).toEqual([]);
  });

  it('有 configId 但没转正 → 同样不自动跨会话', () => {
    const t = task({ pid: 1, ownerSessionId: 'B', configId: 'dev' });
    expect(filterTasksForSession([t], 'A')).toEqual([]);
  });

  it('归属未知 → 兜底显示, 不能弄丢', () => {
    /* 07-31 修的正是"起了服务却哪都看不见", 不能修回去 */
    const t = task({ pid: 1, ownerSessionId: undefined });
    expect(filterTasksForSession([t], 'A')).toEqual([t]);
  });

  it('没有当前会话 (空态) 时只剩转正的和无主的', () => {
    const own = task({ pid: 1, ownerSessionId: 'B' });
    const promoted = task({ pid: 2, ownerSessionId: 'B', persistent: true });
    const orphan = task({ pid: 3 });
    expect(filterTasksForSession([own, promoted, orphan], null))
      .toEqual([promoted, orphan]);
  });
});
