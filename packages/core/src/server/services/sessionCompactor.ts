import type { AgentRunMode } from '../../runtime/modeFactory.js';
import type { AgenticRuntime } from '../../runtime/agenticRuntime.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface CompactSessionOptions {
  sessionId: string;
  currentMode: AgentRunMode;
  singleRuntime: AgenticRuntime | null;
  assistantRuntime?: null;
  /** 把 host 在 compact 过程里 emit 的事件 (compacting 进度 / context_compaction 结果)
   *  转给 caller — 通常是 bus.publish, 让 UI 看到压缩卡片. 不传时 host 事件直接丢弃. */
  onEvent?: (event: any) => void;
  modelOverride?: string;
}

export async function compactSession(options: CompactSessionOptions): Promise<void> {
  const { sessionId, currentMode, singleRuntime, onEvent, modelOverride } = options;
  cliLogger.info('SERVER', `Compact session requested: ${sessionId}, mode=${currentMode}, model=${modelOverride || '(none)'}`);

  /* assistant 模式已移除 —— 只压缩 agentic single runtime。 */
  if (!singleRuntime) {
    throw new Error('Single runtime is not available for compaction.');
  }

  await singleRuntime.compactSession(sessionId, onEvent, modelOverride);
}
