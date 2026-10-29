import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export function pushTokenStatsFromMain(params: {
  uiController: any;
  inputTokens: number;
  outputTokens: number;
  snapshot?: any;
  cacheStats?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    contextTokens?: number;
  };
  compatProfile: any;
  calculateContextBreakdown: (snapshot?: any) => any;
  buildDefaultContextExtras: (overrides?: any) => any;
}): void {
  if (!params.uiController) {
    return;
  }

  const currentStats = params.uiController.getTokenStats();
  const contextBreakdown = params.calculateContextBreakdown(params.snapshot);
  const actualPromptTokens = params.snapshot?.promptTokens || 0;

  if (process.env.CLI_DEBUG) {
    cliLogger.debug(
      'MAIN',
      `pushTokenStats: input=${params.inputTokens}, output=${params.outputTokens}, contextTokens=${params.cacheStats?.contextTokens}, cacheRead=${params.cacheStats?.cacheReadTokens}, cacheWrite=${params.cacheStats?.cacheWriteTokens}`,
    );
  }

  let scaledBreakdown = contextBreakdown;
  if (actualPromptTokens > 0 && (contextBreakdown.totalTokens ?? 0) > 0) {
    const scale = actualPromptTokens / (contextBreakdown.totalTokens ?? 1);
    scaledBreakdown = {
      systemTokens: Math.round((contextBreakdown.systemTokens ?? 0) * scale),
      userTokens: Math.round((contextBreakdown.userTokens ?? 0) * scale),
      assistantTokens: Math.round((contextBreakdown.assistantTokens ?? 0) * scale),
      toolCallTokens: Math.round((contextBreakdown.toolCallTokens ?? 0) * scale),
      toolResultTokens: Math.round((contextBreakdown.toolResultTokens ?? 0) * scale),
      toolTokens: Math.round(((contextBreakdown.toolCallTokens ?? 0) + (contextBreakdown.toolResultTokens ?? 0)) * scale),
      messageTokens: Math.round(((contextBreakdown.userTokens ?? 0) + (contextBreakdown.assistantTokens ?? 0)) * scale),
      totalTokens: actualPromptTokens,
    };
  }

  const extras = params.snapshot
    ? {
      contextWindow: params.snapshot.profile?.contextWindow || params.compatProfile?.contextWindow || 200000,
      autoCompactLimit: params.snapshot.profile?.autoCompactLimit,
      pressure: params.snapshot.pressure,
      warningLevel: params.snapshot.state,
      tokensUsedForContext: params.cacheStats?.contextTokens || actualPromptTokens,
      messageCount: params.snapshot.messageCount,
      ...scaledBreakdown,
    }
    : {
      ...params.buildDefaultContextExtras({
        tokensUsedForContext: currentStats.tokensUsedForContext ?? 0,
        pressure: currentStats.pressure ?? 0,
        warningLevel: currentStats.warningLevel ?? 'normal',
        messageCount: currentStats.messageCount,
      }),
      ...contextBreakdown,
    };

  const mergedExtras = {
    ...extras,
    ...(params.cacheStats && {
      cacheReadTokens: params.cacheStats.cacheReadTokens,
      cacheWriteTokens: params.cacheStats.cacheWriteTokens,
      contextTokens: params.cacheStats.contextTokens,
    }),
  };

  if (process.env.CLI_DEBUG) {
    cliLogger.debug(
      'MAIN',
      `pushTokenStats -> setTokenStats: input=${params.inputTokens}, ctx=${mergedExtras.tokensUsedForContext}, cacheRead=${mergedExtras.cacheReadTokens}`,
    );
  }
  params.uiController.setTokenStats(params.inputTokens, params.outputTokens, mergedExtras);
}
