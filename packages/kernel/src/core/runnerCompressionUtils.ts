import type { BatchCompressionResult, UnifiedCompressor } from '../utils/compression/index.js';
import type { Message } from '../types/index.js';
import { estimateTokensFromMessages } from '../compat/memoryPressure.js';
import { estimateTokens } from '../utils/tokenEstimate.js';
// MicroCompact：工具结果去重与时间衰减。
import { microCompact } from './microCompact.js';
// Context Collapse：分层折叠。
import { contextCollapse } from './contextCollapse.js';
// Post-compact 上下文重注入。
import { generatePostCompactReinjectMessages, runPostCompactCleanup } from './postCompactReinject.js';

/**
 * 回灌预算按窗口比例计算，并设置上下限。
 *
 * 预算过大会让小窗口在压缩后立即再次触发；预算过小则无法恢复关键信息。
 * 未完成状态不占用这份预算，始终回灌。
 */
// Auto-compact 熔断与递归保护。
import {
  shouldAutoCompact,
  shouldManualCompact,
  acquireCompactLock,
  recordCompactSuccess,
  recordCompactFailure,
  releaseCompactLock,
  resolveTokenScale,
  resolveCompactionPlan,
  MAX_SUMMARY_ROUNDS,
  MIN_ROUND_GAIN_RATIO,
  REINJECT_BUDGET_TOKENS,
  recordCompactSkip,
  clearCompactSkip,
  isCompactionInProgress,
  waitForCompactionIdle,
} from './autoCompactGuard.js';

/** 手动 /compact 撞上正在进行的压缩时最多等多久 (摘要一次几十秒, 慢模型 + 重试能到两三分钟) */
const MANUAL_WAIT_FOR_RUNNING_MS = 5 * 60_000;
import { widenKeepStartForPairedBlocks } from './toolPairPreserver.js';
import { dumpCompactionQualityIfEnabled } from '../utils/compactionQualityLog.js';
import {
  hasEnoughToSummarize,
  isContextOverflowError,
  isUsableSummary,
  rebuildAfterSummary,
  rebuildWithSpeculativeSummary,
  messagesFingerprint,
} from './cachedSummaryCompaction.js';
import { takeUtf16SafeTail, truncateUtf16Safe } from '../utils/wireText.js';

type RunnerMemoryLike = {
  getMessagesForLLM: () => any[];
  setMessages: (messages: any[]) => void;
};

/**
 * Snip 层：裁剪过长的单条 tool result。
 * 在完整压缩之前先做轻量裁剪，避免单条超大消息浪费 budget
 */
export function snipOversizedToolResults(
  messages: any[],
  maxResultChars: number = 50_000,
  logInfo: (message: string) => void,
): { messages: any[]; snippedCount: number; freedTokens: number } {
  let snippedCount = 0;
  let freedTokens = 0;

  const processed = messages.map(msg => {
    /* user 消息也要裁 —— 用户贴 146KB 日志(≈40K tokens)单条就能超过整个
     * 窗口, 而摘要层的 head/tail 保护会把它整条保留 → 压缩在数学上不可能压进预算,
     * UI 挂出"上下文 134%, 必须 /compact"而 /compact 同样无解, 死循环。
     * user 阈值放宽 (1.6x): 用户亲手给的内容, 只在真正巨大时才动。多模态(数组 content)跳过。 */
    const isSnippableRole = msg.role === 'tool' || msg.role === 'function' || msg.role === 'user';
    if (!isSnippableRole) return msg;
    const roleLimit = msg.role === 'user' ? Math.floor(maxResultChars * 1.6) : maxResultChars;

    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length <= roleLimit) return msg;

    // 保留头尾各 25%(按该 role 的阈值算)，中间用摘要替代
    // UTF-16 safe: 不在 emoji surrogate 对中间切断 (否则严格 JSON API 400)
    const keepChars = Math.floor(roleLimit * 0.25);
    const head = truncateUtf16Safe(content, keepChars);
    const tail = takeUtf16SafeTail(content, keepChars);
    const omittedLines = content.slice(head.length, content.length - tail.length).split('\n').length;
    const omittedChars = content.length - head.length - tail.length;
    const snipped = `${head}\n\n[... snipped ${omittedLines} lines, ${omittedChars} chars ...]\n\n${tail}`;

    snippedCount++;
    /* 使用语言感知的 token 估算，确保裁剪收益用于下一次压缩预算。 */
    freedTokens += estimateTokens(content) - estimateTokens(snipped);

    return { ...msg, content: snipped };
  });

  if (snippedCount > 0) {
    logInfo(`[Snip] 裁剪 ${snippedCount} 条超长 tool result (释放约 ${(freedTokens / 1000).toFixed(1)}K tokens)`);
  }

  return { messages: processed, snippedCount, freedTokens };
}

