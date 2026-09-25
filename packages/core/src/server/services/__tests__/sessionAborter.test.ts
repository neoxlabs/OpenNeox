/**
 * abortSession — 中断后仍活着的后台进程必须被上报
 *
 * 背景: abort 只砍 agentLoop, 后台 spawn 出去的进程 (npm run dev / 测试 watcher) 不在
 * 这条链上, 会继续跑。**这是对的** —— 服务面板 / serviceAdoptTool / servicePreflightCheck
 * 整套复用机制都建立在"服务跨轮存活"之上。真正的 bug 是没人被告知。
 *
 * 这里锁三条:
 *   1. 幸存进程被列出来并返回给调用方 (给 UI 报状态用)
 *   2. 给 agent 投了一条通知 —— 下一轮才知道端口已被自己占着
 *   3. 该通知**不能**触发 autoResume: 用户刚按了停止, 代他再拉起一轮就是"停不下来"
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { abortSession } from '../sessionAborter.js';
import {
  getBackgroundTaskNotifier,
  __resetBackgroundTaskNotifierForTest,
  setBgTaskAutoResumeHandler,
} from '../../../runtime/shell/backgroundTaskNotifier.js';

describe('abortSession — 后台幸存进程上报', () => {
  beforeEach(() => {
    __resetBackgroundTaskNotifierForTest();
    setBgTaskAutoResumeHandler(null);
  });

  test('列出幸存进程, 投通知给下一轮 agent, 且不触发 autoResume', () => {
    const sessionId = 'session-abort-test';
    const notifier = getBackgroundTaskNotifier();
    /* 用当前进程自己的 pid 当"活着的后台进程" —— 它一定通得过 kill(pid,0) 复核 */
    notifier.runWithSession(sessionId, () => {
      notifier.trackPid(process.pid, 'npm run dev');
    });

    const autoResume = vi.fn();
    setBgTaskAutoResumeHandler(autoResume as never);

    const ac = new AbortController();
    const controllers = new Map([[sessionId, ac]]);
    const result = abortSession({
      sessionId,
      abortControllers: controllers,
      activeSessionModes: new Map(),
      singleRuntime: null,
    });

    expect(ac.signal.aborted).toBe(true);
    expect(result.survivingProcesses).toHaveLength(1);
    expect(result.survivingProcesses[0]).toMatchObject({ pid: process.pid, command: 'npm run dev' });

    const queued = notifier.drainForSession(sessionId);
    expect(queued.length).toBeGreaterThan(0);
    const xml = queued.map(n => n.xml ?? String(n)).join('\n');
    expect(xml).toContain('background-processes-survived-interrupt');
    expect(xml).toContain('npm run dev');
    expect(xml).toContain(String(process.pid));

    /* 关键: 绝不能代用户再起一轮 */
    expect(autoResume).not.toHaveBeenCalled();

    setBgTaskAutoResumeHandler(null);
  });

  test('没有后台进程时不投任何通知', () => {
    const sessionId = 'session-abort-clean';
    const result = abortSession({
      sessionId,
      abortControllers: new Map(),
      activeSessionModes: new Map(),
      singleRuntime: null,
    });
    expect(result.survivingProcesses).toHaveLength(0);
    expect(getBackgroundTaskNotifier().drainForSession(sessionId)).toHaveLength(0);
  });

  test('死掉的 pid 不算幸存 (不能把僵尸报给 agent)', () => {
    const sessionId = 'session-abort-zombie';
    const notifier = getBackgroundTaskNotifier();
    /* 一个几乎不可能存在的 pid */
    notifier.runWithSession(sessionId, () => {
      notifier.trackPid(2_147_483_646, 'ghost');
    });
    const result = abortSession({
      sessionId,
      abortControllers: new Map(),
      activeSessionModes: new Map(),
      singleRuntime: null,
    });
    expect(result.survivingProcesses).toHaveLength(0);
  });
});
