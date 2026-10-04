
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { drainDuplicateCounts } from '../tools/smart-read/readLedger.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { classifyToolFailure, detectCommandFailure, type FailureClass } from './toolFailureClassifier.js';

const EDIT_TOOLS = new Set(['edit', 'edit_file', 'edit_batch']);

let _globalTurnSeq = 0;

interface ToolRow {
  name: string;
  success: boolean;
  isDuplicate: boolean;
  errorKind?: string;
  failureClass?: FailureClass;
  execMs?: number;
}

/**
 * Gap 计算 —— "死空档" = 整轮墙钟里既没在跑工具、也没在推理的时间。稳定性核心指标:
 *   gapMs  = duration − 忙碌区间并集 (工具执行 ∪ 推理产出)
 *   maxGapMs = 单个最长空档 (一次卡顿/挂起的时长 —— 体感"不稳"的直接量)
 * 用区间并集正确处理并行工具 (execMs 相加会重叠, 并集不会)。纯数值, 不抛异常。
 */
export function computeGap(
  durationMs: number,
  toolIntervals: Array<[number, number]>,
  inferStarts: number[],
): { gapMs: number; maxGapMs: number } {
  const dur = Math.max(0, durationMs || 0);
  const clamp = (x: number) => Math.max(0, Math.min(dur, x || 0));
  const busy: Array<[number, number]> = [];
  for (const [s, e] of toolIntervals) {
    if (e > s) busy.push([clamp(s), clamp(e)]);
  }
  const infer = [...inferStarts].sort((a, b) => a - b);
  const toolStarts = toolIntervals.map((t) => t[0]).sort((a, b) => a - b);
  for (let i = 0; i < infer.length; i++) {
    const s = infer[i];
    let end = dur;
    for (const ts of toolStarts) { if (ts >= s) { end = Math.min(end, ts); break; } } // 推理产出到首个工具开始
    if (i + 1 < infer.length) end = Math.min(end, infer[i + 1]);
    if (end > s) busy.push([clamp(s), clamp(end)]);
  }
  if (!busy.length) return { gapMs: dur, maxGapMs: dur };
  busy.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[busy[0][0], busy[0][1]]];
  for (let i = 1; i < busy.length; i++) {
    const last = merged[merged.length - 1];
    if (busy[i][0] <= last[1]) last[1] = Math.max(last[1], busy[i][1]);
    else merged.push([busy[i][0], busy[i][1]]);
  }
  let busyMs = 0;
  for (const [s, e] of merged) busyMs += e - s;
  let maxGap = merged[0][0]; // 起点到首个忙碌区间的空档
  let prevEnd = merged[0][1];
  for (let i = 1; i < merged.length; i++) {
    maxGap = Math.max(maxGap, merged[i][0] - prevEnd);
    prevEnd = merged[i][1];
  }
  maxGap = Math.max(maxGap, dur - prevEnd); // 尾部空档
  return { gapMs: Math.max(0, dur - busyMs), maxGapMs: Math.max(0, maxGap) };
}

export class TurnMetricsCollector {
  private readonly startMs: number;
  private readonly turnIndex: number;
  private firstActionMs: number | null = null;
  private inferences = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private commandFailures = 0;   // shell 命令退出码非0 的次数 (工具执行成功但命令失败)
  private turnError?: FailureClass; // turn 级失败归因 (LLM/provider 错误: quota/限流/超时)
  private editCalls = 0;
  private editFailures = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private provider?: string;
  private model?: string;
  private readonly toolRows: ToolRow[] = [];
  private readonly inferStarts: number[] = [];        // 每次推理开始 (相对 startMs)
  private readonly toolIntervals: Array<[number, number]> = []; // [start,end] 相对 ms
  private flushed = false;

  constructor() {
    this.startMs = Date.now();
    this.turnIndex = _globalTurnSeq++;
  }

  /** turn 级失败 (LLM/provider 错误: quota/限流/上下文超限/超时/协议). 归因存 turn_error。
   *  与 tool_failures 互补: 那些是工具级, 这个是"整轮因 LLM 调用失败而空转"。 */
  onTurnError(errorKind?: string): void {
    if (!errorKind) return;
    this.turnError = classifyToolFailure('(inference)', errorKind, errorKind);
  }

  onInference(provider?: string, model?: string): void {
    this.inferences += 1;
    this.inferStarts.push(Date.now() - this.startMs);
    if (provider) this.provider = provider;
    if (model) this.model = model;
  }

