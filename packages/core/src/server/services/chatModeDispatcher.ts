import type { RuntimeMetadata } from '../../runtime/runtimeTypes.js';
import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import type { AgenticChatHandlers } from '../../runtime/agenticRuntime.js';
import type { AgentRunMode } from '../../runtime/modeFactory.js';

interface ChatModeDispatcherOptions {
  /** 仅 'agentic' (assistant 模式已移除); 保留入参兼容调用方。 */
  currentMode: AgentRunMode;
  sessionId: string;
  prompt: string;
  isRetry?: boolean;
  isContinue?: boolean;
  isResume?: boolean;
  metadata?: RuntimeMetadata;
  singleHandlers?: AgenticChatHandlers;
  singleRuntime: AgenticRuntime | null;
  assistantRuntime?: null;
  /** 暂停/中断 — server.bridge.chat 创建的 AC, abort 时整条 chat 链路都立刻断 */
  abortSignal?: AbortSignal;
  /** 多根工作区: 本工作区全部项目根, 透传给 runtime 让 agent 在 env 段感知。缺省/单根无影响。 */
  workspaceRoots?: string[];
  /** 会话级工作区 — 会话所属项目根 (desktop 每条消息带), runtime 优先于全局 workDir 使用。 */
  workspacePath?: string;
  agentMode?: string;
  /** 聊天模式 —— 精简 prompt, 不带工具 */
  chatMode?: boolean;
}

export async function dispatchChatByMode(options: ChatModeDispatcherOptions): Promise<void> {
  const {
    sessionId,
    prompt,
    metadata,
    singleHandlers,
    singleRuntime,
    abortSignal,
    workspaceRoots,
    workspacePath,
    agentMode,
    chatMode,
  } = options;

  /* assistant 模式已移除 —— 只走 agentic single runtime。 */
  if (!singleRuntime) throw new Error('Single runtime is not available.');
  /* Phase 2.6: metadata.effortLevel 已经由 sendPrompt 注入到 metadata,
   *   一路透传到 agenticRuntime → orchestrator.runSession → host.runTask → runner.run.
   *   这里不动 metadata. */
  await singleRuntime.chat({
    sessionId,
    prompt,
    isRetry: options.isRetry,
    isContinue: options.isContinue,
    isResume: options.isResume,
    metadata,
    providerId: (metadata as any)?.providerId,
    modelName: (metadata as any)?.modelName,
    abortSignal,
    workspaceRoots,
    workspacePath,
    agentMode,
    chatMode,
  }, singleHandlers);
}
