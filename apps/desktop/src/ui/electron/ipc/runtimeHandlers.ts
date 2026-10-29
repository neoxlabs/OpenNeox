import { ipcMain } from './ipcMainBridged.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver } from './scopeResolvers.js';
import { remoteSessions } from '../remoteSessions.js';
import { removeAskUserByRequestId } from '../mobile-bridge/pendingActionsRegistry.js';

interface RegisterRuntimeIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerRuntimeIpcHandlers(options: RegisterRuntimeIpcHandlersOptions): void {
  const bridgeOf = makeBridgeResolver(options.projectManager);

  ipcMain.handle('runtime:get-sandbox', async (event, sessionId: string) => {
    return bridgeOf(event).getSandboxStatus(sessionId);
  });

  ipcMain.handle('runtime:set-sandbox', async (event, sessionId: string, enabled: boolean, modelId: string) => {
    await bridgeOf(event).setSandboxMode(sessionId, enabled, modelId);
  });

  ipcMain.handle('runtime:get-approval', async (event, sessionId: string) => {
    /* preload expose 出去给 renderer 是 { mode } 形状 (approvalModeStore 这样读),
     *  bridge 内部返 'auto'|... 字符串, 这里包一层避免 renderer 改协议 */
    const mode = await bridgeOf(event).getApprovalMode(sessionId);
    return { mode };
  });

  ipcMain.handle('runtime:list-always-allow', async (event) => bridgeOf(event).listAlwaysAllow());
  ipcMain.handle('runtime:revoke-always-allow', async (event, toolName: string) => {
    await bridgeOf(event).revokeAlwaysAllow(String(toolName || ''));
  });

  ipcMain.handle(
    'runtime:set-approval',
    async (
      event,
      sessionId: string,
      mode: 'auto' | 'manual' | 'dangerous',
      modelId: string,
      options?: {
        scope?: 'global' | 'agent';
        scopeKey?: string;
        inherit?: boolean;
        dangerousConfirmation?: {
          acknowledgeNoApproval: true;
          acknowledgeHighRiskExecution: true;
        };
      },
    ) => {
      await bridgeOf(event).setApprovalMode(sessionId, mode, modelId, options);
    }
  );

  ipcMain.handle('runtime:reply-permission', async (event, requestId: string, approved: boolean, remember?: boolean) => {
    /* cloud session 的审批走 cloud-relay → pod 的 session.approval_response;
     * 本地 session 走 AgentBridge.replyPermission. requestId 路由由远端会话传输口持有的 map 决定. */
    if (remoteSessions().isRemoteApproval(requestId)) {
      await remoteSessions().replyApproval(requestId, approved, remember ?? false);
      return;
    }
    await bridgeOf(event).replyPermission(requestId, approved, remember);
  });

  ipcMain.handle(
    'runtime:cancel-permission',
    async (
      event,
      requestId: string,
      reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale',
    ) => {
      /* cloud session: cancel 等价于 approved=false 不 remember, 让 pod 解开 Promise. */
      if (remoteSessions().isRemoteApproval(requestId)) {
        await remoteSessions().replyApproval(requestId, false, false);
        return;
      }
      await bridgeOf(event).cancelPermission(requestId, reason);
    }
  );

  ipcMain.handle('runtime:reply-ask-user', async (event, requestId: string, answers: Record<string, string>) => {
    const client = await bridgeOf(event).getClientAsync();
    if (!client) {
      return { status: 'orphan' as const, reason: 'client unavailable' };
    }
    /* SDK client.replyAskUser 返 { status, reason? } — 'resolved' | 'resumed' | 'orphan'. */
    const result = await client.replyAskUser(requestId, answers);
    removeAskUserByRequestId(requestId);
    return result;
  });

  const UNREACHABLE_RE = /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|EPIPE|ENOENT|not running|no client|LocalNeoxClient/i;
  const bgTaskOp = async (
    event: Electron.IpcMainInvokeEvent,
    method: 'killBackgroundTask' | 'pauseBackgroundTask' | 'resumeBackgroundTask'
      | 'setBackgroundTaskPersistent',
    args: unknown[],
  ): Promise<{ ok: boolean; error?: string; unreachable?: boolean }> => {
    try {
      const client = await bridgeOf(event).getClientAsync();
      const fn = client && (client as any)[method];
      if (typeof fn !== 'function') {
        return { ok: false, error: 'backend unavailable', unreachable: true };
      }
      await fn.apply(client, args);
      return { ok: true };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const unreachable = UNREACHABLE_RE.test(msg);
      console.warn(`[runtime:${method}] failed:`, msg);
      return { ok: false, error: msg, unreachable };
    }
  };

