import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
} from '../../mcp/index.js';
import type { MCPClientManager, MCPConfigScope } from '../../mcp/index.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { syncMcpTools } from '../../mcp/syncMcpTools.js';
import type { RuntimeBridge } from '../index.js';

type McpBridgeMethods = Pick<
  RuntimeBridge,
  | 'listMcpServers'
  | 'isMcpEnabled'
  | 'setMcpEnabled'
  | 'addMcpServer'
  | 'removeMcpServer'
  | 'updateMcpServer'
  | 'connectMcpServer'
  | 'disconnectMcpServer'
  | 'testMcpServer'
  | 'getMcpServerTools'
>;

interface CreateMcpBridgeHandlersOptions {
  workDir: string;
  mcpManager: MCPClientManager | null;
  /** agent 的工具表 (共享引用) —— 连接/断开/启停后要跟着重算 mcp__ 工具, 见 syncMcpTools */
  tools: Tool[];
}

export function createMcpBridgeHandlers(options: CreateMcpBridgeHandlersOptions): McpBridgeMethods {
  const { workDir, mcpManager, tools } = options;

  const resync = async (why: string) => {
    const n = await syncMcpTools(tools, mcpManager, { refresh: true });
    cliLogger.info('MCP', `tools resynced after ${why}: ${n} tool(s) in agent table`);
  };

  return {
    listMcpServers() {
      return listMcpServers(workDir);
    },

    isMcpEnabled() {
      return mcpManager?.isEnabled() ?? false;
    },

    setMcpEnabled(enabled: boolean) {
      if (mcpManager) mcpManager.setEnabled(enabled);
      void resync(`setMcpEnabled(${enabled})`);
    },

    addMcpServer(scope: string, server: any) {
      addMcpServer(workDir, scope as MCPConfigScope, server);
    },

    async removeMcpServer(scope: string, id: string) {
      try {
        await mcpManager?.disconnect(id);
      } catch (err: any) {
        cliLogger.warn('MCP', `disconnect before remove failed for ${id}: ${err?.message || err}`);
      }
      const result = removeMcpServer(workDir, scope as MCPConfigScope, id);
      await resync(`remove(${id})`);
      return result;
    },

    updateMcpServer(scope: string, id: string, updates: any) {
      const updated = updateMcpServer(workDir, scope as MCPConfigScope, id, updates);
      if (updated) void resync(`update(${id})`);
      return updated;
    },

    async connectMcpServer(id: string) {
      if (!mcpManager) throw new Error('MCP manager not initialized (server startup may have failed)');
      await mcpManager.connect(id);
      await resync(`connect(${id})`);
    },

    async disconnectMcpServer(id: string) {
      if (!mcpManager) throw new Error('MCP manager not initialized');
      await mcpManager.disconnect(id);
      await resync(`disconnect(${id})`);
    },

    async testMcpServer(id: string) {
      if (!mcpManager) throw new Error('MCP manager not initialized');
      return mcpManager.testServer(id);
    },

    async getMcpServerTools(id: string) {
      if (!mcpManager) throw new Error('MCP manager not initialized');
      return mcpManager.getToolDefinitions(id);
    },
  };
}
