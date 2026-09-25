/**
 * Auto-compact circuit breaker and recursion protection.
 *
 * 核心机制：
 * 1. Circuit Breaker — 连续 N 次压缩失败后熔断，防止死循环浪费 API
 * 2. 递归保护 — 压缩查询中禁止再触发 auto-compact（防止套娃）
 * 3. 动态阈值 — 根据模型 context window 动态计算压缩触发点
 * 4. 环境变量覆盖 — 支持 NEOX_AUTOCOMPACT_PCT 手动调节阈值
 */

import { cliLogger } from '../platform/cliLogger.js';
import { createSessionScopedStore } from './sessionScope.js';

// ============================================================================
// 常量
// ============================================================================

/** 压缩摘要预留 token 数 */
const RESERVED_TOKENS_FOR_SUMMARY = 20_000;

/** 自动压缩缓冲区 token 数（在阈值之上再留 buffer） */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * 默认触发比例上限，作用于完整窗口并与设置页的占用比例保持同一口径。
 *
 * 只有「固定扣 33K」这一条规则时, 预留量不随窗口缩放, 大窗口直接失效:
 *     200K 窗 → 167K (83.5%)   合理
 *     500K 窗 → 467K (93.4%)   偏晚
 *       1M 窗 → 967K (96.7%)   等于近乎不压缩
 * 绝对预留与比例上限取更早的触发点，避免大窗口在接近耗尽时才压缩。
 */
const DEFAULT_MAX_TRIGGER_RATIO = 0.85;

/* ══════════════════════════════════════════════════════════════════════════
 * 落点参数 —— 压缩后保留量与窗口大小无关。
 *
 * 落点由固定前缀、摘要、回灌和尾部保护四项绝对预算组成，
 * 使不同窗口使用相同历史时得到可预期的结果。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 摘要产物上限 — 4 类内容各 1500 token */
export const SUMMARY_OUTPUT_CAP_TOKENS = 6_000;
/** 压缩后回灌上限 (最近文件 / 技能)。未完成状态不吃这份预算, 它永远回灌。 */
export const REINJECT_BUDGET_TOKENS = 8_000;
/** 尾部保护 (第 1 轮)。收敛循环里逐轮减半 → 0。 */
export const TAIL_PROTECT_TOKENS = 8_000;
/** 摘要收敛最多跑几轮 */
export const MAX_SUMMARY_ROUNDS = 3;
/** 单轮净收益低于这个比例就停 — 再摘也榨不出东西了 */
export const MIN_ROUND_GAIN_RATIO = 0.05;
/** 没有前缀样本时使用的保守兜底。 */
export const FALLBACK_FIXED_OVERHEAD = 18_000;
/** 轻量线 = 窗口 × 此比例。到这条线就做无损节约(去重/裁超长), 不烧 LLM。 */
export const LIGHT_LINE_RATIO = 0.6;

/** Token 警告阈值缓冲 */
const WARNING_THRESHOLD_BUFFER = 20_000;

/** 手动压缩最小余量 */
const MANUAL_COMPACT_BUFFER = 3_000;

/** 手动 /compact 最低可压门槛 (绝对 token) — 1M 窗口下 % 阈值太高测不了.
 *  8K: 状态栏 ctx 常含 cache-read, 看起来 20K 但 memory 估算更低; 20K 门槛会误拒. */
const MANUAL_COMPACT_MIN_TOKENS = 8_000;

/** 最大连续失败次数（触发熔断） */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 熔断冷却：熔断器必须能自己恢复。
 *
 * 冷却期结束后允许一次半开尝试；成功时完全复位，失败时重新开始冷却。
 */
const CIRCUIT_COOLDOWN_MS = 3 * 60_000;

// ============================================================================
// 查询源类型（用于递归保护）
// ============================================================================

/** 被阻止 auto-compact 的查询源 */
const BLOCKED_QUERY_SOURCES = new Set([
  'compact',
  'session_memory',
  'context_collapse',
  'tool_summary',
]);

// ============================================================================
// Circuit Breaker 状态
// ============================================================================

export interface AutoCompactState {
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 是否已熔断 */
  circuitOpen: boolean;
  /** 最后一次压缩尝试时间 */
  lastAttemptAt: number;
  /** 最后一次成功时间 */
  lastSuccessAt: number;
  /** 是否正在执行压缩（递归锁） */
  isCompacting: boolean;
  /** 总压缩次数 */
  totalAttempts: number;
  /** 总成功次数 */
  totalSuccesses: number;
}