/**
 * 压缩主链
 * ═══════════════════════════════════════════════════════════════════════════
 * 压缩包含两种动作和一个收敛循环:
 *   light  (轻量线, 窗口 60%): 只做无损节约 —— 重复工具结果去重 / 超长结果裁头尾。
 *                              不烧 LLM, 不动最近内容。
 *   full   (触发线):           进摘要收敛循环, 一轮不够就收紧保护区再摘, 直到落到目标。
 *
 * 目标落点由固定前缀、摘要、回灌和尾部保护组成，与窗口大小无关。
 */
export async function compressContextWindow(options: {
  maxInputTokens?: number;
  contextWindow?: number;
  iteration: number;
  memory: RunnerMemoryLike;
  unifiedCompressor: UnifiedCompressor;
  compressionMode: 'sync' | 'async';
  model?: string;
  sessionId?: string;
  /**
   * auto = 到水位自动压; recovery = 溢出恢复; manual = 用户 /compact。
   * manual 跟 Claude Code / Codex 一样: 有对话就压, 一次请求摘要整段 (见下面主路径)。
   */
  trigger?: 'auto' | 'recovery' | 'manual';
  querySource?: string;
  /** 'light' = 只跑无损层 (轻量线); 'full' = 摘要收敛 (触发线/手动) */
  mode?: 'light' | 'full';
  /** 时间衰减轮数（0 = 不启用）。 */
  maxTurnAge?: number;
  /** 用户显式配的 compressionThreshold (0..1) — 只作用于**触发线**, 落点不再受它影响 */
  overrideRatio?: number;
  /** token 校准配对 (runner 从 provider prompt_tokens 获取)。 */
  tokenCalibration?: { measured: number; estimateAtMeasurement: number };
  /** 会话内固定前缀样本；没有样本时使用兜底值。 */
  fixedOverheadSample?: number;
  logInfo: (message: string) => void;
  logDebug: (message: string) => void;
  /** LLM 摘要压缩进度回调 */
  onCompressionProgress?: (progress: import('../utils/compression/llmSummarizer.js').CompressionProgress) => void;
  /**
   * Summarize on the conversation's own cached prefix (see cachedSummaryCompaction.ts) and
   * return the summary text. When given, this is the compaction; the per-category summaries
   * below only run when the conversation no longer fits the window (recovery / overflow).
   */
  summarizeOnCachedPrefix?: (
    onProgress?: (p: import('./cachedSummaryCompaction.js').SummaryStreamProgress) => void,
  ) => Promise<string>;
  speculativeSummary?: () => Promise<{ summary: string; upTo: number; fingerprint: string } | null>;
}): Promise<BatchCompressionResult | null> {
  const {
    maxInputTokens,
    contextWindow,
    iteration,
    memory,
    unifiedCompressor,
    compressionMode,
    model,
    sessionId,
    trigger = 'auto',
    mode = 'full',
    onCompressionProgress,
    querySource,
    maxTurnAge = 0,
    overrideRatio,
    logInfo,
    logDebug,
    tokenCalibration,
    fixedOverheadSample,
    summarizeOnCachedPrefix,
    speculativeSummary,
  } = options;

  clearCompactSkip();
  if (!maxInputTokens && !contextWindow) {
    recordCompactSkip('other', 'no context window / input budget for this model');
    return null;
  }

  /* 手动 /compact 撞上正在跑的压缩 (自动压缩 / 用户连按): 等它跑完, 不直接回空。
   * 等到了也不再压第二遍 —— 刚压完的上下文再摘一次只会"未获收益"; 告诉用户上一次已经压了。 */
  if (trigger !== 'auto' && isCompactionInProgress()) {
    logInfo('[ManualCompact] another compaction is running — waiting for it');
    const idle = await waitForCompactionIdle(MANUAL_WAIT_FOR_RUNNING_MS);
    recordCompactSkip('busy', idle
      ? 'another compaction was running and has just finished'
      : `another compaction is still running after ${Math.round(MANUAL_WAIT_FOR_RUNNING_MS / 60_000)} min`);
    return null;
  }

  const scale = resolveTokenScale(
    tokenCalibration?.measured ?? 0,
    tokenCalibration?.estimateAtMeasurement ?? 0,
    fixedOverheadSample,
  );
  const plan = resolveCompactionPlan({ contextWindow, maxInputTokens, overrideRatio, scale });

  /* 熔断/递归/阈值守卫 —— 只管摘要压缩。轻量层不烧 API, 没有熔断的理由,
   * 只需要递归锁防止压缩查询自身再触发。 */
  if (mode === 'full' && contextWindow) {
    const guardMessages = memory.getMessagesForLLM();
    const guardTokens = scale.toReal(estimateTokensFromMessages(guardMessages));
    const guard = trigger !== 'auto'
      ? shouldManualCompact(guardTokens)
      : shouldAutoCompact(guardTokens, contextWindow, querySource, overrideRatio);
    if (!guard.should) {
      logDebug(`[AutoCompact] Skipped: ${guard.reason}`);
      recordCompactSkip(
        /already compacting/.test(guard.reason) ? 'busy'
          : /below/.test(guard.reason) ? 'too_small'
          : /circuit/.test(guard.reason) ? 'breaker'
          : 'other',
        guard.reason,
      );
      dumpCompactionQualityIfEnabled({
        kind: 'kernel_auto_compaction_skipped',
        source: 'runnerCompressionUtils',
        trigger, iteration, compressionMode, model, sessionId, querySource,
        reason: guard.reason,
        budget: { maxInputTokens, contextWindow, targetTotal: plan.targetTotal },
        before: { estimatedTokens: guardTokens, messageCount: guardMessages.length },
      });
      return null;
    }
  }

  if (!acquireCompactLock()) {
    logDebug('[AutoCompact] Skipped: already compacting (lock held)');
    recordCompactSkip('busy', 'another compaction is running');
    return null;
  }

  try {
    let messages = memory.getMessagesForLLM();
    const originalCount = messages.length;
    const originalTokens = estimateTokensFromMessages(messages);

    /* ── Main path: one summary request on the cached prefix, then rebuild ──
     * Runs on the history exactly as it is: the lossless layer below rewrites old tool
     * results, which would change the prefix and throw the cache away first.
     * 手动 /compact (manual) 也走这里 —— 跟 Claude Code / Codex 一样: 一次请求摘要整段对话,
     * 换成「摘要 + 最新那条用户消息」。只有对话已经装不下窗口才退到下面的分组摘要。 */
    if (mode === 'full' && trigger !== 'recovery' && summarizeOnCachedPrefix) {
      if (!hasEnoughToSummarize(messages)) {
        releaseCompactLock();
        logDebug('[AutoCompact] Skipped: not enough history to summarize');
        recordCompactSkip('too_small', 'not enough history to summarize');
        return null;
      }
      /* 一次请求没有真实的分数: percent 按已流回的摘要长度估 (见 estimateSummaryPercent), 结束才给 100 */
      const progress = (phase: 'compressing' | 'done', completed: number, compressedTokens: number,
        stream?: { percent: number; outputTokens: number }) =>
        onCompressionProgress?.({
          phase, totalBuckets: 1, completedBuckets: completed, buckets: [],
          originalTokens, compressedTokens, summaryModel: model ?? '',
          percent: phase === 'done' ? 100 : (stream?.percent ?? 0),
          outputTokens: stream?.outputTokens,
        });
      progress('compressing', 0, originalTokens);
      let summary: string | null = null;
      /* 先看后台预做的那份: 前面那段没变 + 之后长出来的不超过预算的三成, 就用它 */
      let specUpTo = -1;
      if (speculativeSummary) {
        try {
          const spec = await speculativeSummary();
          if (spec && isUsableSummary(spec.summary) && spec.upTo > 0 && spec.upTo <= messages.length
              && messagesFingerprint(messages.slice(0, spec.upTo)) === spec.fingerprint) {
            const tailTokens = estimateTokensFromMessages(messages.slice(spec.upTo));
            if (!maxInputTokens || tailTokens < maxInputTokens * 0.3) {
              summary = spec.summary;
              specUpTo = spec.upTo;
              logInfo(`[AutoCompact] using speculative summary (covers ${spec.upTo}/${messages.length} msgs, tail ${(tailTokens / 1000).toFixed(1)}K)`);
            }
          }
        } catch { /* 预做的不能用就当场做 */ }
      }
      if (summary === null) {
        try {
          summary = await summarizeOnCachedPrefix((s) => progress('compressing', 0, originalTokens, s));
        } catch (error) {
          if (!isContextOverflowError(error) && trigger === 'auto') throw error;
          logInfo(isContextOverflowError(error)
            ? '[AutoCompact] conversation no longer fits the window — summarizing by category instead'
            : `[ManualCompact] one-shot summary failed (${(error as Error)?.message ?? error}) — summarizing by category instead`);
        }
      }
      if (summary !== null && !isUsableSummary(summary)) {
        if (trigger === 'auto') throw new Error('summary request returned no usable summary');
        logInfo('[ManualCompact] one-shot summary came back unusable — summarizing by category instead');
        summary = null;
      }
      if (summary !== null) {
        const rebuilt = specUpTo > 0 ? rebuildWithSpeculativeSummary(messages, summary, specUpTo) : rebuildAfterSummary(messages, summary);
        /* Unfinished work state (todo / plan) only: budget 0 keeps file re-reads out.
         * The summary lists the files; the model reads what it needs again. */
        const reinject = generatePostCompactReinjectMessages(rebuilt.messages, 0);
        const finalMessages = reinject.messages.length > 0 ? [...rebuilt.messages, ...reinject.messages] : rebuilt.messages;
        memory.setMessages(finalMessages);
        runPostCompactCleanup();
        recordCompactSuccess();
        const finalRaw = estimateTokensFromMessages(finalMessages);
        progress('done', 1, finalRaw);
        logInfo(`[AutoCompact] cached-prefix summary: ${originalCount} msgs/${(originalTokens / 1000).toFixed(1)}K raw → `
          + `${finalMessages.length} msgs/${(finalRaw / 1000).toFixed(1)}K raw (${rebuilt.summarizedCount} summarized)`);
        dumpCompactionQualityIfEnabled({
          kind: 'kernel_auto_compaction_completed',
          source: 'runnerCompressionUtils',
          trigger, iteration, compressionMode, model, sessionId, querySource,
          strategy: 'cached-prefix-summary',
          budget: { maxInputTokens, contextWindow, targetTotal: plan.targetTotal },
          before: { estimatedTokens: originalTokens, messageCount: originalCount },
          after: { estimatedTokens: finalRaw, messageCount: finalMessages.length, savedTokens: originalTokens - finalRaw },
        });
        return {
          messages: finalMessages,
          originalCount,
          compressedCount: finalMessages.length,
          originalTokens,
          compressedTokens: finalRaw,
          savedTokens: originalTokens - finalRaw,
          summary,
          stats: {
            droppedMessages: rebuilt.summarizedCount,
            llmCompressedMessages: rebuilt.summarizedCount,
            truncatedMessages: 0,
            preservedMessages: finalMessages.length,
          },
        };
      }
    }

    /* ── 无损层: 重复工具结果去重 + 时间衰减 + 超长单条裁头尾 ── */
    const mcResult = microCompact(messages, 4, maxTurnAge);
    if (mcResult.clearedCount > 0) messages = mcResult.messages;
    const snipResult = snipOversizedToolResults(messages, 50_000, logInfo);
    if (snipResult.snippedCount > 0) messages = snipResult.messages;
    const lightTouched = mcResult.clearedCount + snipResult.snippedCount;
    const postLightRaw = estimateTokensFromMessages(messages);

    const finishLight = (): BatchCompressionResult | null => {
      if (lightTouched === 0) {
        releaseCompactLock();
        recordCompactSkip('too_small', 'nothing to dedupe or trim, and already within the target');
        return null;
      }

      /* ── 轻量层也回灌必要上下文 ──────────────────────────
       *
       *   microCompact 会将工具结果替换为占位，而回灌需要恢复最近文件、技能和未完成状态。
       *
       *   回灌范围受两项约束:
       *   1. 只在清掉工具结果时回灌 (clearedCount > 0)。snip 保留结果头尾，
       *      不需要重复回灌。
       *   2. 预算不超过本次操作省下来的量。light 的承诺是"无损节约", 省 2K 却灌回 8K
       *      会增加上下文并加快下一次压缩。 */
      const lightSaved = Math.max(0, originalTokens - postLightRaw);
      if (mcResult.clearedCount > 0 && lightSaved > 0) {
        const budget = Math.min(REINJECT_BUDGET_TOKENS, lightSaved);
        const reinject = generatePostCompactReinjectMessages(messages, budget);
        if (reinject.messages.length > 0) {
          messages = [...messages, ...reinject.messages];
          logInfo(`[Light] 回灌 ${reinject.filesInjected} 文件/${reinject.totalTokens} tok `
            + `(预算 ${budget} = min(${REINJECT_BUDGET_TOKENS}, 本次省下的 ${lightSaved}))`);
        }
      }

      const finalLightRaw = estimateTokensFromMessages(messages);
      memory.setMessages(messages);
      runPostCompactCleanup();
      recordCompactSuccess();
      logInfo(`[Light] 无损节约: 去重 ${mcResult.clearedCount} / 裁剪 ${snipResult.snippedCount} `
        + `(${(originalTokens / 1000).toFixed(1)}K → ${(finalLightRaw / 1000).toFixed(1)}K raw)`);
      return {
        messages,
        originalCount,
        compressedCount: messages.length,
        originalTokens,
        compressedTokens: finalLightRaw,
        savedTokens: originalTokens - finalLightRaw,
        stats: {
          droppedMessages: 0,
          llmCompressedMessages: 0,
          truncatedMessages: lightTouched,
          preservedMessages: messages.length,
        },
      };
    };

    /* 轻量线: 到此为止, 绝不烧 LLM */
    if (mode === 'light') return finishLight();

    /* 无损层之后已经落到目标 → 不必烧 LLM (手动 /compact 除外, 用户要的就是一份摘要) */
    if (scale.toReal(postLightRaw) <= plan.targetTotal && trigger === 'auto') {
      logDebug(`[AutoCompact] 无损层已达标: ${scale.toReal(postLightRaw)} ≤ ${plan.targetTotal}`);
      return finishLight();
    }

    /* ── 摘要收敛循环 ──
     * 每轮把可压区交给摘要器 (按内容类型分别摘要, 旧摘要滚动合并进新摘要)。
     * 一轮压不到目标就收紧尾部保护再来 —— 这就是"按比例多次摘要"。 */
    const tailBudgets = [
      plan.tailProtectRaw,
      Math.floor(plan.tailProtectRaw / 2),
      0,
    ];
    let rounds = 0;
    let droppedTotal = 0;
    let llmBucketsTotal = 0;
    let currentRaw = postLightRaw;

    for (let i = 0; i < Math.min(MAX_SUMMARY_ROUNDS, tailBudgets.length); i++) {
      const beforeRaw = currentRaw;
      const result = await unifiedCompressor.compressHistory(messages, plan.targetMessagesRaw, {
        iteration,
        enableLLMCompression: true,
        /* 第 2 轮起强制 —— 第 1 轮没压到目标说明"已在预算内"的判断不成立 */
        force: trigger !== 'auto' || i > 0,
        summarizerOverrides: {
          protectRecentTokens: tailBudgets[i],
          protectHeadCount: 2,
          force: trigger !== 'auto' || i > 0,
        },
      }, onCompressionProgress);

      rounds++;
      droppedTotal += result.stats.droppedMessages;
      llmBucketsTotal += result.stats.llmCompressedMessages;

      if (result.compressedTokens >= beforeRaw) {
        if (trigger !== 'auto' && i + 1 < Math.min(MAX_SUMMARY_ROUNDS, tailBudgets.length)) {
          logInfo(`[ManualCompact] round ${rounds} 无收益 (${beforeRaw} → ${result.compressedTokens}) — 收紧尾部保护再试`);
          continue;
        }
        logDebug(`[AutoCompact] round ${rounds} 无收益 (${beforeRaw} → ${result.compressedTokens}) — 停`);
        break;
      }

      messages = result.messages;
      currentRaw = result.compressedTokens;
      const gainRatio = (beforeRaw - currentRaw) / Math.max(1, beforeRaw);
      logInfo(`[AutoCompact] round ${rounds}: ${(beforeRaw / 1000).toFixed(1)}K → `
        + `${(currentRaw / 1000).toFixed(1)}K raw (省 ${(gainRatio * 100).toFixed(1)}%, 尾部保护 ${tailBudgets[i]})`);

      if (scale.toReal(currentRaw) <= plan.targetTotal) break;
      if (gainRatio < MIN_ROUND_GAIN_RATIO) {
        logDebug(`[AutoCompact] round ${rounds} 收益 ${(gainRatio * 100).toFixed(1)}% < ${MIN_ROUND_GAIN_RATIO * 100}% — 停`);
        break;
      }
    }

    /* LLM 整条路不可用 (没配 provider / 全部失败) → 降级到无 LLM 的分层折叠, 至少别不压 */
    if (currentRaw >= postLightRaw) {
      const collapse = contextCollapse(messages, plan.targetMessagesRaw, {}, querySource);
      if (collapse.collapsedCount > 0) {
        messages = collapse.messages;
        currentRaw = estimateTokensFromMessages(messages);
        droppedTotal += collapse.collapsedCount;
        logInfo(`[AutoCompact] LLM 摘要无收益 → 降级折叠, 清 ${collapse.collapsedCount} 条`);
      }
    }

    const savedRaw = originalTokens - currentRaw;
    if (savedRaw <= 0) {
      /* 没有节省 token 时报告 noop，避免把无效操作显示为完成。 */
      dumpCompactionQualityIfEnabled({
        kind: 'kernel_auto_compaction_noop',
        source: 'runnerCompressionUtils',
        trigger, iteration, compressionMode, model, sessionId, querySource,
        reason: `no gain after ${rounds} summary round(s)`,
        budget: { maxInputTokens, contextWindow, targetTotal: plan.targetTotal },
        before: { estimatedTokens: originalTokens, messageCount: originalCount },
        after: { estimatedTokens: currentRaw, messageCount: messages.length, savedTokens: 0 },
      });
      recordCompactSuccess();   /* 跑完了没崩, 熔断器该复位 */
      /* 一个分组都没摘成 = 摘要模型那头出了事 (报错 / 超时 / 没配), 不是"不需要压" */
      recordCompactSkip(
        llmBucketsTotal === 0 ? 'summary_failed' : 'no_gain',
        llmBucketsTotal === 0
          ? `the summary model produced no summary in ${rounds} round(s)`
          : `summaries were not smaller than the original (${rounds} round(s))`,
      );
      return null;
    }

    /* ── 回灌: 最近文件 / 技能 / 未完成状态 (固定 8K, 不随窗口) ── */
    const reinject = generatePostCompactReinjectMessages(messages, REINJECT_BUDGET_TOKENS);
    if (reinject.messages.length > 0) messages = [...messages, ...reinject.messages];

    memory.setMessages(messages);
    runPostCompactCleanup();
    recordCompactSuccess();

    const finalRaw = estimateTokensFromMessages(messages);
    const finalReal = scale.toReal(finalRaw);
    logInfo(`[AutoCompact] 完成: ${originalCount} 条/${(originalTokens / 1000).toFixed(1)}K raw → `
      + `${messages.length} 条/${(finalRaw / 1000).toFixed(1)}K raw | 实报口径 ${(finalReal / 1000).toFixed(1)}K `
      + `(目标 ${(plan.targetTotal / 1000).toFixed(1)}K, 前缀 ${(scale.fixedOverhead / 1000).toFixed(1)}K, `
      + `回灌 ${reinject.filesInjected} 文件/${reinject.totalTokens} tok, ${rounds} 轮摘要)`);

    dumpCompactionQualityIfEnabled({
      kind: 'kernel_auto_compaction_completed',
      source: 'runnerCompressionUtils',
      trigger, iteration, compressionMode, model, sessionId, querySource,
      strategy: llmBucketsTotal > 0 ? 'llm' : 'light',
      budget: { maxInputTokens, contextWindow, targetTotal: plan.targetTotal, targetMessagesRaw: plan.targetMessagesRaw },
      before: { estimatedTokens: originalTokens, messageCount: originalCount },
      after: {
        estimatedTokens: finalRaw,
        realTokens: finalReal,
        messageCount: messages.length,
        savedTokens: originalTokens - finalRaw,
        rounds,
        reinjectedTokens: reinject.totalTokens,
        fixedOverhead: scale.fixedOverhead,
      },
      layers: {
        microCompact: { clearedCount: mcResult.clearedCount, freedTokens: mcResult.freedTokens },
        snip: { snippedCount: snipResult.snippedCount, freedTokens: snipResult.freedTokens },
        llm: { droppedMessages: droppedTotal, llmCompressedMessages: llmBucketsTotal },
        reinject: { filesInjected: reinject.filesInjected, messagesInjected: reinject.messages.length },
      },
    });

    return {
      messages,
      originalCount,
      compressedCount: messages.length,
      originalTokens,
      compressedTokens: finalRaw,
      savedTokens: originalTokens - finalRaw,
      stats: {
        droppedMessages: droppedTotal,
        llmCompressedMessages: llmBucketsTotal,
        truncatedMessages: lightTouched,
        preservedMessages: messages.length,
      },
    };
  } catch (error) {
    recordCompactFailure(error instanceof Error ? error : new Error(String(error)));
    dumpCompactionQualityIfEnabled({
      kind: 'kernel_auto_compaction_failed',
      source: 'runnerCompressionUtils',
      trigger, iteration, compressionMode, model, sessionId, querySource,
      budget: { maxInputTokens, contextWindow },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}


// Re-export for external use
export { widenKeepStartForPairedBlocks } from './toolPairPreserver.js';
/**
 * 找出"压缩过程中读文件内容被挤掉/改写"的那些文件。
 *
 * 为什么需要: 读账本记的是"我们给模型发过什么", 而压缩会把 readfile 的结果从上下文里
 * 清掉 / 截断 / 折进摘要。此后账本仍然说 fresh, 于是 edit 的一致性诊断会给出**错误的指引**:
 *   真相是"你手里已经没有那份内容了" (该重读),
 *   诊断却说"你读过且文件没变, 是你自己抄错了" (让它照实际内容重发, 但它看不到实际内容)。
 *
 * 这是"账本必须镜像上下文"这个不变量的另一半 —— 对照 Claude Code runAgent.ts:375:
 * 子 agent 继承上下文就克隆账本、全新上下文就建空账本。压缩挤掉内容就该作废账本条目, 同理。
 *
 * 判据: 按 tool_call_id 配对压缩前后的 readfile 结果, **内容有任何变化 (含消失) 就算被挤掉**。
 * 截断也算 —— 模型看不到全文了, 就不该再被告知"你读过"。
 * 返回的是**工具调用参数里的原始路径**, 由调用方 (core) 归一化后作废账本。
 */
const READ_TOOL_NAMES_FOR_EVICTION = new Set(['readfile', 'read_file', 'read', 'smart_read']);

function collectReadResults(messages: Message[]): Map<string, { path: string; content: string }> {
  const argsByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls as any[]) {
      const name = tc?.function?.name;
      if (!name || !READ_TOOL_NAMES_FOR_EVICTION.has(name)) continue;
      try {
        const a = JSON.parse(tc.function?.arguments || '{}');
        const p = a.file_path || a.path || a.filePath || a.file;
        if (typeof p === 'string' && p) argsByCallId.set(tc.id, p);
      } catch { /* 参数坏了就跳过 */ }
    }
  }
  const out = new Map<string, { path: string; content: string }>();
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const id = (msg as any).tool_call_id as string | undefined;
    if (!id) continue;
    const p = argsByCallId.get(id);
    if (!p) continue;
    out.set(id, { path: p, content: typeof msg.content === 'string' ? msg.content : '' });
  }
  return out;
}

export function findEvictedReadPaths(before: Message[], after: Message[]): string[] {
  const b = collectReadResults(before);
  if (b.size === 0) return [];
  const a = collectReadResults(after);
  const evicted = new Set<string>();
  for (const [id, entry] of b) {
    const still = a.get(id);
    if (!still || still.content !== entry.content) evicted.add(entry.path);
  }
  return [...evicted];
}

export { shouldAutoCompact, getAutoCompactThreshold, resetCircuitBreaker } from './autoCompactGuard.js';
export { trackFileAccess, trackSkillInvocation } from './postCompactReinject.js';
