import type { AgentConfig, Instructions, LLMProvider, StructuredOutputDefinition, Tool } from '@neoxlabs/kernel/types/index.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ToolInputGuardrail, ToolOutputGuardrail } from '@neoxlabs/kernel/types/guardrails.js';
import { MemoryPressureMonitor } from '@neoxlabs/kernel/compat/memoryPressure.js';
import { DefaultSessionManager } from '../memory/index.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { SessionSyncManager } from '../memory/session-sync.js';
import type { Session as PersistedSession } from '@neoxlabs/kernel/types/session.js';
import { getTools } from '../tools/runtimeTools.js';
import { toolPackRegistry } from '../tools/packs/toolPack.js';
import { setActiveWebSearchSession } from '../tools/webTools.js';
import { buildMemory, buildProvider, buildRunner, buildRuntimeHost, type ProviderControls } from './runtimeBuilder.js';
import { AgentRuntimeHost } from './agentRuntimeHost.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { SideAgentAdapter } from './sideAgentAdapter.js';

export interface RuntimeHostCreateOptions {
  sessionId: string;
  provider: ProviderConfigEntry;
  llmConfig: {
    model: string;
    providerName?: string;
    compatProfile?: CompatProfile | null;
    maxInputTokens?: number;
    runtimeMode?: 'agentic' | 'default';
  };
  workspacePath?: string;
  workspaceRoots?: string[];
  workDir: string;
  instructions: Instructions;
  systemPrompt?: string;
  agentName: string;
  agentDescription: string;
  permissionManager: PermissionManager;
  tools?: Tool[];
  /** 模型直调 deferred 工具时当场解锁 (接 ToolTreeEngine.promote) —— 见 kernel resolveDeferredTool。 */
  resolveDeferredTool?: (name: string) => boolean;
  memory?: ShortTermMemory;
  memorySize?: number;
  agentConfig?: AgentConfig;
  contextInjection?: Instructions;
  plannerMode?: boolean;
  structuredOutput?: StructuredOutputDefinition;
  toolInputGuardrails?: ToolInputGuardrail[];
  toolOutputGuardrails?: ToolOutputGuardrail[];
  compressionMode?: 'sync' | 'async';
  compressionThreshold?: number;
  autoCompressEnabled?: boolean;
  platformServices: PlatformServices;
  sessionManager?: DefaultSessionManager;
  sessionEnabled?: boolean;
  disableSystemPrompt?: boolean;
  /** Fine-Grained Tool Streaming */
  enableFGTS?: boolean;
  /** 可选 side-agent 适配器 (toolUseSummary / sessionTitle 等次要 LLM 调用) */
  sideAgentAdapter?: SideAgentAdapter;
}

export interface RuntimeHostCreateResult {
  host: AgentRuntimeHost;
  controls: ProviderControls;
  llmProvider: LLMProvider;
  runner: ReturnType<typeof buildRunner>;
  memory: ShortTermMemory;
}

