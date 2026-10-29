
export const AUTO_RETRY_MAX = 10;

/** 上游明说可重试 / 属于链路故障族 → 可自动重试。 */
const RECOVERABLE_CODES = new Set([
  'NETWORK', 'TIMEOUT', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'STREAM_ERROR', 'STREAM_TIMEOUT', 'STREAM_INCOMPLETE', 'STREAM_IDLE_TIMEOUT', 'EMPTY_STREAM',
  'UPSTREAM_5XX', 'SERVICE_UNAVAILABLE', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'POD_BUSY',
]);
/** 限流族 —— 可恢复, 但要等得更久。 */
const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'HIGH_LOAD']);
/** 明确**不**自动重试 —— 重发只会把同一个错误再买一遍。 */
const NEVER_AUTO_CODES = new Set([
  'RUNTIME_ERROR',
  'BAD_REQUEST', 'INVALID_REQUEST', 'CONTEXT_EXCEEDED', 'CONTEXT_LENGTH_EXCEEDED',
  'AUTH_EXPIRED', 'NOT_AUTHENTICATED', 'NO_JWT', 'FORBIDDEN', 'UNAUTHORIZED',
  'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'PAYMENT_REQUIRED',
  'LOOP_DETECTED', 'PLACEHOLDER_DETECTED', 'EMPTY_RESPONSE', 'TIMELINE_TURN_WITHOUT_EVENTS',
]);

export type RetryClass = 'none' | 'transport' | 'rate-limit';

/** 这条错误该不该自己重试; 顺带给出用哪套退避。 */
/** 重发也没用的上游配置类错误 —— 按**原文**判 (它们的 code 常常只是通用的 RUNTIME_ERROR)。 */
const NEVER_AUTO_MESSAGE_RE = /no available channel|no channel available|model not found|no permission|insufficient|invalid api key|unauthorized/i;

export function classifyRetry(input: { code?: string; retryable?: boolean; message?: string }): RetryClass {
  if (input.message && NEVER_AUTO_MESSAGE_RE.test(input.message)) return 'none';
  const code = String(input.code ?? '').trim().toUpperCase();
  if (NEVER_AUTO_CODES.has(code)) return 'none';
  if (RATE_LIMIT_CODES.has(code)) return 'rate-limit';
  if (RECOVERABLE_CODES.has(code)) return 'transport';
  /* envelope 码是 network.* / stream.* 这种分层写法 */
  const lower = String(input.code ?? '').trim().toLowerCase();
  if (/^(network|stream)\./.test(lower)) return 'transport';
  if (/^rate[_.-]?limit/.test(lower)) return 'rate-limit';
  /* 没命中任何族: 只有上游明说 retryable 才自动重试。拿不准就让用户自己点。 */
  return input.retryable === true ? 'transport' : 'none';
}

/** 第 attempt 次 (1-based) 之前等多久。 */
export function backoffMs(attempt: number, kind: RetryClass): number {
  if (kind === 'none') return 0;
  const ladder = kind === 'rate-limit' ? [15_000, 20_000, 30_000] : [2_000, 4_000, 8_000, 15_000, 30_000];
  return ladder[Math.min(Math.max(attempt, 1) - 1, ladder.length - 1)];
}

export interface AutoRetryState {
  entryId: string;
  /** 已经**真开火**几次 (用于"第 N 次重试中") */
  attempt: number;
  scheduled: number;
  max: number;
  /** 下一次开火的时刻 (epoch ms); 正在跑时为 null */
  nextAt: number | null;
  /** 这一档退避总时长 —— 进度圈按它算比例, 不然只能拿剩余值瞎猜 */
  waitMs: number;
  /** 已经用完 10 次 —— 停下来, 让用户自己决定 */
  exhausted: boolean;
  /** 上一次见到的失败时刻, 用来判"又失败了一次" */
  seenAt: number;
  kind: RetryClass;
}

const states = new Map<string, AutoRetryState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) { try { fn(); } catch { /* 单个订阅者出错不影响其他人 */ } }
}

export function subscribeAutoRetry(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getAutoRetryState(sessionId: string | null | undefined): AutoRetryState | null {
  if (!sessionId) return null;
  return states.get(sessionId) ?? null;
}

function clearTimer(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) { clearTimeout(t); timers.delete(sessionId); }
}

/** 用户关掉这条 / 这一轮跑成了 / 换会话 —— 停止自动重试。 */
export function cancelAutoRetry(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  clearTimer(sessionId);
  if (states.delete(sessionId)) emit();
}

export function noteAnomaly(params: {
  sessionId: string;
  entryId: string;
  code?: string;
  retryable?: boolean;
  seenAt: number;
  fire: () => void;
}): void {
  const { sessionId, entryId, code, retryable, seenAt, fire } = params;
  if (!sessionId || !entryId) return;
  const kind = classifyRetry({ code, retryable });
  if (kind === 'none') { cancelAutoRetry(sessionId); return; }

  const prev = states.get(sessionId);
  /* 换了一条错误 (别的轮 / 别的码) → 从头开始数 */
  if (prev && prev.entryId !== entryId) cancelAutoRetry(sessionId);
  const cur = states.get(sessionId);

  if (cur && cur.seenAt === seenAt) return;          /* 同一次失败, 已经排过了 */
  if (cur?.exhausted) return;                        /* 10 次用完, 不再自动 */

  const attempt = (cur?.scheduled ?? 0) + 1;
  if (attempt > AUTO_RETRY_MAX) {
    states.set(sessionId, { ...(cur as AutoRetryState), scheduled: AUTO_RETRY_MAX, nextAt: null, waitMs: 0, exhausted: true, seenAt });
    clearTimer(sessionId);
    emit();
    return;
  }

  const wait = backoffMs(attempt, kind);
  const next: AutoRetryState = {
    entryId, attempt: cur?.attempt ?? 0, scheduled: attempt, max: AUTO_RETRY_MAX,
    nextAt: Date.now() + wait, waitMs: wait, exhausted: false, seenAt, kind,
  };
  states.set(sessionId, next);
  clearTimer(sessionId);
  timers.set(sessionId, setTimeout(() => {
    timers.delete(sessionId);
    const s = states.get(sessionId);
    if (!s || s.seenAt !== seenAt) return;           /* 期间被取消/被新失败取代 */
    states.set(sessionId, { ...s, attempt, nextAt: null, waitMs: 0 });   /* 开火 → 真次数追上排程数 */
    emit();
    try { fire(); } catch { /* 开火失败不影响状态机, 下一次失败会重新排 */ }
  }, wait));
  emit();
}

/** 只给测试用: 清干净模块级状态。 */
export function __resetAutoRetryForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  states.clear();
  emit();
}

if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__neoxAutoRetry = {
    get: getAutoRetryState, note: noteAnomaly, cancel: cancelAutoRetry,
    classify: classifyRetry, backoff: backoffMs, reset: __resetAutoRetryForTests, max: AUTO_RETRY_MAX,
  };
}
