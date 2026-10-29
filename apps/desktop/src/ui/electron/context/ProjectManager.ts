
import type { BrowserWindow, WebContents } from 'electron';
import { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import type { AppScope } from './AppScope.js';
import { ProjectScope } from './ProjectScope.js';
import { AGENT_BRIDGE, OWNED_IDS_TRACKER } from './tokens.js';
import { shouldParkOnSwitch, canReviveParked, shouldReapParked } from './scopeRetention.js';
import type { OwnedIdKind } from './OwnedIdsTracker.js';

/** 保活 scope 的空闲回收周期 — 只在有保活对象时才开表。 */
const PARKED_REAP_INTERVAL_MS = 20_000;

/**
 * 创建 BrowserWindow 的工厂 —— 由 main.ts 通过 DI 注入
 * (避免循环依赖 mainWindowFactory)
 */
export type BrowserWindowFactory = (workspacePath: string) => Promise<BrowserWindow>;

/**
 * 在 ProjectScope 里注册 project-level service 的回调.
 * 由 main.ts 传入, 避免 ProjectManager 直接依赖所有 service 类.
 */
export type ProjectServiceBootstrap = (scope: ProjectScope) => void;

export interface ProjectManagerOptions {
  appScope: AppScope;
  createWindow: BrowserWindowFactory;
  bootstrapProjectServices: ProjectServiceBootstrap;
}

const normalizeWorkspacePath = (workspacePath: string): string => {
  const resolved = resolve(workspacePath);
  let normalized = resolved;
  try {
    normalized = typeof realpathSync.native === 'function'
      ? realpathSync.native(resolved)
      : realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export class ProjectManager {
  private readonly appScope: AppScope;
  private readonly createWindow: BrowserWindowFactory;
  private readonly bootstrapProjectServices: ProjectServiceBootstrap;

  private openProjects: ProjectScope[] = [];
  private readonly byPath = new Map<string, ProjectScope>();
  private readonly byWindowId = new Map<number, ProjectScope>();

  private readonly parked = new Map<string, ProjectScope>();
  private parkedReaper: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProjectManagerOptions) {
    this.appScope = options.appScope;
    this.createWindow = options.createWindow;
    this.bootstrapProjectServices = options.bootstrapProjectServices;
  }

  /**
   * 打开一个项目 —— 创建新 BrowserWindow + ProjectScope.
   * 如果同 workspace 已经有窗口, focus 它 (IDEA 行为, 不允许重复开).
   *
   * 用于"在新窗口打开项目"场景 (OpenProjectDialog 的 New Window 选项).
   */
  async openProject(workspacePath: string): Promise<ProjectScope> {
    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
    const existing = this.byPath.get(normalizedWorkspacePath);
    if (existing) {
      try {
        existing.window.focus();
      } catch {
        /* window 可能已关闭, fall through 到重开 */
      }
      if (!existing.disposed) return existing;
      this.unindex(existing);
    }

    // 创建 BrowserWindow
    const window = await this.createWindow(normalizedWorkspacePath);

    // 创建 + 注册 scope
    return this.attachWindowToScope(window, normalizedWorkspacePath);
  }

  /**
   * 把一个**已存在**的 BrowserWindow 升级为 ProjectScope.
   *
   * 用于 workspace:set IPC 流程: 用户在欢迎页 / 当前窗口选了一个工作区, 当前窗口
   * 还没有 scope (或者切到了新的 workspace, 老 scope 需要丢弃). 这个方法:
   *
   *   1. 如果该 window 已经有 scope (即 workspace 切换), 先 dispose 老 scope
   *   2. 如果新 workspace 已经在另一个 window 里打开, 不重开 (focus 那个 window),
   *      但是当前 window 还是要给一个 scope (简化: 直接也 attach, 让两个 scope 共存
   *      —— ensureServer 会复用同一个 server). 不允许重开是 IDEA 行为, 我们这里
   *      简化处理为允许重复但 focus 已有的.
   *   3. 创建新 ProjectScope 绑到该 window, 注册 service
   */
  async attachWindowToScope(
    window: BrowserWindow,
    workspacePath: string,
  ): Promise<ProjectScope> {
    const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
    const existingForWindow = this.byWindowId.get(window.id);
    if (existingForWindow && existingForWindow.workspacePath === normalizedWorkspacePath) {
      // 同 workspace 重设, no-op
      return existingForWindow;
    }

    let scope: ProjectScope;
    let isFreshScope = false;

    /* 切回一个刚才保活起来的 workspace —— 原地复活, 不新建。
     * 新建的话会再起一个 runtime, 而老的那个还在后台跑着同一批会话:
     * 两个 runtime 同时对着同一个工作区, 谁的事件都到不齐。 */
    const parked = this.parked.get(normalizedWorkspacePath);
    if (parked && canReviveParked(parked, window.id)) {
      this.parked.delete(normalizedWorkspacePath);
      scope = parked;
      console.log(`[ProjectManager] 复用后台保活的 scope: ${normalizedWorkspacePath}`);
    } else {
      // 同 workspace 已经在别的 window 里打开 —— 简化: 允许多窗口看同 workspace,
      // 但 byPath 只记一个 (最新的). 也可以 throw 不允许, IDEA 是 focus 已有.
      // 当前 v1 选择允许多 window 看同 workspace, 因为禁止会破坏 "新窗口" 流程的预期.
      scope = new ProjectScope(this.appScope, normalizedWorkspacePath, window);
      this.bootstrapProjectServices(scope);
      isFreshScope = true;
    }

    /* ── 原子换绑: 这一段内不允许出现 await ─────────────────────────────── */
    if (existingForWindow) this.unindex(existingForWindow);
    this.openProjects = [...this.openProjects, scope];
    this.byPath.set(normalizedWorkspacePath, scope);
    this.byWindowId.set(scope.windowId, scope);
    /* ── 换绑结束, 窗口已经有 scope ──────────────────────────────────────── */

    if (isFreshScope) {
      // window close → auto dispose (复活的 scope 建的时候已经挂过了, 别重复挂)
      // scope 先于窗口被回收时摘掉 —— 否则来回切项目, 同一个窗口上的监听只增不减
      const onWindowClosed = () => { void this.closeProject(scope); };
      window.once('closed', onWindowClosed);
      scope.onDispose(() => {
        if (!window.isDestroyed()) window.removeListener('closed', onWindowClosed);
      }, 'window-closed-listener');
    }

    /* 老 scope 的去留: 异步收尾, 不挡切换。**不碰它的服务** —— 见 killWorkspaceServices。 */
    if (existingForWindow) {
      void this.retireSwitchedAwayScope(existingForWindow).catch((err) => {
        console.error('[ProjectManager] retire switched-away scope failed:', err);
      });
    }

    return scope;
  }

  /**
   * 给一个 window 解绑 scope (workspace 被清空, e.g. 用户 go-home).
   * 不关 window, 只 dispose scope.
   */
  async detachWindow(window: BrowserWindow): Promise<void> {
    const scope = this.byWindowId.get(window.id);
    if (!scope) return;
    /* 窗口还在 (只是回到了"没有工作区"的状态), 不算关项目 → 不动服务。 */
    this.unindex(scope);
    try {
      await scope.dispose();
    } catch (err) {
      console.error('[ProjectManager] detachWindow dispose failed:', err);
    }
  }

  /**
   * 关闭一个项目 —— dispose scope, 清索引.
   * 如果 window 还在, 不主动 close (caller 应该先 close window).
   */
  async closeProject(scope: ProjectScope): Promise<void> {
    if (scope.disposed) return;
    this.unindex(scope);
    await Promise.race([
      this.killWorkspaceServices(scope.workspacePath, scope),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await scope.dispose();
  }

  /** 只摘索引 —— 不碰这个工程起的服务, 也不 dispose。保活路径用。 */
  private unindex(scope: ProjectScope): void {
    this.openProjects = this.openProjects.filter((p) => p !== scope);
    this.byPath.delete(normalizeWorkspacePath(scope.workspacePath));
    this.byWindowId.delete(scope.windowId);
  }

  private async scopeHasRunningServices(scope: ProjectScope): Promise<boolean> {
    try {
      const client = scope.tryGetService(AGENT_BRIDGE)?.getClient();
      const tasks = (await client?.listBackgroundTasks?.()) ?? [];
      return tasks.some((t: any) => t?.status === 'running' && t?.origin !== 'adopted');
    } catch {
      /* 问不到就保守当"有" —— 拆错的代价是用户的服务无声消失, 留错的代价只是晚点回收。 */
      return true;
    }
  }

  private async retireSwitchedAwayScope(scope: ProjectScope): Promise<void> {
    let busy = false;
    try {
      busy = scope.tryGetService(AGENT_BRIDGE)?.hasRunningSessions() === true;
    } catch {
      busy = false; /* 拿不到 bridge = 没有在跑的活可保 */
    }
    /* 会话在跑要保活, **服务在跑同样要保活** —— 见 scopeHasRunningServices。 */
    const hasServices = busy ? false : await this.scopeHasRunningServices(scope);
    if (hasServices) {
      this.parked.set(normalizeWorkspacePath(scope.workspacePath), scope);
      this.ensureParkedReaper();
      console.log(`[ProjectManager] ${scope.workspacePath} 还有服务在跑 — 后台保活 worker, 不拆`);
      return;
    }
    if (shouldParkOnSwitch({ hasRunningSessions: busy })) {
      this.parked.set(normalizeWorkspacePath(scope.workspacePath), scope);
      this.ensureParkedReaper();
      console.log(`[ProjectManager] ${scope.workspacePath} 还有会话在跑 — 后台保活, 不拆`);
      return;
    }
    try {
      await scope.dispose();
    } catch (err) {
      console.error('[ProjectManager] dispose old scope failed:', err);
    }
  }

  /** 保活的 scope 空闲后回收 —— 只在有保活对象时开表, 全空就停, 静息零开销。 */
  private ensureParkedReaper(): void {
    if (this.parkedReaper) return;
    this.parkedReaper = setInterval(() => {
      void this.reapParked();
    }, PARKED_REAP_INTERVAL_MS);
    (this.parkedReaper as any).unref?.();
  }

  private async reapParked(): Promise<void> {
    for (const [path, scope] of [...this.parked]) {
      let busy = false;
      try {
        busy = scope.tryGetService(AGENT_BRIDGE)?.hasRunningSessions() === true;
      } catch { busy = false; }
      if (!shouldReapParked({ hasRunningSessions: busy, disposed: scope.disposed })) continue;
      /* 会话空闲了, 但服务还在跑 —— 照样不能拆: 拆 scope = terminate worker = 服务陪葬。 */
      if (!scope.disposed && await this.scopeHasRunningServices(scope)) continue;
      this.parked.delete(path);
      if (scope.disposed) continue;
      /* 回收的是 scope (runtime / 事件通道), **不是服务**。用户可能只是切去了别的工程,
       * 窗口一直开着 —— 他的 dev server 没有理由因为一个后台 scope 到期而被停掉。 */
      console.log(`[ProjectManager] 保活的 ${path} 已空闲 — 回收 scope (服务不动)`);
      try {
        await scope.dispose();
      } catch (err) {
        console.error('[ProjectManager] reap dispose failed:', err);
      }
    }
    if (this.parked.size === 0 && this.parkedReaper) {
      clearInterval(this.parkedReaper);
      this.parkedReaper = null;
    }
  }

  private async killWorkspaceServices(workspacePath: string, scope?: ProjectScope): Promise<void> {
    try {
      const bridge = scope?.tryGetService(AGENT_BRIDGE)?.getRuntimeBridge?.();
      if (bridge?.killAllTrackedProcesses) {
        const r = await bridge.killAllTrackedProcesses({
          workspaceRoot: workspacePath,
          terminatedBy: 'system',
        });
        if (r?.killed > 0) {
          console.log(`[ProjectManager] 关闭项目 ${workspacePath}: 停止 ${r.killed} 个服务 (hardKilled=${r.hardKilled})`);
        }
        return;
      }
      /* 没有 bridge (runtime 还没起来 / 已经拆了) —— 这个 scope 也就没起过服务。
       * 退回主进程 processManager 只是为了兼容 in-process 模式的历史行为。 */
      const { processManager } = await import('@neoxlabs/platform/platform/processManager.js');
      const r = await processManager.killAllTracked({
        workspaceRoot: workspacePath,
        terminatedBy: 'system',
      });
      if (r.killed > 0) {
        console.log(`[ProjectManager] 关闭项目 ${workspacePath}: 停止 ${r.killed} 个服务 (本地兜底路径)`);
      }
    } catch (err: any) {
      console.error('[ProjectManager] killWorkspaceServices failed:', err?.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lookup (hot path: 每个 IPC 调用都要走一次)
  // ═══════════════════════════════════════════════════════════════════

  /** 从 IPC event?.sender 反查 scope */
  getBySender(sender: WebContents): ProjectScope | undefined {
    const win = ElectronBrowserWindow.fromWebContents(sender);
    return win ? this.byWindowId.get(win.id) : undefined;
  }

  /** 按 BrowserWindow.id 查 */
  getByWindowId(windowId: number): ProjectScope | undefined {
    return this.byWindowId.get(windowId);
  }

  /** 按 workspace 路径查 */
  getByPath(workspacePath: string): ProjectScope | undefined {
    return this.byPath.get(normalizeWorkspacePath(workspacePath));
  }

  async killAllProjectServices(): Promise<{ killed: number; hardKilled: number; scopes: number }> {
    const scopes = this.listScopes();
    let killed = 0;
    let hardKilled = 0;
    await Promise.all(scopes.map(async (scope) => {
      try {
        const bridge = scope.tryGetService(AGENT_BRIDGE)?.getRuntimeBridge?.();
        if (!bridge?.killAllTrackedProcesses) return;
        const r = await bridge.killAllTrackedProcesses({ terminatedBy: 'system' });
        killed += r?.killed ?? 0;
        hardKilled += r?.hardKilled ?? 0;
      } catch (err: any) {
        console.error(`[ProjectManager] 清场失败 ${scope.workspacePath}:`, err?.message);
      }
    }));
    return { killed, hardKilled, scopes: scopes.length };
  }

  /**
   * 还在跑的"自己起的"服务数 —— 退出前那句确认用。
   * adopted (用户自己起的) 和 free-shell (交互终端) 不算: 我们不杀它们, 也就不该拿它们吓唬用户。
   */
  async countRunningOwnedServices(): Promise<number> {
    const scopes = this.listScopes();
    const counts = await Promise.all(scopes.map(async (scope) => {
      try {
        const client = scope.tryGetService(AGENT_BRIDGE)?.getClient();
        const tasks = (await client?.listBackgroundTasks?.()) ?? [];
        return tasks.filter((t: any) =>
          t?.status === 'running' && t?.origin !== 'adopted' && t?.kind !== 'free-shell').length;
      } catch { return 0; }
    }));
    return counts.reduce((a, b) => a + b, 0);
  }

  /** 全部还活着的 scope (只读快照) — mobile-bridge 兜底路由等跨 scope 场景用.
   *  含后台保活的: 它们的会话还在跑, 事件路由不能漏了它们。 */
  listScopes(): ProjectScope[] {
    return [...this.openProjects, ...this.parked.values()];
  }

  /**
   * 按 "拥有的资源 id" 反查 (用于事件路由).
   *
   * kind 举例:
   *   - 'terminal' (terminal session id)
   *   - 'runProcess' (run launch process id)
   *   - 'debugSession' (debug session id)
   *   - 'chatSession' (neox agent session id)
   *
   * 遍历 openProjects (N < 20, 数组迭代比 Map 快).
   */
  getByOwnedId(kind: OwnedIdKind, id: string): ProjectScope | undefined {
    for (const scope of this.openProjects) {
      const tracker = scope.tryGetService(OWNED_IDS_TRACKER);
      if (tracker?.has(kind, id)) return scope;
    }
    return undefined;
  }

  /** 所有打开的 project (readonly 视图) */
  listAll(): readonly ProjectScope[] {
    return this.openProjects;
  }

  /** 当前 focused window 对应的 scope (fallback: 第一个) */
  getFocused(): ProjectScope | undefined {
    const focused = ElectronBrowserWindow.getFocusedWindow();
    if (focused) {
      const scope = this.byWindowId.get(focused.id);
      if (scope) return scope;
    }
    return this.openProjects[0];
  }

  /**
   * 关闭所有项目 (app shutdown 时调用).
   */
  async disposeAll(): Promise<void> {
    const scopes = [...this.openProjects];
    this.openProjects = [];
    this.byPath.clear();
    this.byWindowId.clear();
    for (const scope of scopes) {
      try {
        await scope.dispose();
      } catch (err) {
        console.error('[ProjectManager] dispose scope failed:', err);
      }
    }
  }
}
