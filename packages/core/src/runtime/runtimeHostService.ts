import type { LLMProvider } from '@neoxlabs/kernel/types/index.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { DefaultSessionManager } from '../memory/index.js';
import type { ProviderControls } from './runtimeBuilder.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeHost,
  RunTaskResult,
  RuntimeMetadata,
} from './agentRuntimeHost.js';
import type { AgentConfig, Instructions, StructuredOutputDefinition, Tool } from '@neoxlabs/kernel/types/index.js';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { ToolInputGuardrail, ToolOutputGuardrail } from '@neoxlabs/kernel/types/guardrails.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { HostController } from './hostController.js';
import { createAgentRuntimeHost, type RuntimeHostCreateResult } from './hostFactory.js';
import type { SideAgentAdapter } from './sideAgentAdapter.js';

export interface RuntimeHostConfig {
  sessionId: string;
  configKey: string;
  provider: ProviderConfigEntry;
  llmConfig: {
    model: string;
    providerName?: string;
    compatProfile?: CompatProfile | null;
    maxInputTokens?: number;
    runtimeMode?: 'agentic' | 'default';
  };
  workspacePath?: string;
  workDir: string;
  instructions: Instructions;
  systemPrompt?: string;
  agentName: string;
  agentDescription: string;
  permissionManager: PermissionManager;
  tools?: Tool[];
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
  sessionManager?: DefaultSessionManager;
  sessionEnabled?: boolean;
  disableSystemPrompt?: boolean;
  /** Force replace the existing memory system prompt, e.g. after provider/model switch. */
  forceSystemPromptRefresh?: boolean;
  /** Fine-Grained Tool Streaming */
  enableFGTS?: boolean;
  /** Side-query 适配器 (toolUseSummary / sessionTitle) — 由调用方按 session 配置创建 */
  sideAgentAdapter?: SideAgentAdapter;
  onHostCreated?: (payload: {
    host: AgentRuntimeHost;
    controls: ProviderControls;
    llmProvider: LLMProvider;
    runner: RuntimeHostCreateResult['runner'];
    memory: RuntimeHostCreateResult['memory'];
  }) => void;
}

export interface RuntimeHostRunConfig extends RuntimeHostConfig {
  prompt: string;
  metadata?: RuntimeMetadata;
  abortSignal?: AbortSignal;
  onHostReady?: (host: AgentRuntimeHost) => void;
  onEvent?: (event: AgentRuntimeEvent) => void;
}

export class RuntimeHostService {
  private hostController: HostController;
  private platformServices: PlatformServices;

  constructor(options: { platformServices: PlatformServices; hostController?: HostController }) {
    this.platformServices = options.platformServices;
    this.hostController = options.hostController ?? new HostController();
  }

  setWorkspace(workspacePath: string): void {
    this.hostController.setWorkspace(workspacePath);
  }

  getHost(sessionId: string): AgentRuntimeHost | undefined {
    return this.hostController.getHost(sessionId);
  }

  hasHost(sessionId: string): boolean {
    return this.hostController.hasHost(sessionId);
  }

  clearHost(sessionId: string): void {
    this.hostController.clearHost(sessionId);
  }

  clearAll(): void {
    this.hostController.clearAll();
  }

  /** host 被 LRU 淘汰时通知上层, 好把同一会话的其它 per-session 状态一起摘掉。 */
  setEvictListener(fn: (sessionId: string) => void): void {
    this.hostController.setEvictListener(fn);
  }

  /** 当前留着几个 host —— 测试和内存排查用。 */
  hostCount(): number {
    return this.hostController.hostCount();
  }

  forEachHost(callback: (host: AgentRuntimeHost, sessionId: string) => void): void {
    this.hostController.forEachHost(callback);
  }

  async getOrCreateHost(config: RuntimeHostConfig): Promise<AgentRuntimeHost> {
    const {
      sessionId,
      configKey,
      provider,
      llmConfig,
      workspacePath,
      workDir,
      instructions,
      systemPrompt,
      agentName,
      agentDescription,
      permissionManager,
      tools,
      resolveDeferredTool,
      memory,
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
      sessionManager,
      sessionEnabled,
      disableSystemPrompt,
      enableFGTS,
      sideAgentAdapter,
      onHostCreated,
    } = config;

    return this.hostController.getOrCreateHost({
      sessionId,
      configKey,
      createHost: async () => {
        const { host, controls, llmProvider, runner, memory: hostMemory } = await createAgentRuntimeHost({
          sessionId,
          provider,
          llmConfig,
          workspacePath,
          workDir,
          instructions,
          systemPrompt,
          agentName,
          agentDescription,
          permissionManager,
          tools,
          resolveDeferredTool,
          memory,
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
          platformServices: this.platformServices,
          sessionManager,
          sessionEnabled,
          disableSystemPrompt,
          enableFGTS,
          sideAgentAdapter,
        });
        onHostCreated?.({ host, controls, llmProvider, runner, memory: hostMemory });
        return host;
      },
    });
  }

  async runTask(config: RuntimeHostRunConfig): Promise<RunTaskResult> {
    const { prompt, metadata, abortSignal, onHostReady, onEvent, ...hostConfig } = config;
    const host = await this.getOrCreateHost(hostConfig);

    // Host 可能被复用（configKey 缓存），但 chat() 每次都重新构建了 enhancedPrompt
    // （包含最新的 personality/ActionLog/ProjectMemory）
    // 默认不修改 memory 中已有的 system message（保持 KV cache prefix 稳定）
    // 但切换 provider/model 时必须强制替换，否则新模型会继续收到旧模型身份 prompt。
    // 只在 system message 缺失时（compact/clear 后），Runner 会用最新 instructions 重新注入
    const latestSystemPrompt = hostConfig.systemPrompt
      || (typeof hostConfig.instructions === 'string' ? hostConfig.instructions : undefined);
    if (latestSystemPrompt) {
      host.refreshInstructions(latestSystemPrompt, {
        forceMemorySystemPrompt: hostConfig.forceSystemPromptRefresh === true,
      });
    }

    onHostReady?.(host);

    // Host is reused across chat() calls (getOrCreateHost caches by configKey).
    // If a previous listener wasn't properly cleaned up (e.g. due to error paths),
    // it accumulates → every event gets dispatched to N listeners → text duplication.
    const listenersBefore = host.listenerCount?.() ?? 0;
    if (listenersBefore > 0 && onEvent) {
      cliLogger.warn('HOST_SERVICE', `⚠️ Host has ${listenersBefore} stale listeners before runTask, clearing them`);
      host.removeAllListeners?.();
    }

    const unsubscribe = onEvent ? host.on(onEvent) : undefined;
    try {
      return await host.runTask(prompt, { metadata, abortSignal });
    } finally {
      if (unsubscribe) {
        unsubscribe();
      }
    }
  }
}