export async function createAgentRuntimeHost(
  options: RuntimeHostCreateOptions
): Promise<RuntimeHostCreateResult> {
  const {
    sessionId,
    provider,
    llmConfig,
    workspacePath,
    workspaceRoots,
    workDir,
    instructions,
    systemPrompt,
    agentName,
    agentDescription,
    permissionManager,
    tools: providedTools,
    resolveDeferredTool,
    memory: providedMemory,
    memorySize,
    agentConfig,
    contextInjection,
    plannerMode,
    structuredOutput,
    toolInputGuardrails,
    toolOutputGuardrails,
    compressionMode,
    compressionThreshold,
    autoCompressEnabled,
    platformServices,
    sessionManager,
    sessionEnabled,
    disableSystemPrompt,
    enableFGTS,
    sideAgentAdapter,
  } = options;

const memory = providedMemory ?? buildMemory(memorySize);

  const instructionsStr = typeof instructions === 'string' ? instructions : '[Function]';
  cliLogger.info('HOST_FACTORY', `Creating host with instructions length: ${instructionsStr.length}`);
  cliLogger.info('HOST_FACTORY', `instructions contains 协作模式: ${instructionsStr.includes('协作模式')}`);
  cliLogger.info('HOST_FACTORY', `instructions contains delegate_task: ${instructionsStr.includes('delegate_task')}`);
  cliLogger.debug('HOST_FACTORY', `instructions preview: ${instructionsStr.substring(0, 300)}`);

  const { llmProvider, controls, modelProfile } = buildProvider({
    provider,
    model: llmConfig.model,
    sessionId,
    runtimeMode: llmConfig.runtimeMode,
  });

  /* 把当前 session 的 llmProvider + 完整 provider 凭证注入给 webSearch —
   * 原生搜索门控看会话协议; Grok/x.ai Responses 直调需要会话自己的 apiKey/baseUrl
   * (不能回落到 defaultProvider: 默认 DeepSeek + 会话 Grok 会拿错钥). */
  setActiveWebSearchSession(llmProvider, llmConfig.model, provider);

  const compatProfile = llmConfig.compatProfile ?? null;
  const memoryPressure = compatProfile ? new MemoryPressureMonitor(compatProfile) : undefined;
  const tools = providedTools ?? await getTools(workspacePath, platformServices);
  cliLogger.info('HOST_FACTORY', `🔧 Runner tools: provided=${providedTools?.length ?? 'null'} actual=${tools.length} names=[${tools.map(t => t.name).join(', ')}]`);

  const config: AgentConfig = agentConfig ?? {
    maxIterations: 0,
    temperature: 0.7,
  };

  const runner = buildRunner({
    llmProvider,
    model: llmConfig.model,
    tools,
    resolveDeferredTool,
    memory,
    config,
    agentName,
    agentDescription,
    instructions,
    contextInjection,
    plannerMode,
    structuredOutput,
    providerName: llmConfig.providerName,
    contextWindow: compatProfile?.contextWindow,
    tailTokenBudget: compatProfile?.tailTokenBudget,
    maxInputTokensOverride: llmConfig.maxInputTokens,
    toolInputGuardrails,
    toolOutputGuardrails,
    compressionMode,
    compressionThreshold,
    autoCompressEnabled,
    workspacePath,
    workspaceRoots,
    permissionManager,
    disableSystemPrompt,
    enableFGTS,
    modelProfile,
    providerModelNames: (provider as any)?.models?.map((m: any) => m?.name).filter(Boolean),
    sessionId,
  });

  const mgr = sessionManager ?? new DefaultSessionManager();

  let session: PersistedSession | undefined;
  let sessionSync: SessionSyncManager | undefined;

  const syncSystemPrompt = systemPrompt ?? (typeof instructions === 'string' ? instructions : undefined);

  if (sessionEnabled) {
    try {
      session = await mgr.getOrCreateSession(sessionId);
      if (!syncSystemPrompt) {
        cliLogger.warn('HOST_FACTORY',
          `session ${sessionId} 建 SessionSync 时拿不到 systemPrompt (instructions 非字符串?) —— ` +
          `恢复历史时将无法补回身份提示词, 只能靠 runner 侧兜底注入`);
      }
      sessionSync = new SessionSyncManager({
        session,
        memory,
        systemPrompt: syncSystemPrompt,
      });
      cliLogger.info('HOST_FACTORY', `Session ready ${sessionId} (memory pre-seeded by caller, ${memory.getAll().length} messages)`);
    } catch (error: any) {
      cliLogger.error('HOST_FACTORY', `Session init failed (non-blocking): ${error.message}`);
    }
  }

  const host = buildRuntimeHost({
    runner,
    memory,
    sessionManager: mgr,
    runtimeSessionId: sessionId,
    agentName,
    agentDescription,
    configuredToolCount: tools.length,
    registeredToolNames: new Set([
      ...tools.map((tool) => tool.name),
      ...toolPackRegistry.getAll().flatMap((p) => p.toolNames),
    ]),
    sessionEnabled: sessionEnabled ?? false,
    session,
    sessionSync,
    workDir,
    model: llmConfig.model,
    memoryPressure,
    compatProfile,
    systemPrompt: syncSystemPrompt,
    llmProvider,
    sideAgentAdapter,
  });

  return { host, controls, llmProvider, runner, memory };
}