/* 熔断器状态是按会话隔离的运行时状态，不继承全局值。 */
const stateStore = createSessionScopedStore<AutoCompactState>(createInitialState, { inherit: false });

/** 本会话的熔断器状态。对象是就地改的, 所以拿到引用直接改字段即可。 */
function state(): AutoCompactState {
  return stateStore.get();
}

function createInitialState(): AutoCompactState {
  return {
    consecutiveFailures: 0,
    circuitOpen: false,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    isCompacting: false,
    totalAttempts: 0,
    totalSuccesses: 0,
  };
}

// ============================================================================
// 动态阈值计算
// ============================================================================

/**
 * 计算有效 context window（扣除摘要预留）
 */
export function getEffectiveContextWindow(contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.max(0, contextWindow - RESERVED_TOKENS_FOR_SUMMARY);
}

/**
 * 计算 auto-compact 触发阈值
 *
 * 公式: effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
 * 支持 NEOX_AUTOCOMPACT_PCT 环境变量覆盖（0-100 百分比）
 */
export function getAutoCompactThreshold(contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  const effective = getEffectiveContextWindow(contextWindow);
  /* 窗口比摘要预留(20K)还小 → 下面的公式全是负数, 只能走小窗口兜底 (见下方注释) */
  if (effective <= 0) return Math.floor(contextWindow * 0.6);

  /* 两条规则取更早触发的那个:
   *   ① 绝对预留 effective - 13K —— 小窗口下主导 (≤220K 与历史完全一致)
   *   ② 比例上限 contextWindow × 0.85 —— 大窗口下主导, 见 DEFAULT_MAX_TRIGGER_RATIO
   * 只有 ① 时 1M 窗阈值 = 967K (96.7%), 等于近乎不压缩。 */
  const calculated = Math.min(
    effective - AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(contextWindow * DEFAULT_MAX_TRIGGER_RATIO),
  );

  /* 环境变量覆盖 — 比例作用于**完整窗口**, 跟设置页「占用达到 N%」同口径。
   * (前这里按 effective 算, 同一个 85% 在 1M 窗上是 833K 而不是 850K,
   *  跟 UI 文案对不上。) */
  /* 小窗口无法容纳固定预留时退回窗口的 60%，确保仍有可用触发点。 */
  const floorForSmallWindow = calculated > 0 ? calculated : Math.floor(contextWindow * 0.6);

  const pctOverride = process.env.NEOX_AUTOCOMPACT_PCT;
  if (pctOverride) {
    const pct = parseInt(pctOverride, 10);
    if (!isNaN(pct) && pct > 0 && pct <= 100) {
      const overrideThreshold = Math.floor(contextWindow * (pct / 100));
      return Math.max(0, Math.min(floorForSmallWindow, overrideThreshold));
    }
  }

  return Math.max(0, floorForSmallWindow);
}

/**
 * 自动压缩触发点是唯一真源。
 *
 * runner 和 guard 都调用本函数，确保触发判定只有一个门槛。
 *
 * @param contextWindow 模型真实窗口 (权威口径)
 * @param maxInputTokens 退化口径 — 没有 contextWindow 时才用
 * @param overrideRatio 用户显式配的 compressionThreshold (0..1), 作用于有效窗口
 */