  ipcMain.handle('runtime:kill-background-task', (event, pid: number, force?: boolean) =>
    bgTaskOp(event, 'killBackgroundTask', [pid, !!force]));

  ipcMain.handle('runtime:pause-background-task', (event, pid: number) =>
    bgTaskOp(event, 'pauseBackgroundTask', [pid]));

  ipcMain.handle('runtime:resume-background-task', (event, pid: number) =>
    bgTaskOp(event, 'resumeBackgroundTask', [pid]));

  /* 转正/取消转正 —— 后台任务默认会话级, 这是唯一的跨会话晋升途径 */
  ipcMain.handle('runtime:set-background-task-persistent',
    (event, pid: number, persistent: boolean) =>
      bgTaskOp(event, 'setBackgroundTaskPersistent', [pid, !!persistent]));

  ipcMain.handle('runtime:shell-stdin', async (event, pid: number, data: string) => {
    const client = await bridgeOf(event).getClientAsync();
    if (client && typeof (client as any).sendShellStdin === 'function') {
      try {
        /* SDK 现在返回 { delivered } — 透回 renderer, ShellConsole 据此 log
         * "stdin 是否真到了 daemon socket". 失败时不抛错, 不打断 IPC channel. */
        const r = await (client as any).sendShellStdin(pid, data);
        return { delivered: !!(r && r.delivered) };
      } catch (err: any) {
        console.warn('[runtime:shell-stdin] failed:', err?.message);
        return { delivered: false, error: err?.message };
      }
    }
    return { delivered: false, error: 'no client' };
  });

  ipcMain.handle('runtime:shell-resize', async (event, pid: number, cols: number, rows: number) => {
    const client = await bridgeOf(event).getClientAsync();
    if (client && typeof (client as any).resizeShell === 'function') {
      await (client as any).resizeShell(pid, cols, rows);
    }
  });

  /* 用户手动重启 server daemon — Shell 控制台启动失败 / 改完 core 代码想立刻见效时用.
   * 走 force 模式 (即使 daemon 是复用的也要杀), 清 pid file, 下次 ensureClientAsync
   * 必然起一个加载新 dist 的全新 daemon. */
  ipcMain.handle('runtime:restart-server', async (event) => {
    try {
      const bridge = bridgeOf(event);
      await (bridge as any).forceRestartServer?.();
      /* 重新预热 client — 触发 ensureServer 起新 daemon */
      await bridge.getClientAsync().catch(() => undefined);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || '重启失败' };
    }
  });

  /* Services panel Shell 控制台: 起一个独立可交互 PTY shell, 返回 pid 给 renderer */
  ipcMain.handle('runtime:open-interactive-shell', async (event, args?: { cwd?: string; command?: string }) => {
    const client = await bridgeOf(event).getClientAsync();
    if (client && typeof (client as any).openInteractiveShell === 'function') {
      try {
        return await (client as any).openInteractiveShell(args ?? {});
      } catch (err: any) {
        return { pid: null, error: err?.message };
      }
    }
    return { pid: null, error: 'no bridge' };
  });

  const readyClientOrWarm = (event: Parameters<typeof bridgeOf>[0]) => {
    const bridge = bridgeOf(event);
    const client = bridge.getClient();
    if (!client) void bridge.getClientAsync().catch(() => { /* 起不来由真正要用的调用方报错 */ });
    return client;
  };

  ipcMain.handle('runtime:list-background-tasks', async (event) => {
    const client = readyClientOrWarm(event);
    if (client && typeof (client as any).listBackgroundTasks === 'function') {
      return await (client as any).listBackgroundTasks();
    }
    return [];
  });

  /* sub-agent 列表 + abort — UI SubAgentsBar 用 */
  ipcMain.handle('runtime:list-sub-agents', async (event, sessionId: string) => {
    const client = readyClientOrWarm(event);
    if (client && typeof (client as any).listSubAgents === 'function') {
      try {
        const r = await (client as any).listSubAgents(sessionId);
        return Array.isArray(r) ? r : (r?.agents ?? []);
      } catch (err: any) {
        console.warn('[runtime:list-sub-agents] failed:', err?.message);
      }
    }
    return [];
  });

  ipcMain.handle('runtime:abort-sub-agent', async (event, agentId: string) => {
    const client = await bridgeOf(event).getClientAsync();
    if (client && typeof (client as any).abortSubAgent === 'function') {
      try {
        return await (client as any).abortSubAgent(agentId);
      } catch (err: any) {
        return { ok: false, error: err?.message };
      }
    }
    return { ok: false };
  });
}
