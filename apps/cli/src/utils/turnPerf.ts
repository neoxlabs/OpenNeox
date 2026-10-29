import { useEffect, useState } from 'react';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface IterationPerf {
  iteration: number;
  durationMs: number;
  ttftMs: number | null;
  firstKind: string | null;
  toolMs: number;
  toolCalls: number;
  textChars: number;
}

export interface TurnPerf {
  /** 这一轮第一次测到的首字延迟; 一次都没测到 → null */
  ttftMs: number | null;
  /** 首字是什么先到的: text / reasoning / tool_call 等; 没测到 → null */
  firstKind: string | null;
  iterations: number;
  /** 所有请求耗时之和 (含等模型 + 收流), 日志里用来判断时间花在哪 */
  llmMs: number;
  /** 所有请求里工具执行耗时之和 */
  toolMs: number;
}

/** 逐请求指标 → 一轮的摘要。空数组 / 没传 → null (这一轮没有可报的数字) */
export function summarizeTurnPerf(perf: readonly IterationPerf[] | null | undefined): TurnPerf | null {
  if (!perf || perf.length === 0) return null;
  /* 第一次请求的首字就是这一轮的感知延迟; 万一它没测到 (流一开始就报错),
   * 退到后面第一个测到的值, 总比不显示强。 */
  const withTtft = perf.find((i) => typeof i.ttftMs === 'number' && i.ttftMs !== null);
  return {
    ttftMs: withTtft?.ttftMs ?? null,
    firstKind: withTtft?.firstKind ?? null,
    iterations: perf.length,
    llmMs: perf.reduce((n, i) => n + (Number(i.durationMs) || 0), 0),
    toolMs: perf.reduce((n, i) => n + (Number(i.toolMs) || 0), 0),
  };
}

/** 给人看的首字: 820ms / 1.2s / 12.3s */
export function formatTtft(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

/** 一条可搜索的结构化日志: PERF ttft=1200ms first=text iterations=3 llm=4200ms tools=800ms */
export function formatPerfLog(perf: TurnPerf, label = 'Main'): string {
  const ttft = perf.ttftMs === null ? 'n/a' : `${Math.round(perf.ttftMs)}ms`;
  return `ttft=${ttft} first=${perf.firstKind ?? '-'} iterations=${perf.iterations} llm=${Math.round(perf.llmMs)}ms tools=${Math.round(perf.toolMs)}ms label=${label}`;
}

/* 最近一轮的首字 —— 状态行读这份 (跟 contextUsageStore 同一个套路: 模块级 + 订阅)。 */
let lastTtft: number | null = null;
const listeners = new Set<(ms: number | null) => void>();

/** run_result 到达时调用: 存下这一轮首字并返回摘要 (拿不到就返回 null, 旧值清空) */
export function recordTurnPerf(perf: readonly IterationPerf[] | null | undefined): TurnPerf | null {
  const turn = summarizeTurnPerf(perf);
  lastTtft = turn?.ttftMs ?? null;
  for (const fn of listeners) {
    try { fn(lastTtft); } catch { /* 订阅方自己出错不影响别的 */ }
  }
  return turn;
}

export function getLastTurnTtft(): number | null {
  return lastTtft;
}

/** 状态行用: 最近一轮的首字延迟 */
export function useLastTurnTtft(): number | null {
  const [ms, setMs] = useState<number | null>(lastTtft);
  useEffect(() => {
    listeners.add(setMs);
    setMs(lastTtft);
    return () => { listeners.delete(setMs); };
  }, []);
  return ms;
}

/**
 * run_result 的唯一消费点: 算摘要 → 打 PERF 日志 → 主 agent 的存给状态行。
 * 子 agent 只打日志 (带 label), 不覆盖主轮首字。
 */
export function consumeRunPerf(event: { iterationPerf?: readonly IterationPerf[] | null; sourceLabel?: string }): TurnPerf | null {
  const turn = summarizeTurnPerf(event.iterationPerf);
  if (!turn) return null;
  cliLogger.info('PERF', formatPerfLog(turn, event.sourceLabel || 'Main'));
  if (!event.sourceLabel) recordTurnPerf(event.iterationPerf);
  return turn;
}
