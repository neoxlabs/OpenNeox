/**
 * BackgroundTaskNotifier — 核心链路 smoke test
 *
 * 验证:
 *   1. enterSession + trackPid 能把 pid 绑到 session
 *   2. processManager 的 'process:exit' 事件触发 XML 入队
 *   3. drainForSession 返回正确的通知,并清空队列
 *   4. 未 track 的 pid 退出不会生成通知
 *   5. runWithSession(callback) 也能建立 session 上下文
 *   6. 多 session 互不干扰
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  BackgroundTaskNotifier,
  __resetBackgroundTaskNotifierForTest,
  BACKGROUND_TASK_NOTIFICATION_TAG,
} from '../backgroundTaskNotifier.js';
import type { ProcessManager, TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';

// ---------- test doubles ----------

function makeFakeProcess(
  pid: number,
  status: TrackedProcess['status'] = 'completed',
  exitCode = 0,
): TrackedProcess {
  return {
    pid,
    command: `test-cmd-${pid}`,
    cwd: '/tmp',
    startTime: new Date(),
    status,
    exitCode,
    endTime: new Date(),
    background: true,
    outputBuffer: [],
  };
}

function makeFakeProcessManager(): ProcessManager {
  // 仅需要 EventEmitter 能力以触发事件;其余 API 在本测试中不被调用
  return new EventEmitter() as unknown as ProcessManager;
}

describe('BackgroundTaskNotifier', () => {
  beforeEach(() => {
    __resetBackgroundTaskNotifierForTest();
  });

  it('enterSession + trackPid + exit → notification queued', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);

    notifier.enterSession('session-A');
    notifier.trackPid(12345, 'npm run build');

    expect(notifier.hasNotificationsFor('session-A')).toBe(false);

    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(12345, 'completed', 0));

    expect(notifier.hasNotificationsFor('session-A')).toBe(true);
    const drained = notifier.drainForSession('session-A');
    expect(drained).toHaveLength(1);
    expect(drained[0].pid).toBe(12345);
    expect(drained[0].status).toBe('completed');
    expect(drained[0].exitCode).toBe(0);
    expect(drained[0].xml).toContain(`<${BACKGROUND_TASK_NOTIFICATION_TAG}>`);
    expect(drained[0].xml).toContain('<pid>12345</pid>');
    expect(drained[0].xml).toContain('npm run build');
    expect(drained[0].xml).toContain('<status>completed</status>');

    // drain 清空
    expect(notifier.hasNotificationsFor('session-A')).toBe(false);
    expect(notifier.drainForSession('session-A')).toHaveLength(0);
  });

  it('untracked pid does not generate notification', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);

    notifier.enterSession('session-A');
    // 没调 trackPid
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(99999));
    expect(notifier.hasNotificationsFor('session-A')).toBe(false);
  });

  it('failed status is preserved', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.enterSession('session-B');
    notifier.trackPid(7, 'exit 1');
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(7, 'failed', 1));
    const [n] = notifier.drainForSession('session-B');
    expect(n.status).toBe('failed');
    expect(n.xml).toContain('<status>failed</status>');
    expect(n.xml).toContain('<exit-code>1</exit-code>');
  });

  it('killed status routes through process:kill event', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.enterSession('session-C');
    notifier.trackPid(42, 'sleep 9999');
    (pm as unknown as EventEmitter).emit('process:kill', makeFakeProcess(42, 'killed'));
    const [n] = notifier.drainForSession('session-C');
    expect(n.status).toBe('killed');
  });

  it('multiple sessions are isolated (runWithSession)', async () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);

    await notifier.runWithSession('session-X', async () => {
      notifier.trackPid(100, 'cmd-x');
    });
    await notifier.runWithSession('session-Y', async () => {
      notifier.trackPid(200, 'cmd-y');
    });

    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(100));
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(200));

    expect(notifier.drainForSession('session-X').map(n => n.pid)).toEqual([100]);
    expect(notifier.drainForSession('session-Y').map(n => n.pid)).toEqual([200]);
  });

  it('trackPid outside session is a no-op (safe fallback)', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    // 未 enterSession
    notifier.trackPid(500, 'orphan');
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(500));
    // 不报错、无通知泄漏到任何 session
    expect(notifier.drainForSession('any-session')).toHaveLength(0);
  });

  it('attach is idempotent', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.attach(pm);
    notifier.attach(pm);
    notifier.enterSession('session-I');
    notifier.trackPid(8, 'cmd');
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(8));
    // 只应得到 1 条通知而不是 3 条
    expect(notifier.drainForSession('session-I')).toHaveLength(1);
  });

  it('cleanupTrackedPidsForSession kills running pids and clears queue', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);

    notifier.enterSession('worker-1');
    notifier.trackPid(100, 'npm run watch');
    notifier.trackPid(200, 'python server.py');
    notifier.trackPid(300, 'already-exited');

    // 模拟 processManager 的 API,用于 cleanup
    const procs: Record<number, { status: string; background: boolean }> = {
      100: { status: 'running', background: true },
      200: { status: 'running', background: true },
      300: { status: 'completed', background: true },
    };
    const killCalls: Array<{ pid: number; group: boolean }> = [];
    const pmMock = {
      get: (pid: number) => procs[pid],
      kill: (pid: number) => { killCalls.push({ pid, group: false }); return true; },
      killProcessGroup: (pid: number) => { killCalls.push({ pid, group: true }); return true; },
    };

    const killed = notifier.cleanupTrackedPidsForSession('worker-1', pmMock, 'test');
    expect(killed.sort()).toEqual([100, 200]);  // 300 非 running,跳过
    expect(killCalls.every(c => c.group)).toBe(true);  // 后台进程用 killProcessGroup
    // 清理后该 session 的通知和追踪都清空
    expect(notifier.listTrackedPidsForSession('worker-1')).toHaveLength(0);
    expect(notifier.drainForSession('worker-1')).toHaveLength(0);
  });

  it('cleanup only affects target session', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.enterSession('A');
    notifier.trackPid(1, 'a');
    notifier.enterSession('B');
    notifier.trackPid(2, 'b');

    const pmMock = {
      get: () => ({ status: 'running', background: true }),
      kill: () => true,
      killProcessGroup: () => true,
    };

    const killedA = notifier.cleanupTrackedPidsForSession('A', pmMock);
    expect(killedA).toEqual([1]);
    // B 的追踪不应被影响
    expect(notifier.listTrackedPidsForSession('B').map(e => e.pid)).toEqual([2]);
  });

  it('XML escapes special chars in command', () => {
    const pm = makeFakeProcessManager();
    const notifier = new BackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.enterSession('esc');
    notifier.trackPid(1, 'echo "<hello>" & true');
    (pm as unknown as EventEmitter).emit('process:exit', makeFakeProcess(1));
    const [n] = notifier.drainForSession('esc');
    expect(n.xml).toContain('&lt;hello&gt;');
    expect(n.xml).toContain('&amp;');
    expect(n.xml).not.toContain('"<hello>"');
  });
});
