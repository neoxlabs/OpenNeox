import type { Message } from '../types/index.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import type { CompatProfile } from '../types/compat.js';

export type MemoryPressureState = 'unknown' | 'normal' | 'warn' | 'soft_limit' | 'limit';

export interface MemoryPressureSnapshot {
  profile: CompatProfile;
  tokensUsed: number;
  promptTokens: number;
  promptTokensIsActual?: boolean;
  completionTokens: number;
  messageCount?: number;
  pressure?: number;
  state: MemoryPressureState;
  timestamp: number;
}

const STATE_RANK: Record<MemoryPressureState, number> = {
  unknown: 0,
  normal: 1,
  warn: 2,
  soft_limit: 3,
  limit: 4,
};

import { estimateTokens } from '../utils/tokenEstimate.js';
function roughTokenEstimate(text: string | null | undefined): number {
  if (!text) return 0;
  const normalized = text.trim();
  if (!normalized.length) return 0;
  return estimateTokens(normalized);
}

export const IMAGE_TOKEN_ESTIMATE = 1200;

function countImageParts(message: Message): number {
  const c = message.content;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const part of c) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'image_url') n += 1;
  }
  return n;
}

export function estimateTokensForMessage(message: Message): number {
  const contentText = getTextFromContent(message.content);
  const contentTokens = roughTokenEstimate(contentText);
  const imageTokens = countImageParts(message) * IMAGE_TOKEN_ESTIMATE;
  const toolTokens = message.tool_calls?.length
    ? roughTokenEstimate(JSON.stringify(message.tool_calls))
    : 0;
  return contentTokens + imageTokens + toolTokens;
}

export function estimateTokensFromMessages(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateTokensForMessage(message), 0);
}

export interface TokenBreakdown {
  systemTokens: number;      // system 消息
  userTokens: number;        // user 消息
  assistantTokens: number;   // assistant 消息（不含 tool_calls）
  toolCallTokens: number;    // tool_calls 定义
  toolResultTokens: number;  // tool 结果
  totalTokens: number;
}

export function calculateTokenBreakdown(messages: Message[]): TokenBreakdown {
  const breakdown: TokenBreakdown = {
    systemTokens: 0,
    userTokens: 0,
    assistantTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    totalTokens: 0,
  };

  for (const msg of messages) {
    const contentText = getTextFromContent(msg.content);
    const contentTokens =
      roughTokenEstimate(contentText) + countImageParts(msg) * IMAGE_TOKEN_ESTIMATE;
    const toolCallsTokens = msg.tool_calls?.length
      ? roughTokenEstimate(JSON.stringify(msg.tool_calls))
      : 0;

    switch (msg.role) {
      case 'system':
        breakdown.systemTokens += contentTokens;
        break;
      case 'user':
        breakdown.userTokens += contentTokens;
        break;
      case 'assistant':
        breakdown.assistantTokens += contentTokens;
        breakdown.toolCallTokens += toolCallsTokens;
        break;
      case 'tool':
        breakdown.toolResultTokens += contentTokens;
        break;
      default:
        // 其他角色归入 user
        breakdown.userTokens += contentTokens + toolCallsTokens;
    }
  }

  breakdown.totalTokens =
    breakdown.systemTokens +
    breakdown.userTokens +
    breakdown.assistantTokens +
    breakdown.toolCallTokens +
    breakdown.toolResultTokens;

  return breakdown;
}

function determineState(
  profile: CompatProfile,
  tokensUsed: number,
  pressure?: number
): MemoryPressureState {
  if (!profile.contextWindow && !profile.autoCompactLimit) {
    return 'unknown';
  }
  if (profile.autoCompactLimit && tokensUsed >= profile.autoCompactLimit) {
    return 'limit';
  }
  if (pressure === undefined || profile.contextWindow === undefined) {
    return 'unknown';
  }
  if (pressure >= profile.warnThresholds.hard) {
    return 'limit';
  }
  if (pressure >= profile.warnThresholds.soft) {
    return 'soft_limit';
  }
  if (pressure >= profile.warnThresholds.warn) {
    return 'warn';
  }
  return 'normal';
}