export function resolveAutoCompactTriggerTokens(options: {
  contextWindow?: number;
  maxInputTokens?: number;
  overrideRatio?: number;
}): number {
  const { contextWindow, maxInputTokens, overrideRatio } = options;

  if (contextWindow && contextWindow > 0) {
    const base = getAutoCompactThreshold(contextWindow);
    if (overrideRatio && overrideRatio > 0 && overrideRatio <= 1) {
      /* 比例作用于**完整窗口**, 跟设置页「上下文占用达到 N%」同口径。
       * (前按 effective 算 → UI 写 85% 实际 83.3% 才触发。) */
      return Math.min(base, Math.floor(contextWindow * overrideRatio));
    }
    return base;
  }

  /* 没有 contextWindow (provider 没报窗口) → 退回 maxInputTokens 口径。
     此时 shouldAutoCompact 因 contextWindow 缺失被整段跳过, 由这里独立守门。 */
  if (maxInputTokens && maxInputTokens > 0) {
    const ratio = overrideRatio && overrideRatio > 0 && overrideRatio <= 1 ? overrideRatio : 0.9;
    return Math.floor(maxInputTokens * ratio);
  }

  return 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 口径换算：全系统只在这里转换 raw 和 real token。
 *
 * 系统里同时存在两种 token:
 *   raw  = estimateTokensFromMessages(messages)，只数消息本身，无法看到工具定义；
 *   real = 供应商实报的 contextTokens             真正占窗口的量, 含前缀
 *
 * 阈值和落点判定使用 real，摘要器预算使用 raw，中间只经过这个 scale 转换。
 * ══════════════════════════════════════════════════════════════════════════ */
export interface TokenScale {
  /** 固定前缀 (system + 工具定义)，拿不到样本时使用兜底值。 */
  fixedOverhead: number;
  /** 消息估算的低估修正系数, 夹在 [1,4] */
  errorFactor: number;
  /** 是否有真实样本 (没有则两个值都是兜底, 判定要更保守) */
  measured: boolean;
  toReal(raw: number): number;
  toRaw(real: number): number;
}

/**
 * @param measured             provider 返回的 contextTokens (含前缀)
 * @param estimateAtMeasurement 对应样本的裸估算 (仅消息)
 * @param fixedOverheadSample   会话内观测到的固定前缀样本，优先使用较小值。
 */
export function resolveTokenScale(
  measured: number,
  estimateAtMeasurement: number,
  fixedOverheadSample?: number,
): TokenScale {
  const hasSample = measured > 0 && estimateAtMeasurement > 0;
  const fixedOverhead = fixedOverheadSample && fixedOverheadSample > 0
    ? fixedOverheadSample
    : hasSample
      ? Math.max(0, measured - estimateAtMeasurement)
      : FALLBACK_FIXED_OVERHEAD;
  /* 扣掉前缀之后剩下的才是"消息部分被低估了多少" */
  const errorFactor = hasSample
    ? Math.min(4, Math.max(1, (measured - fixedOverhead) / estimateAtMeasurement))
    : 1;
  return {
    fixedOverhead,
    errorFactor,
    measured: hasSample,
    toReal: (raw: number) => Math.round(fixedOverhead + Math.max(0, raw) * errorFactor),
    toRaw: (real: number) => Math.max(0, Math.round((real - fixedOverhead) / errorFactor)),
  };
}

/** 压缩计划 —— 三条线 + 落点, 由 resolveCompactionPlan 一次算全。 */
export interface CompactionPlan {
  /** 到这条线做无损节约 (去重 / 裁超长), 不烧 LLM */
  lightLine: number;
  /** 到这条线做摘要压缩 */
  triggerLine: number;
  /** 目标落点 (real 口径) = 前缀 + 摘要 + 回灌 + 尾部保护 */
  targetTotal: number;
  /** 目标落点里"消息"那部分 (raw 口径) —— 传给摘要器的预算 */
  targetMessagesRaw: number;
  /** 尾部保护 (raw 口径), 收敛循环逐轮减半 */
  tailProtectRaw: number;
  scale: TokenScale;
}

export function resolveCompactionPlan(options: {
  contextWindow?: number;
  maxInputTokens?: number;
  overrideRatio?: number;
  scale: TokenScale;
}): CompactionPlan {
  const { contextWindow, maxInputTokens, overrideRatio, scale } = options;
  const triggerLine = resolveAutoCompactTriggerTokens({ contextWindow, maxInputTokens, overrideRatio });
  /* 轻量线必须早于触发线，避免较低的触发比例跳过无损节约路径。 */
  const lightLine = Math.min(
    contextWindow && contextWindow > 0 ? Math.floor(contextWindow * LIGHT_LINE_RATIO) : Number.POSITIVE_INFINITY,
    Math.floor(triggerLine * LIGHT_LINE_RATIO),
  );

  /* 落点四项全是绝对值, 跟窗口无关 —— 这就是"1M 和 200K 压完剩一样多"的来源 */
  const targetTotal = scale.fixedOverhead
    + SUMMARY_OUTPUT_CAP_TOKENS
    + REINJECT_BUDGET_TOKENS
    + TAIL_PROTECT_TOKENS;

  return {
    lightLine,
    triggerLine,
    targetTotal,
    targetMessagesRaw: Math.max(2_000, scale.toRaw(targetTotal)),
    tailProtectRaw: Math.max(1_000, scale.toRaw(scale.fixedOverhead + TAIL_PROTECT_TOKENS)),
    scale,
  };
}

/**
 * 把估算 token 换算到真实 token 口径，供阈值比较使用。
 * raw 估算只覆盖消息内容，而真实 token 还包含工具定义和 system 提示；使用配对样本
 * 进行校准可以让阈值和请求实际占用保持同一口径。
 *
 * @param rawEstimate          当前的裸估算值
 * @param measured             上一次 provider 返回的 prompt_tokens (没有则传 0)
 * @param estimateAtMeasurement 对应样本的裸估算值 (没有则传 0)
 */
export function calibrateEstimatedTokens(
  rawEstimate: number,
  measured: number,
  estimateAtMeasurement: number,
): number {
  /* 没有配对样本 → 原样返回, 退化成旧行为 (绝不会比不校准更差) */
  if (measured <= 0 || estimateAtMeasurement <= 0) return rawEstimate;
  /* 限制校准比值，避免异常样本把阈值放大到不可用范围。 */
  const ratio = Math.min(4, Math.max(1, measured / estimateAtMeasurement));
  /* 估算增加或减少时都按同一比例校准，保持压缩前后的变化方向一致。 */
  const delta = rawEstimate - estimateAtMeasurement;
  /* 校准值不低于裸估算，避免校准样本导致结果被低估。 */
  return Math.max(rawEstimate, Math.round(measured + delta * ratio));
}

/**
 * 计算 token 警告状态
 */
export interface TokenWarningState {
  /** 剩余百分比 */
  percentLeft: number;
  /** 是否超过警告阈值 */
  isAboveWarningThreshold: boolean;
  /** 是否超过错误阈值 */
  isAboveErrorThreshold: boolean;
  /** 是否超过 auto-compact 阈值 */
  isAboveAutoCompactThreshold: boolean;
  /** 是否达到阻塞限制 */
  isAtBlockingLimit: boolean;
}

export function calculateTokenWarningState(
  tokenUsage: number,
  contextWindow: number,
): TokenWarningState {
  const effective = getEffectiveContextWindow(contextWindow);
  const threshold = getAutoCompactThreshold(contextWindow);

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER;
  const errorThreshold = threshold - WARNING_THRESHOLD_BUFFER;
  const blockingLimit = effective - MANUAL_COMPACT_BUFFER;

  const percentLeft = effective > 0
    ? Math.max(0, ((effective - tokenUsage) / effective) * 100)
    : 0;

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold: tokenUsage >= threshold,
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  };
}

