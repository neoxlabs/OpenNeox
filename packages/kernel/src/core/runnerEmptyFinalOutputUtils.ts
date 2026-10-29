import { cliLogger } from '../platform/cliLogger.js';
import type { RawResponseStreamEvent } from '../types/index.js';
import { buildEmptyFinalOutputRecoveryEvent } from './runnerEventBuilders.js';
import { buildEvidenceRequiredPrompt } from './runnerHintUtils.js';

/* 前缀缓存补漏: 空输出恢复提示原以 role:'system' 注入 — anthropic adapter
 * 会把所有 system 消息合并进顶层 system 块, cache_control 锚在该块, 注入一次整条
 * KV cache 全塌 (与 已修复的 EFFICIENCY TIP / PROGRESS GATE 同一类 bug)。
 * 改走 appendReminder: 顺序追加到对话尾部, 不进 system 块, 缓存无损。 */
type MemoryLike = {
  appendReminder: (text: string) => void;
};

export function handleEmptyFinalOutputRecovery(options: {
  fullContent: string;
  finishReason?: string;
  textOnlyStreakCount: number;
  totalToolCalls: number;
  modelProfileId?: string;
  memory: MemoryLike;
}): {
  shouldContinue: boolean;
  textOnlyStreakCount: number;
  event?: RawResponseStreamEvent;
} {
  if (
    options.fullContent.trim()
    || options.textOnlyStreakCount >= 2
  ) {
    return {
      shouldContinue: false,
      textOnlyStreakCount: options.textOnlyStreakCount,
    };
  }

  const nextStreak = options.textOnlyStreakCount + 1;
  cliLogger.warn('EMPTY_STOP', `Blocked empty final output (totalToolCalls=${options.totalToolCalls})`, {
    profile: options.modelProfileId,
    finishReason: options.finishReason,
    streak: nextStreak,
    totalToolCalls: options.totalToolCalls,
  });
  options.memory.appendReminder(buildEvidenceRequiredPrompt('empty_final_output'));

  return {
    shouldContinue: true,
    textOnlyStreakCount: nextStreak,
    event: buildEmptyFinalOutputRecoveryEvent({
      finishReason: options.finishReason,
      streak: nextStreak,
      totalToolCalls: options.totalToolCalls,
    }),
  };
}
