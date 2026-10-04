/**
 * E2E smoke — 真实跑 bash 子进程,验证通知链路打通
 *
 * 链路:
 *   real `execa` spawn
 *     → platform processManager.register
 *     → notifier.trackPid(attached to process:exit)
 *     → subprocess exit (real)
 *     → processManager.markCompleted → emit 'process:exit'
 *     → notifier handler → enqueueMessageForSession → XML on inbox
 *
 * 不走 worker 子进程(那个需要额外 entry),直接走 backgroundShellExecution 的
 * in-process 分支。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execa } from 'execa';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import {
  getBackgroundTaskNotifier,
  __resetBackgroundTaskNotifierForTest,
} from '../../../runtime/shell/backgroundTaskNotifier.js';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('E2E smoke — bash → processManager → notifier', () => {
  beforeEach(() => {
    __resetBackgroundTaskNotifierForTest();
    processManager.reset();
  });

  it('real subprocess exit triggers <background-task-notification> for the right session', async () => {
    const notifier = getBackgroundTaskNotifier();
    notifier.attach(processManager);
    notifier.enterSession('e2e-session');

    // 真跑一个 500ms 就退的命令
    const child = execa('node', ['-e', 'setTimeout(() => process.exit(0), 200)'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    processManager.register({
      pid,
      command: 'test-500ms-cmd',
      cwd: process.cwd(),
      background: true,
      processRef: child,
    });
    notifier.trackPid(pid, 'test-500ms-cmd');

    // 挂 exit 转发
    child.on('exit', (code) => {
      processManager.markCompleted(pid, code ?? 0);
    });

    // 等进程退出 + processManager 事件传播
    await child.catch(() => { /* expected to resolve normally */ });
    await sleep(50);

    expect(notifier.hasNotificationsFor('e2e-session')).toBe(true);
    const [notif] = notifier.drainForSession('e2e-session');
    expect(notif).toBeDefined();
    expect(notif.pid).toBe(pid);
    expect(notif.status).toBe('completed');
    expect(notif.xml).toContain('<background-task-notification>');
    expect(notif.xml).toContain(`<pid>${pid}</pid>`);
    expect(notif.xml).toContain('<status>completed</status>');
    expect(notif.xml).toContain('test-500ms-cmd');
  }, 10_000);

  it('failed process (exit 1) marks status=failed', async () => {
    const notifier = getBackgroundTaskNotifier();
    notifier.attach(processManager);
    notifier.enterSession('fail-session');

    const child = execa('node', ['-e', 'process.exit(7)'], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid!;
    processManager.register({
      pid,
      command: 'exit-7',
      cwd: process.cwd(),
      background: true,
    });
    notifier.trackPid(pid, 'exit-7');
    child.on('exit', (code) => {
      processManager.markCompleted(pid, code ?? 0);
    });

    await child.catch(() => {});
    await sleep(50);

    const [notif] = notifier.drainForSession('fail-session');
    expect(notif).toBeDefined();
    expect(notif.status).toBe('failed');
    expect(notif.exitCode).toBe(7);
  }, 10_000);

  it('two parallel commands report independently to the same session', async () => {
    const notifier = getBackgroundTaskNotifier();
    notifier.attach(processManager);
    notifier.enterSession('multi-session');

    const c1 = execa('node', ['-e', 'setTimeout(() => process.exit(0), 100)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const c2 = execa('node', ['-e', 'setTimeout(() => process.exit(0), 250)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid1 = c1.pid!, pid2 = c2.pid!;

    processManager.register({ pid: pid1, command: 'cmd1', cwd: process.cwd(), background: true });
    processManager.register({ pid: pid2, command: 'cmd2', cwd: process.cwd(), background: true });
    notifier.trackPid(pid1, 'cmd1');
    notifier.trackPid(pid2, 'cmd2');
    c1.on('exit', (code) => processManager.markCompleted(pid1, code ?? 0));
    c2.on('exit', (code) => processManager.markCompleted(pid2, code ?? 0));

    await Promise.all([c1, c2].map(p => p.catch(() => {})));
    await sleep(50);

    const notifs = notifier.drainForSession('multi-session');
    expect(notifs).toHaveLength(2);
    const pids = notifs.map(n => n.pid).sort();
    expect(pids).toEqual([pid1, pid2].sort());
  }, 10_000);
});
