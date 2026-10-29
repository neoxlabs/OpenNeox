import type { Message } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import {
  calculateTokenBreakdown,
  type MemoryPressureSnapshot,
} from '@neoxlabs/kernel/compat/memoryPressure.js';

export type ContextBreakdown = {
  systemTokens?: number;
  userTokens?: number;
  assistantTokens?: number;
  toolCallTokens?: number;
  toolResultTokens?: number;
  toolTokens?: number;
  messageTokens?: number;
  totalTokens?: number;
};

export function buildDefaultContextExtrasFromMain(params: {
  compatProfile: any;
  overrides?: any;
}): any {
  // 否则 StatusLine 会显示 "context: --"
  if (!params.compatProfile) {
    return {
      contextWindow: 200000, // 默认值
      tokensUsedForContext: params.overrides?.tokensUsedForContext ?? 0,
      pressure: params.overrides?.pressure ?? 0,
      warningLevel: params.overrides?.warningLevel ?? 'normal',
      ...params.overrides,
    };
  }
  return {
    contextWindow: params.compatProfile.contextWindow,
    autoCompactLimit: params.compatProfile.autoCompactLimit,
    tokensUsedForContext: params.overrides?.tokensUsedForContext ?? 0,
    pressure: params.overrides?.pressure ?? 0,
    warningLevel: params.overrides?.warningLevel ?? 'normal',
  };
}

export function updateContextWindowDisplayFromMain(params: {
  uiController: any;
  compatProfile: any;
  buildDefaultContextExtras: (overrides?: any) => any;
}): void {
  cliLogger.info('DEBUG_CTX', `updateContextWindowDisplay called, uiController=${!!params.uiController}, compatProfile=${!!params.compatProfile}, compatProfile.contextWindow=${params.compatProfile?.contextWindow}`);
  if (!params.uiController) {
    cliLogger.info('DEBUG_CTX', `updateContextWindowDisplay: uiController is null, returning`);
    return;
  }

  // 初始状态也应该显示 "context 0/200K (0%)"，而不是 "context: --"
  const extras = params.buildDefaultContextExtras();
  cliLogger.info('DEBUG_CTX', `updateContextWindowDisplay: extras.contextWindow=${extras?.contextWindow}`);
  if (!extras) {
    return;
  }

  // Get current token stats and update with extras
  const stats = params.uiController.getTokenStats();
  cliLogger.info('DEBUG_CTX', `updateContextWindowDisplay: calling setTokenStats with contextWindow=${extras.contextWindow}`);
  params.uiController.setTokenStats(0, 0, extras);
}

export function calculateContextBreakdownFromMain(params: {
  memory: any;
  snapshot?: MemoryPressureSnapshot;
}): ContextBreakdown {
  let messages: Message[] = [];

  if (params.memory) {
    messages = params.memory.getAll();
    cliLogger.debug('BREAKDOWN', `calculateContextBreakdown: Memory has ${messages.length} messages`);
    cliLogger.debug('BREAKDOWN', `  Message roles: ${messages.map(m => m.role).join(' -> ')}`);
  }

  // 因为 system prompt 还没有被发送到 API，不应该计入 context
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  if (nonSystemMessages.length === 0) {
    cliLogger.debug('BREAKDOWN', `Only system message(s) found, returning zeros (initial state)`);
    return {
      systemTokens: 0,
      userTokens: 0,
      assistantTokens: 0,
      toolCallTokens: 0,
      toolResultTokens: 0,
      toolTokens: 0,
      messageTokens: 0,
      totalTokens: 0,
    };
  }

  if (messages.length > 0) {
    const breakdown = calculateTokenBreakdown(messages);

    // promptTokens = messages tokens + tools definitions tokens
    let toolsDefinitionsTokens = 0;
    if (params.snapshot && params.snapshot.promptTokens > 0) {
      toolsDefinitionsTokens = Math.max(0, params.snapshot.promptTokens - breakdown.totalTokens);
      cliLogger.debug('BREAKDOWN', `Tools definitions tokens: ${toolsDefinitionsTokens} (= ${params.snapshot.promptTokens} - ${breakdown.totalTokens})`);
    }

    cliLogger.debug('BREAKDOWN', `Calculated breakdown (total=${breakdown.totalTokens}):`, {
      systemTokens: breakdown.systemTokens,
      userTokens: breakdown.userTokens,
      assistantTokens: breakdown.assistantTokens,
      toolCallTokens: breakdown.toolCallTokens,
      toolResultTokens: breakdown.toolResultTokens,
      toolsDefinitionsTokens,
    });

    return {
      systemTokens: breakdown.systemTokens + toolsDefinitionsTokens,
      userTokens: breakdown.userTokens,
      assistantTokens: breakdown.assistantTokens,
      toolCallTokens: breakdown.toolCallTokens,
      toolResultTokens: breakdown.toolResultTokens,
      // Legacy fields for backward compatibility
      toolTokens: breakdown.toolCallTokens + breakdown.toolResultTokens,
      messageTokens: breakdown.userTokens + breakdown.assistantTokens,
      totalTokens: breakdown.totalTokens + toolsDefinitionsTokens,
    };
  }

  // 如果没有消息，直接返回空（全部为0）
  if (process.env.CLI_DEBUG) {
    cliLogger.debug('BREAKDOWN', `No messages found in Memory, returning empty breakdown (no fallback)`);
  }
  return {};
}
