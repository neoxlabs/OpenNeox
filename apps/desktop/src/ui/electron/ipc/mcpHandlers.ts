import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  isWorkspaceServerTrusted,
  trustWorkspaceServer,
  revokeWorkspaceTrust,
  type MCPConfigScope,
} from '@neoxlabs/core/mcp/index.js';
import { loadConfig, saveConfig, type MCPServerConfig } from '@neoxlabs/platform/utils/config.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeOptionalBridgeResolver, makeWorkspaceResolver } from './scopeResolvers.js';

interface RegisterMcpIpcHandlersOptions {
  projectManager: ProjectManager;
}

/* MCP 失败常带 cause 链 (TransportError → wrapped Error 之类), 单 .message 没法定位.
 *   把 cause 链一直拍平到 message, 用 ': ' 串连, 让用户 / dev 看一条就明白具体是什么.
 *   不暴露 stack — 防内部路径泄露, 商业产品不专业. */
export function formatMcpError(err: any): string {
  if (!err) return 'Unknown error';
  const parts: string[] = [];
  let cur: any = err;
  let guard = 0;
  while (cur && guard < 5) {
    const msg = typeof cur.message === 'string' && cur.message ? cur.message : (typeof cur === 'string' ? cur : '');
    if (msg && !parts.some((p) => p.includes(msg))) parts.push(msg);
    cur = cur.cause;
    guard++;
  }
  return parts.length > 0 ? parts.join(': ') : String(err);
}

/**
 * mcpHandlers —— MCP server 配置和运行时操作.
 *
 * Per-project 隔离: workdir 来自 sender 窗口的 ProjectScope.workspacePath.
 * 没 scope 时 fallback 到 process.cwd() (welcome page / 全局配置).
 */
export function registerMcpIpcHandlers(options: RegisterMcpIpcHandlersOptions): void {
  const resolveWorkspace = makeWorkspaceResolver(options.projectManager);
  const bridgeOf = makeOptionalBridgeResolver(options.projectManager);

  const workdirOf = (event: IpcMainInvokeEvent): string => resolveWorkspace(event) ?? process.cwd();

  // ── 读操作 ────────────────────────────────────────

  ipcMain.handle('mcp:list', async (event) => {
    try {
      const workDir = workdirOf(event);
      return listMcpServers(workDir).map((s) => ({
        ...s,
        trusted: s.scope !== 'workspace' || isWorkspaceServerTrusted(workDir, s),
      }));
    } catch (err) {
      console.error('[mcp:list] Failed to list MCP servers:', err);
      return [];
    }
  });

  ipcMain.handle('mcp:get-enabled', async () => {
    try {
      const config = loadConfig();
      return config.mcp?.enabled ?? false;
    } catch {
      return false;
    }
  });

  // ── 写操作 ────────────────────────────────────────

  ipcMain.handle('mcp:set-enabled', async (event, enabled: boolean) => {
    try {
      const config = loadConfig();
      config.mcp = { ...(config.mcp ?? {}), enabled };
      saveConfig(config);
      let runtimeWarning: string | undefined;
      try {
        const client = await bridgeOf(event)?.getClientAsync();
        if (client) {
          runtimeWarning = await client.setMcpEnabled(enabled)
            .then(() => undefined)
            .catch((err: unknown) => err instanceof Error ? err.message : String(err));
        }
      } catch (err) {
        runtimeWarning = err instanceof Error ? err.message : String(err);
      }
      return { success: true, ...(runtimeWarning ? { runtimeWarning } : {}) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('mcp:add', async (event, scope: string, server: MCPServerConfig) => {
    try {
      addMcpServer(workdirOf(event), scope as MCPConfigScope, server);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:remove', async (event, scope: string, serverId: string) => {
    try {
      const result = removeMcpServer(workdirOf(event), scope as MCPConfigScope, serverId);
      return { success: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:update', async (event, scope: string, serverId: string, updates: Partial<MCPServerConfig>) => {
    try {
      const client = await bridgeOf(event)?.getClientAsync();
      const result = client
        ? await client.updateMcpServer(scope, serverId, updates)
        : updateMcpServer(workdirOf(event), scope as MCPConfigScope, serverId, updates);
      return result ? { success: true } : { success: false, error: `MCP server "${serverId}" not found in ${scope} config` };
    } catch (error: any) {
      return { success: false, error: formatMcpError(error) };
    }
  });

  /* 批准 / 撤销仓库里的 server。批准按配置签名记在用户级配置 (mcpTrust), 仓库改了命令就要重新批准。
   * 批准后由设置页接着调 mcp:connect —— clientManager 连接时会再查一次信任表。 */
  ipcMain.handle('mcp:trust', async (event, serverId: string, trust: boolean) => {
    try {
      const workDir = workdirOf(event);
      const server = listMcpServers(workDir).find((s) => s.id === serverId);
      if (!server) return { success: false, error: `MCP server "${serverId}" not found` };
      if (server.scope !== 'workspace') return { success: true };
      if (trust) {
        if (!trustWorkspaceServer(workDir, server)) {
          return { success: false, error: 'Incomplete server config; cannot record approval' };
        }
      } else {
        revokeWorkspaceTrust(workDir, server);
        try { await (await bridgeOf(event)?.getClientAsync())?.disconnectMcpServer(serverId); } catch { /* 没连着 */ }
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: formatMcpError(error) };
    }
  });

  // ── 运行时操作: 必须通过 SDK client (本 scope 的 bridge) ──

  ipcMain.handle('mcp:connect', async (event, serverId: string) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try { await client.connectMcpServer(serverId); return { success: true }; }
    catch (error: any) {
      return {
        success: false,
        error: formatMcpError(error),
        code: typeof error?.code === 'string' ? error.code : undefined,
        cause: typeof error?.cause?.message === 'string' ? error.cause.message : undefined,
      };
    }
  });

  ipcMain.handle('mcp:disconnect', async (event, serverId: string) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try { await client.disconnectMcpServer(serverId); return { success: true }; }
    catch (error: any) { return { success: false, error: formatMcpError(error) }; }
  });

  ipcMain.handle('mcp:test', async (event, serverId: string) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected', toolCount: 0, tools: [] };
    try { const result = await client.testMcpServer(serverId); return { success: true, ...result }; }
    catch (error: any) { return { success: false, error: formatMcpError(error), toolCount: 0, tools: [] }; }
  });

  ipcMain.handle('mcp:get-tools', async (event, serverId: string) => {
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected', tools: [] };
    try { const tools = await client.getMcpServerTools(serverId); return { success: true, tools }; }
    catch (error: any) { return { success: false, error: formatMcpError(error), tools: [] }; }
  });
}
