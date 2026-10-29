import type {
  McpCommandContext,
  InitCommandContext,
  SetupCommandContext,
} from '../commands/index.js';
import { MCPClientManager } from '@neoxlabs/core/mcp/clientManager.js';

interface McpContextDeps {
  workDir: McpCommandContext['workDir'];
  mcpManager: McpCommandContext['mcpManager'];
  promptSelect: McpCommandContext['promptSelect'];
  promptText: McpCommandContext['promptText'];
  logInfo: McpCommandContext['logInfo'];
  refreshMcpTools: McpCommandContext['refreshMcpTools'];
  outputLines: McpCommandContext['outputLines'];
}

interface InitContextDeps {
  workDir: InitCommandContext['workDir'];
  actionLog: InitCommandContext['actionLog'];
  promptSelect: InitCommandContext['promptSelect'];
  logInfo: InitCommandContext['logInfo'];
  setStatusText: InitCommandContext['setStatusText'];
  llmCall: InitCommandContext['llmCall'];
}

interface SetupContextDeps {
  logInfo: SetupCommandContext['logInfo'];
  logError: SetupCommandContext['logError'];
  promptSelect: SetupCommandContext['promptSelect'];
  promptText: SetupCommandContext['promptText'];
  handleCommand: SetupCommandContext['handleCommand'];
  current?: SetupCommandContext['current'];
}

interface McpMainAdapterDeps {
  workDir: string;
  mcpManager: MCPClientManager | null;
  setMcpManager: (manager: MCPClientManager) => void;
  promptSelect: McpCommandContext['promptSelect'];
  promptText: McpCommandContext['promptText'];
  logInfo: McpCommandContext['logInfo'];
  refreshMcpTools: McpCommandContext['refreshMcpTools'];
  outputLines: McpCommandContext['outputLines'];
}

interface InitMainAdapterDeps {
  workDir: InitCommandContext['workDir'];
  actionLog: InitCommandContext['actionLog'];
  promptSelect: InitCommandContext['promptSelect'];
  logInfo: InitCommandContext['logInfo'];
  setStatusText: InitCommandContext['setStatusText'];
  providerSettings: any;
  model: string;
}

interface SetupMainAdapterDeps {
  logInfo: SetupCommandContext['logInfo'];
  promptSelect: SetupCommandContext['promptSelect'];
  promptText: SetupCommandContext['promptText'];
  handleCommand: SetupCommandContext['handleCommand'];
  current?: SetupCommandContext['current'];
}

export function buildMcpCommandContext(deps: McpContextDeps): McpCommandContext {
  return {
    workDir: deps.workDir,
    mcpManager: deps.mcpManager,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    refreshMcpTools: deps.refreshMcpTools,
    outputLines: deps.outputLines,
  };
}

export function buildMcpCommandContextFromMain(
  deps: McpMainAdapterDeps,
): McpCommandContext {
  let manager = deps.mcpManager;
  if (!manager) {
    manager = new MCPClientManager({ workDir: deps.workDir });
    deps.setMcpManager(manager);
  } else {
    manager.setWorkDir(deps.workDir);
  }

  return buildMcpCommandContext({
    workDir: deps.workDir,
    mcpManager: manager,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    logInfo: deps.logInfo,
    refreshMcpTools: deps.refreshMcpTools,
    outputLines: deps.outputLines,
  });
}

export function buildInitCommandContext(deps: InitContextDeps): InitCommandContext {
  return {
    workDir: deps.workDir,
    actionLog: deps.actionLog,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    setStatusText: deps.setStatusText,
    llmCall: deps.llmCall,
  };
}

export function buildInitCommandContextFromMain(
  deps: InitMainAdapterDeps,
): InitCommandContext {
  return buildInitCommandContext({
    workDir: deps.workDir,
    actionLog: deps.actionLog,
    promptSelect: deps.promptSelect,
    logInfo: deps.logInfo,
    setStatusText: deps.setStatusText,
    llmCall: async (prompt: string, systemPrompt: string) => {
      const { buildProvider } = await import('@neoxlabs/core/runtime/runtimeBuilder.js');
      const result = buildProvider({
        provider: deps.providerSettings,
        model: deps.model,
        sessionId: `init_${Date.now()}`,
      });
      const response = await result.llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        { model: deps.model, temperature: 0.3 },
      );
      const text = response.choices?.[0]?.message?.content;
      return text ?? '';
    },
  });
}

export function buildSetupCommandContext(deps: SetupContextDeps): SetupCommandContext {
  return {
    logInfo: deps.logInfo,
    logError: deps.logError,
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    handleCommand: deps.handleCommand,
    current: deps.current,
  };
}

export function buildSetupCommandContextFromMain(
  deps: SetupMainAdapterDeps,
): SetupCommandContext {
  return buildSetupCommandContext({
    logInfo: deps.logInfo,
    logError: (message, details) => deps.logInfo(`❌ ${message}`, details),
    promptSelect: deps.promptSelect,
    promptText: deps.promptText,
    handleCommand: deps.handleCommand,
    current: deps.current,
  });
}
