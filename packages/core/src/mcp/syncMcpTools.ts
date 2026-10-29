import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { MCPClientManager } from './clientManager.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const MCP_TOOL_PREFIX = 'mcp__';

/** 同步一次, 返回当前挂着的 MCP 工具数 (调用方可以据此打日志) */
export async function syncMcpTools(
  tools: Tool[],
  mcpManager: MCPClientManager | null,
  options?: { refresh?: boolean },
): Promise<number> {
  /* 先摘旧的 —— 即使 manager 没了/禁用了, 也不能把上一次的工具留在表里 */
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i]?.name?.startsWith(MCP_TOOL_PREFIX)) tools.splice(i, 1);
  }
  if (!mcpManager) return 0;
  try {
    const mcpTools = await mcpManager.getTools({ refresh: options?.refresh });
    tools.push(...mcpTools);
    return mcpTools.length;
  } catch (err: any) {
    /* 拿不到就是 0 个 —— MCP 挂了不该拖垮整个 runtime 启动 */
    cliLogger.warn('MCP', `syncMcpTools failed: ${err?.message || err}`);
    return 0;
  }
}

/**
 * 「启动时自动连接」(autoConnect) 的 server 在后台连 —— 不挡 runtime 启动 (一台远端
 * 超时就是 30s), 连上后重算一次工具表。失败逐台记日志, 用户在设置页手动连时会看到原因。
 */
export function autoConnectMcpInBackground(tools: Tool[], mcpManager: MCPClientManager | null): void {
  if (!mcpManager?.isEnabled()) return;
  const manager = mcpManager;
  void manager.connectAutoConnectServers().then(async ({ connected, failed }) => {
    for (const f of failed) cliLogger.warn('MCP', `autoConnect ${f.id} failed: ${f.error}`);
    if (connected.length > 0) {
      const n = await syncMcpTools(tools, manager, { refresh: true });
      cliLogger.info('MCP', `autoConnect: ${connected.join(', ')} connected, ${n} MCP tool(s) in agent table`);
    }
  }).catch((err: any) => cliLogger.warn('MCP', `autoConnect failed: ${err?.message || err}`));
}
