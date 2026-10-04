import type { CompletionProfile } from '../profiles/index.js';
import { cliLogger } from '../platform/cliLogger.js';
import type { RawResponseStreamEvent } from '../types/index.js';
import { buildEvidenceRequiredPrompt } from './runnerHintUtils.js';
import { detectNoToolGuardReason, getNoToolGuardMeta } from './runnerNoToolGuardUtils.js';
import { getXmlFragmentRepairAction } from './runnerRepairUtils.js';
import type { RepairTracker } from './toolCallRepair.js';

type MemoryLike = {
  add: (message: { role: 'assistant' | 'user'; content: string }) => void;
  appendReminder: (text: string) => void;
};

export type NoToolContinuationReason =
  | 'none'
  | 'tool_call_text_leak'
  | 'intermediate_progress_text'
  | 'continuation_intent_detected'
  | 'xml_fragment_repair';

export function handleNoToolGuardAndRepair(options: {
  fullContent: string;
  completionProfile: CompletionProfile;
  registeredToolNames: string[];
  finishReason?: string;
  textOnlyStreakCount: number;
  totalToolCalls: number;
  modelProfileId?: string;
  repairTracker: RepairTracker;
  iteration: number;
  memory: MemoryLike;
}): {
  shouldContinue: boolean;
  textOnlyStreakCount: number;
  reason: NoToolContinuationReason;
  event?: RawResponseStreamEvent;
} {
  const noToolGuardReason = detectNoToolGuardReason({
    fullContent: options.fullContent,
    completionProfile: options.completionProfile,
    toolNames: options.registeredToolNames,
    finishReason: options.finishReason,
    textOnlyStreakCount: options.textOnlyStreakCount,
    totalToolCalls: options.totalToolCalls,
    onContinuationDetected: (preview, length) => {
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('CONTINUATION_INTENT', 'Blocked short text after tools', {
          preview,
          length,
          totalToolCalls: options.totalToolCalls,
        });
      }
    },
  });

  const noToolGuardMeta = getNoToolGuardMeta(noToolGuardReason);
  if (noToolGuardMeta) {
    const nextStreak = noToolGuardMeta.incrementStreak
      ? options.textOnlyStreakCount + 1
      : options.textOnlyStreakCount;
    const warnPayload: Record<string, any> = {
      profile: options.modelProfileId,
      preview: options.fullContent.slice(0, noToolGuardMeta.reason === 'tool_call_text_leak' ? 240 : 200),
    };
    if (noToolGuardMeta.includeStreak) {
      warnPayload.streak = nextStreak;
    }
    if (noToolGuardMeta.includeTotalToolCalls) {
      warnPayload.totalToolCalls = options.totalToolCalls;
    }
    cliLogger.warn(noToolGuardMeta.logTag, noToolGuardMeta.logMessage, warnPayload);
    //  前缀缓存补漏 : 原 role:'system' 注入会被 anthropic adapter 合并进
    // 顶层 system 块打穿整条 KV cache — 改顺序尾部追加, 与本文件下方 xml repair 路径一致
    options.memory.appendReminder(buildEvidenceRequiredPrompt(noToolGuardMeta.promptReason));
    return {
      shouldContinue: true,
      textOnlyStreakCount: nextStreak,
      reason: noToolGuardMeta.reason,
    };
  }

  const xmlRepairAction = getXmlFragmentRepairAction({
    fullContent: options.fullContent,
    repairTracker: options.repairTracker,
    iteration: options.iteration,
  });
  if (!xmlRepairAction) {
    return {
      shouldContinue: false,
      textOnlyStreakCount: options.textOnlyStreakCount,
      reason: 'none',
    };
  }

  cliLogger.warn('RUNNER', '🔧 Malformed tool call detected in text output', {
    pattern: xmlRepairAction.pattern,
    contentPreview: xmlRepairAction.contentPreview,
    iteration: xmlRepairAction.iteration,
    repairAttempt: xmlRepairAction.repairAttempt,
  });
  options.memory.add({ role: 'assistant', content: xmlRepairAction.assistantContent });
  //  前缀缓存根治: 顺序追加到尾部, 不进顶层 system 块 (见 runnerAdvisoryUtils 说明)
  options.memory.appendReminder(xmlRepairAction.systemPrompt);
  return {
    shouldContinue: true,
    textOnlyStreakCount: options.textOnlyStreakCount,
    reason: 'xml_fragment_repair',
    event: xmlRepairAction.event,
  };
}
