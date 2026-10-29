import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ── electron 替身 ──────────────────────────────────────────────────────── */
const fakeWindows = new Map<number, any>();
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (wc: any) => fakeWindows.get(wc?.__windowId) ?? null,
    getFocusedWindow: () => null,
  },
}));

/* ── processManager 替身: 记录谁调了 killAllTracked ─────────────────────── */
const killCalls: Array<{ workspaceRoot?: string }> = [];
vi.mock('@neoxlabs/platform/platform/processManager.js', () => ({
  processManager: {
    killAllTracked: vi.fn(async (opts?: { workspaceRoot?: string }) => {
      killCalls.push({ workspaceRoot: opts?.workspaceRoot });
      /* 真实实现自带 1.5s 宽限期 —— 这里放一个 macrotask 的延迟, 用来验证
       * "换绑不等这个 Promise"。等了的话下面 scope 可见性的断言就会挂。 */
      await new Promise((r) => setTimeout(r, 20));
      return { killed: 1, skipped: 0, hardKilled: 0 };
    }),
  },
}));

const { ProjectManager } = await import('../context/ProjectManager.js');

function makeWindow(id: number) {
  const closedHandlers: Array<() => void> = [];
  const win: any = {
    id,
    webContents: { __windowId: id },
    focus: () => {},
    once: (evt: string, cb: () => void) => { if (evt === 'closed') closedHandlers.push(cb); },
    __fireClosed: () => closedHandlers.forEach((cb) => cb()),
  };
  fakeWindows.set(id, win);
  return win;
}

/* runtime 在 worker thread 上时, 进程表在 worker 那侧 —— 清场必须经 bridge 发过去。
 * withRuntimeBridge=true 模拟"已接上 worker 的 scope"。 */
const bridgeKillCalls: Array<{ workspaceRoot?: string }> = [];

function makeManager(opts?: { hasRunningSessions?: boolean; withRuntimeBridge?: boolean }) {
  return new ProjectManager({
    appScope: { level: 'app' } as any,
    createWindow: async () => makeWindow(999) as any,
    bootstrapProjectServices: (scope: any) => {
      /* AGENT_BRIDGE 的最小替身 */
      const orig = scope.tryGetService.bind(scope);
      scope.tryGetService = (token: any) => {
        const name = token?.name ?? String(token);
        if (String(name).includes('AgentBridge') || String(name).includes('AGENT_BRIDGE')) {
          return {
            hasRunningSessions: () => opts?.hasRunningSessions === true,
            /* 刻意**不**总是提供 getRuntimeBridge —— 早期版本这里少一个 `?.`,
             * bridge 缺席时抛 TypeError 被 catch 吞掉, 结果一个进程都没杀。 */
            ...(opts?.withRuntimeBridge ? {
              getRuntimeBridge: () => ({
                killAllTrackedProcesses: async (o: any) => {
                  bridgeKillCalls.push({ workspaceRoot: o?.workspaceRoot });
                  return { killed: 1, skipped: 0, hardKilled: 0 };
                },
              }),
            } : {}),
          };
        }
        return orig(token);
      };
    },
  });
}

beforeEach(() => {
  killCalls.length = 0;
  bridgeKillCalls.length = 0;
  fakeWindows.clear();
});

