/**
 * spawn 同步失败时不能把真错因顶掉 —— Windows 打包版已确认。
 *
 * startInProcessShell 在 spawn 同步抛错时 (Windows 打包版里 pty 起不来, 每次必现),
 * 会在**自己返回之前**就 finishWith → pushStream → callbacks.onStream。
 * 那一刻 executeShellInWorker 里的 `const handle` 还没赋值, 回调碰它就是:
 *
 *     ReferenceError: Cannot access 'handle' before initialization   (minify 后叫 'l')
 *
 * 后果不是"多一个报错", 而是**真正的 spawn 失败原因被顶掉了** —— 排查的人看到一句
 * 看不懂的 TDZ, 还长得像打包/混淆产物的锅 (实际未打包源码一样炸, 只是 mac 上 pty
 * 从不同步失败, 所以只有 Windows 打包版天天撞)。
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

const SPAWN_FAILURE = 'this._ptyNative.startProcess is not a function';

/* 模拟"spawn 同步失败"的 startInProcessShell: 先同步喂一次 onStream, 再返回 stub handle */
vi.mock('../inProcessShell.js', () => ({
  startInProcessShell: (_payload: any, callbacks: any) => {
    callbacks?.onStream?.({
      output: `[error] ${SPAWN_FAILURE}`,
      outputDelta: `[error] ${SPAWN_FAILURE}`,
      elapsed: 0,
      isComplete: true,
      exitCode: -1,
    });
    return {
      pid: undefined,
      result: Promise.resolve({
        success: false,
        output: `[error] ${SPAWN_FAILURE}`,
        background: false,
        pid: 0,
        exitCode: -1,
      }),
      kill: () => {},
      writeStdin: () => false,
      resize: () => false,
    };
  },
  getActiveInProcessShellPids: () => [],
  killInProcessShell: () => false,
}));

const { executeShellInWorker } = await import('../shellWorkerClient.js');

function deps() {
  return {
    processManager: {
      get: () => undefined,
      register: () => {},
      appendOutput: () => {},
      bindConfig: () => {},
      markCompleted: () => {},
      findByCommandCwd: () => [],
      getBackgroundRunning: () => [],
    },
    onShellOutputStream: () => {},
    onBackgroundTaskAdd: () => {},
    onBackgroundTaskUpdateByPid: () => {},
  } as any;
}

describe('executeShellInWorker — spawn 同步失败', () => {
  beforeEach(() => { delete process.env.NEOX_SHELL_WORKER_DISABLED; });

  test('后台命令: 不抛 TDZ, 而是把真正的失败原因交出来', async () => {
    const result = await executeShellInWorker(
      { toolId: 't1', command: 'echo background-test-123', background: true, workspaceRoot: process.cwd() } as any,
      deps(),
    );
    expect(result).toBeTruthy();
    expect(result!.success).toBe(false);
    /* 关键: 用户/日志里看到的必须是 pty 起不来这件事, 不是 "Cannot access 'handle'" */
    expect(result!.output).toContain(SPAWN_FAILURE);
  });

  test('前台命令: 同一条同步失败路径也不炸', async () => {
    const result = await executeShellInWorker(
      { toolId: 't2', command: 'echo hi', background: false, workspaceRoot: process.cwd() } as any,
      deps(),
    );
    expect(result!.success).toBe(false);
    expect(result!.output).toContain(SPAWN_FAILURE);
  });
});