// ============================================================================
// 核心守卫逻辑
// ============================================================================

export interface ShouldAutoCompactResult {
  should: boolean;
  reason: string;
}

/**
 * 判断是否应该触发 auto-compact
 *
 * 检查顺序：
 * 1. 递归保护（正在压缩或被阻止的查询源）
 * 2. 熔断检查（连续失败过多）
 * 3. 阈值检查（token 使用量是否超过阈值）
 */
export function shouldAutoCompact(
  tokenUsage: number,
  contextWindow: number,
  querySource?: string,
  /* 用户显式配的 compressionThreshold (0..1)。必须跟 runner 的预门禁同口径,
     否则 override 调低后 runner 放行、guard 仍拦 → 死区原样复活。 */
  overrideRatio?: number,
): ShouldAutoCompactResult {
  // 1. 递归保护：正在压缩中
  if (state().isCompacting) {
    return { should: false, reason: 'already compacting (recursion guard)' };
  }

  // 2. 递归保护：被阻止的查询源
  if (querySource && BLOCKED_QUERY_SOURCES.has(querySource)) {
    return { should: false, reason: `blocked query source: ${querySource}` };
  }

  // 3. 阈值检查 — 走唯一真源, 跟 runner 预门禁同一个数
  const threshold = resolveAutoCompactTriggerTokens({ contextWindow, overrideRatio });
  if (threshold <= 0) {
    return { should: false, reason: 'no valid threshold (contextWindow too small)' };
  }

  /* 4. 熔断检查 —— 放在阈值之后, 且有两条出口(见 CIRCUIT_COOLDOWN_MS 注释):
   *   ① 半开: 冷却期满放行一次尝试
   *   ② 溢出旁路: 已经涨过有效窗口了, 再拦就是**必定** context_length_exceeded,
   *      "白试一次压缩" 严格优于 "保证撞墙" —— 熔断器不该保护到这一步。 */
  if (state().circuitOpen) {
    const cooledDown = Date.now() - state().lastAttemptAt >= CIRCUIT_COOLDOWN_MS;
    const overflowing = contextWindow > 0 && tokenUsage >= getEffectiveContextWindow(contextWindow);
    if (!cooledDown && !overflowing) {
      return {
        should: false,
        reason: `circuit breaker open (${state().consecutiveFailures} consecutive failures)`,
      };
    }
    cliLogger.warn('AutoCompactGuard',
      `Circuit breaker half-open (${cooledDown ? 'cooldown elapsed' : 'context overflowing'}) — retrying compaction`);
  }

  if (tokenUsage < threshold) {
    return { should: false, reason: `below threshold (${tokenUsage} < ${threshold})` };
  }

  return { should: true, reason: `above threshold (${tokenUsage} >= ${threshold})` };
}