describe('切 workspace', () => {
  it('绝不停这个工程的服务 —— 用户只是去看另一个工程, 回来 dev server 必须还在', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-b');

    /* 给异步收尾留出时间 —— 就算它想杀, 也该在这之内杀完 */
    await new Promise((r) => setTimeout(r, 60));
    expect(killCalls).toEqual([]);
  });

  it('换绑**期间**窗口任何时刻都有 scope (根治 "No project scope for sender window")', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');

    let settled = false;
    const switching = pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-b')
      .finally(() => { settled = true; });

    let gapObserved = 0;
    let probes = 0;
    while (!settled) {
      probes++;
      if (!pm.getBySender(win.webContents as any)) gapObserved++;
      await new Promise((r) => setTimeout(r, 1));
    }
    const scope = await switching;

    expect(probes).toBeGreaterThan(0);          /* 探针真的跑了, 不是空转过关 */
    expect(gapObserved).toBe(0);                /* 一次都不许没有 scope */
    expect(pm.getBySender(win.webContents as any)).toBe(scope);
    expect(scope.workspacePath).toContain('neox-test-proj-b');
  });

  it('老 scope 还有会话在跑 → 后台保活, 切回来复用同一个 (活儿不蒸发)', async () => {
    const pm = makeManager({ hasRunningSessions: true });
    const win = makeWindow(1);
    const a1 = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-b');
    await new Promise((r) => setTimeout(r, 30));
    const a2 = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    expect(a2).toBe(a1);
    expect(killCalls).toEqual([]);
  });
});

describe('关项目', () => {
  it('窗口真的关了 → 停这个工程的服务 (没有窗口再能看到它们)', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    const scope = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');

    await pm.closeProject(scope);
    await new Promise((r) => setTimeout(r, 40));
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0].workspaceRoot).toContain('neox-test-proj-a');
  });

  it('只杀自己工程的, 不误伤别的工程 (必须带 workspaceRoot)', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    const scope = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.closeProject(scope);
    await new Promise((r) => setTimeout(r, 40));
    expect(killCalls[0].workspaceRoot).toBeTruthy();
  });

  /* runtime 在 worker thread 上时, 进程表在 worker 那侧。主进程那个 processManager 是
   * 空壳 —— 走它就是"成功地杀了 0 个进程", 静默, 服务全变孤儿。 */
  it('接上 worker runtime 时, 清场指令必须经 bridge 发过去 (不走主进程空壳)', async () => {
    const pm = makeManager({ withRuntimeBridge: true });
    const win = makeWindow(1);
    const scope = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.closeProject(scope);
    await new Promise((r) => setTimeout(r, 40));
    expect(bridgeKillCalls).toHaveLength(1);
    expect(bridgeKillCalls[0].workspaceRoot).toContain('neox-test-proj-a');
    expect(killCalls).toEqual([]);        /* 主进程那条一次都不该走 */
  });

  it('退出清场遍历所有 scope —— 漏一个就是那个工程的服务全变孤儿', async () => {
    const pm = makeManager({ withRuntimeBridge: true });
    const w1 = makeWindow(1);
    const w2 = makeWindow(2);
    await pm.attachWindowToScope(w1 as any, '/tmp/neox-test-proj-a');
    await pm.attachWindowToScope(w2 as any, '/tmp/neox-test-proj-b');
    const r = await pm.killAllProjectServices();
    expect(r.scopes).toBe(2);
    expect(r.killed).toBe(2);
    expect(bridgeKillCalls).toHaveLength(2);
  });
});

describe('窗口被解绑之后', () => {
  it('detachWindow 之后 sender 查不到 scope —— 所以只有真离开工作区时才准调它', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    expect(pm.getBySender(win.webContents as any)).toBeTruthy();

    await pm.detachWindow(win as any);
    /* 这就是"窗口变砖"的那一刻: 任何走 bridge 的 IPC 从此全抛 */
    expect(pm.getBySender(win.webContents as any)).toBeUndefined();
  });

  it('重新 attach 能救回来 (说明砖化是可逆的, 但要有人来 attach)', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.detachWindow(win as any);
    const scope = await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    expect(pm.getBySender(win.webContents as any)).toBe(scope);
  });
});

describe('detachWindow (回到无工作区, 窗口还在)', () => {
  it('不算关项目 → 不动服务', async () => {
    const pm = makeManager();
    const win = makeWindow(1);
    await pm.attachWindowToScope(win as any, '/tmp/neox-test-proj-a');
    await pm.detachWindow(win as any);
    await new Promise((r) => setTimeout(r, 40));
    expect(killCalls).toEqual([]);
  });
});