export class MemoryPressureMonitor {
  private profile: CompatProfile;
  private promptTokensActual = 0;
  private completionTokensActual = 0;
  private promptTokensEstimate = 0;
  private completionTokensEstimate = 0;

  constructor(profile: CompatProfile) {
    this.profile = profile;
  }

  updateProfile(profile: CompatProfile): void {
    this.profile = profile;
    this.reset();
  }

  reset(): void {
    this.promptTokensActual = 0;
    this.completionTokensActual = 0;
    this.promptTokensEstimate = 0;
    this.completionTokensEstimate = 0;
  }

  setPromptEstimateFromMessages(messages: Message[], forceEstimate = false): MemoryPressureSnapshot {
    // 场景: iteration 2 开始时，memory 已包含 tool results，但还没有新的 API usage
    // 此时应该用新的估算值（更大），而不是继续显示 iteration 1 的旧实际值
    if (!forceEstimate && this.promptTokensActual > 0) {
      // 已有实际值且不强制重估，只更新估算的 completion tokens
      this.completionTokensEstimate = 0;
      return this.getSnapshot();
    }
    // 强制重估 or 第一次估算
    this.promptTokensEstimate = estimateTokensFromMessages(messages);
    // 如果估算值 < 实际值，保留实际值（API 更准确）
    if (this.promptTokensActual > 0 && this.promptTokensEstimate <= this.promptTokensActual) {
      return this.getSnapshot();
    }
    // 用估算值覆盖（memory 增长了）
    this.promptTokensActual = 0;
    this.completionTokensActual = 0;
    this.completionTokensEstimate = 0;
    return this.getSnapshot();
  }

  addEstimatedOutputTokens(tokens: number): MemoryPressureSnapshot {
    this.completionTokensEstimate = Math.max(0, this.completionTokensEstimate + tokens);
    return this.getSnapshot();
  }

  recordActualUsage(promptTokens: number, completionTokens: number, messageCount?: number): MemoryPressureSnapshot {
    this.promptTokensActual = promptTokens;
    this.completionTokensActual = completionTokens;
    this.promptTokensEstimate = 0;
    this.completionTokensEstimate = 0;
    return this.getSnapshot(messageCount);
  }

  getSnapshot(messageCount?: number): MemoryPressureSnapshot {
    const promptTokens = this.promptTokensActual || this.promptTokensEstimate;
    const completionTokens = this.completionTokensActual + this.completionTokensEstimate;
    const tokensUsed = promptTokens + completionTokens;
    const pressure = this.profile.contextWindow
      ? tokensUsed / this.profile.contextWindow
      : undefined;
    const state = determineState(this.profile, tokensUsed, pressure);

    return {
      profile: this.profile,
      tokensUsed,
      promptTokens,
      promptTokensIsActual: this.promptTokensActual > 0,
      completionTokens,
      messageCount,
      pressure,
      state,
      timestamp: Date.now(),
    };
  }

  getStateRank(state: MemoryPressureState): number {
    return STATE_RANK[state];
  }

  estimateMessagesForDisplay(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  recordCalibration(
    estimatedTokens: number,
    actualInputTokens: number,
    actualCacheReadTokens: number
  ): void {
    // 在V1中暂不实现校准逻辑
    // V2版本会有完整的校准机制
    if (process.env.CLI_DEBUG) {
      const actualTotal = actualInputTokens + actualCacheReadTokens;
      const ratio = estimatedTokens > 0 ? actualTotal / estimatedTokens : 0;
      console.log(`[MemoryPressure] 校准: 估算=${estimatedTokens}, 实际=${actualTotal}, 比率=${ratio.toFixed(3)}`);
    }
  }
}