  /** 首个可见输出 (首 token) 到达 —— TTFA 只记一次。 */
  markFirstAction(): void {
    if (this.firstActionMs === null) this.firstActionMs = Date.now() - this.startMs;
  }

  onTokenUsage(u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): void {
    this.inputTokens += u.inputTokens ?? 0;
    this.outputTokens += u.outputTokens ?? 0;
    this.cacheReadTokens += u.cacheReadTokens ?? 0;
  }

  onToolOutput(name: string, success: boolean, output?: string, execMs?: number, startMsAbs?: number): void {
    if (!name) return;
    this.toolCalls += 1;
    if (!success) this.toolFailures += 1;
    if (EDIT_TOOLS.has(name)) {
      this.editCalls += 1;
      if (!success) this.editFailures += 1;
    }
    // readfile/search 去重短路的 stub —— 标记重复 (turn 级精确数走 readLedger drain)。
    const dupMark = typeof output === 'string' && (output.includes('未变化') || output.includes('已跳过重搜'));
    const isDuplicate = (name === 'readfile' || name === 'search') && dupMark;
    let errorKind: string | undefined;
    let failureClass: FailureClass | undefined;
    if (!success) {
      if (typeof output === 'string') {
        try { errorKind = JSON.parse(output)?.error; } catch { /* 非 JSON 输出忽略 */ }
      }
      failureClass = classifyToolFailure(name, errorKind, output); // 失败归因
    } else if (detectCommandFailure(output)) {
      // 工具执行成功但命令退出码非0 (测试/构建/lint 挂) —— 单独归因 command_failed。
      failureClass = 'command_failed';
      this.commandFailures += 1;
    }
    // Gap 用: 记录工具执行区间 (相对 turn 起点)。startMsAbs 缺省则用"现在往回推 execMs"兜底。
    const em = typeof execMs === 'number' && execMs >= 0 ? execMs : 0;
    if (em > 0) {
      const startRel = typeof startMsAbs === 'number' && startMsAbs > 0
        ? startMsAbs - this.startMs
        : Date.now() - this.startMs - em;
      this.toolIntervals.push([Math.max(0, startRel), Math.max(0, startRel) + em]);
    }
    this.toolRows.push({ name, success, isDuplicate, errorKind, failureClass, execMs: em || undefined });
  }

  /** run_done 时调一次: 落库。sessionId 用 host 的持久化 session id (跟 token_usage 对齐, 便于 join)。 */
  flush(sessionId?: string, provider?: string, model?: string): void {
    if (this.flushed) return;
    this.flushed = true;
    try {
      const db = getDatabase();
      const now = Date.now();
      // duplicate 精确数: readLedger 按 ALS session 累加, host 在同一 runWithChatSession 作用域内, 无参 drain 命中同 key。
      const dup = drainDuplicateCounts();
      const base = `${now}-${this.turnIndex}`;
      const durationMs = now - this.startMs;
      const { gapMs, maxGapMs } = computeGap(durationMs, this.toolIntervals, this.inferStarts);
      db.recordTurnMetric({
        id: `${base}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: now,
        sessionId,
        turnIndex: this.turnIndex,
        provider: provider ?? this.provider,
        model: model ?? this.model,
        inferences: this.inferences,
        toolCalls: this.toolCalls,
        toolFailures: this.toolFailures,
        editCalls: this.editCalls,
        editFailures: this.editFailures,
        commandFailures: this.commandFailures,
        turnError: this.turnError,
        duplicateReadCount: dup.read,
        duplicateSearchCount: dup.search,
        ttfaMs: this.firstActionMs ?? undefined,
        durationMs,
        gapMs,
        maxGapMs,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cacheReadTokens: this.cacheReadTokens,
      });
      for (let i = 0; i < this.toolRows.length; i++) {
        const t = this.toolRows[i];
        db.recordToolMetric({
          id: `${base}-t${i}`,
          timestamp: now,
          sessionId,
          turnIndex: this.turnIndex,
          toolName: t.name,
          success: t.success,
          isDuplicate: t.isDuplicate,
          errorKind: t.errorKind,
          failureClass: t.failureClass,
          durationMs: t.execMs,
        });
      }
    } catch (e) {
      cliLogger.warn('METRICS', `turn metric flush failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
