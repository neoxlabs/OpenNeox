import type { RuntimeBridge } from '../index.js';
import type { ActionLogService } from '../../platform/actionLog/index.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { RuntimeCheckpointService } from '../../runtime/checkpoint/runtimeCheckpointService.js';
import { getTools } from '../../tools/runtimeTools.js';
import { syncMcpTools } from '../../mcp/syncMcpTools.js';
import type { MCPClientManager } from '../../mcp/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

type ToolWorkspaceBridgeMethods = Pick<RuntimeBridge, 'getToolList' | 'reloadTools' | 'setWorkspace'>;

interface CreateToolWorkspaceBridgeHandlersOptions {
  platformServices: PlatformServices;
  actionLog: ActionLogService;
  tools: Tool[];
  /** 换工作区后要把 MCP 工具重新挂回去 —— getTools() 只出内置工具 */
  mcpManager: MCPClientManager | null;
  checkpointService: RuntimeCheckpointService;
}

export function createToolWorkspaceBridgeHandlers(
  options: CreateToolWorkspaceBridgeHandlersOptions,
): ToolWorkspaceBridgeMethods {
  const { platformServices, actionLog, tools, checkpointService, mcpManager } = options;

  /* getTools() 只出内置工具, 而这两条路径都是 `tools.length = 0` 整表重来 ——
   * 不补这一步, 换一次工作区就把 MCP 工具全抹了 (用户视角: 换个项目 MCP 就没了)。 */
  const reload = async (newWorkDir: string, why: string) => {
    const reloaded = await getTools(newWorkDir, platformServices, actionLog);
    tools.length = 0;
    tools.push(...reloaded);
    const n = await syncMcpTools(tools, mcpManager);
    cliLogger.info('SERVER', `${why}: ${tools.length} tools for ${newWorkDir} (${n} from MCP)`);
  };

  return {
    getToolList() {
      return { count: tools.length, names: tools.map(t => t.name) };
    },

    async reloadTools(newWorkDir: string) {
      await reload(newWorkDir, 'Reloaded tools');
    },

    async setWorkspace(newWorkDir: string) {
      await reload(newWorkDir, 'Workspace switched');
      checkpointService.setWorkspace(newWorkDir);
    },
  };
}