/**
 * 手动 /compact 是否值得跑。
 * 不走 auto 的 %-of-window 阈值 (1M 窗下 ~967K 才触发, 测不了)。
 * 默认 memory ≥ 8K 就允许; NEOX_MANUAL_COMPACT_MIN_TOKENS 可覆盖。
 * 注意: 状态栏 ctx 常含 cache-read, 数字会大于 memory 估算。
 */
export function shouldManualCompact(tokenUsage: number): ShouldAutoCompactResult {
  if (state().isCompacting) {
    return { should: false, reason: 'already compacting (recursion guard)' };
  }
  const min = getManualCompactMinTokens();
  if (tokenUsage < min) {
    return { should: false, reason: `below manual min (${tokenUsage} < ${min})` };
  }
  return { should: true, reason: `manual ok (${tokenUsage} >= ${min})` };
}

/** 手动压缩最低 memory token 门槛 (可被 NEOX_MANUAL_COMPACT_MIN_TOKENS 覆盖) */
export function getManualCompactMinTokens(): number {
  const n = Number(process.env.NEOX_MANUAL_COMPACT_MIN_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MANUAL_COMPACT_MIN_TOKENS;
}

/**
 * 标记开始压缩（获取递归锁）
 * @returns 是否成功获取锁（false = 已在压缩中）
 */
export function acquireCompactLock(): boolean {
  if (state().isCompacting) return false;
  state().isCompacting = true;
  state().lastAttemptAt = Date.now();
  state().totalAttempts++;
  return true;
}

/**
 * 标记压缩成功完成
 */
export function recordCompactSuccess(): void {
  state().isCompacting = false;
  state().consecutiveFailures = 0;
  state().circuitOpen = false;
  state().lastSuccessAt = Date.now();
  state().totalSuccesses++;

  cliLogger.debug('AutoCompactGuard', 'Compact succeeded, circuit breaker reset');
}

/**
 * 标记压缩失败
 */
export function recordCompactFailure(error?: Error): void {
  state().isCompacting = false;
  state().consecutiveFailures++;

  if (state().consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state().circuitOpen = true;
    cliLogger.warn('AutoCompactGuard',
      `Circuit breaker OPEN: ${state().consecutiveFailures} consecutive failures. ` +
      `Auto-compact disabled until manual reset. Last error: ${error?.message ?? 'unknown'}`,
    );
  } else {
    cliLogger.warn('AutoCompactGuard',
      `Compact failed (${state().consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}). ` +
      `Error: ${error?.message ?? 'unknown'}`,
    );
  }
}

/**
 * 释放压缩锁（异常路径使用，正常用 recordSuccess/Failure）
 */
export function releaseCompactLock(): void {
  state().isCompacting = false;
}

/**
 * 手动重置熔断器（用户明确要求重试时）
 */
export function resetCircuitBreaker(): void {
  state().consecutiveFailures = 0;
  state().circuitOpen = false;
  cliLogger.info('AutoCompactGuard', 'Circuit breaker manually reset');
}

/**
 * 获取当前状态快照（诊断用）
 */
export function getAutoCompactState(): Readonly<AutoCompactState> {
  return { ...state() };
}

/**
 * 完全重置状态（测试用 / 会话重置）
 */
export function resetAutoCompactState(): void {
  stateStore.clearAll();
}
