
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/* 通用工具超时上限 — 各 tool 调 withTimeout 不显式传时的默认值。
   注意: shell tool 有自己更复杂的多档超时 (10s early + 120s hard), 不走这条。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MIN_TOOL_TIMEOUT_MS = 100;
export const MAX_TOOL_TIMEOUT_MS = 600_000; // 10 min absolute cap

/* 超时报错的错误码 — safeError 识别后填到 result.code */
export const TOOL_TIMEOUT_CODE = 'tool_timeout';

export interface ToolEnvelopeError {
  error: string;
  code: string;
  /** 给 LLM 看的"下一步建议", 跟 editFileTool createEphemeralResult 的 verify_hint 同语义 */
  hint?: string;
}

/**
 * 统一的超时包装. 同时支持外部 AbortSignal:
 *   - 外部 abort 触发 → reject('aborted')
 *   - 超时触发 → reject('timeout')
 *   - fn 自己 throw → 透传
 *   - fn 完成 → resolve 原值
 *
 * 如果 fn 的 promise 没有自动响应 abort, 请在 fn 内部接 signal 自己中止。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = DEFAULT_TOOL_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  const safeMs = Number.isFinite(ms) ? Math.max(MIN_TOOL_TIMEOUT_MS, Math.min(MAX_TOOL_TIMEOUT_MS, Math.floor(ms))) : DEFAULT_TOOL_TIMEOUT_MS;
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw makeAbortError();
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), safeMs);
  try {
    return await fn(ctrl.signal);
  } catch (err: any) {
    if (ctrl.signal.aborted && !externalSignal?.aborted) {
      /* abort 是我们自己 timer 触发的 → 真超时 */
      const e: any = new Error(`tool timed out after ${ms}ms`);
      e.code = TOOL_TIMEOUT_CODE;
      throw e;
    }
    if (externalSignal?.aborted) {
      throw makeAbortError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

function makeAbortError(): Error {
  const e: any = new Error('Operation cancelled');
  e.code = 'aborted';
  e.name = 'AbortError';
  return e;
}

/**
 * 任意 throw → 结构化错误 envelope. 不抛, 返回。
 *
 *   safeError(err)              → { error: '...', code: '...' }
 *   safeError(err, 'edit_file') → 同上, 额外打 debug log 带 toolName
 *
 * 已知 code:
 *   - aborted        : 用户/上游中断, 不算 tool 失败
 *   - tool_timeout   : withTimeout 触发
 *   - <err.code>     : 原生错误带 code 字段直接透传
 *   - tool_throw     : 兜底, 任何 unhandled throw
 */
const ABORT_CODE_SET = new Set([
  'aborted',
  'ABORT_ERR',                  // node native
  'ERR_HTTP_REQUEST_TIMEOUT',   // node fetch undici
  'ERR_CANCELED',               // axios
  'ECONNABORTED',               // axios + http
  'ABORTED',                    // generic upper
]);
const ABORT_NAME_SET = new Set([
  'AbortError',
  'CanceledError',              // axios v1
  'TimeoutError',               // axios v0 + undici
]);

export function safeError(err: unknown, toolName?: string): ToolEnvelopeError {
  if (err && typeof err === 'object') {
    const e = err as any;
    const code = typeof e.code === 'string' ? e.code : undefined;
    const name = typeof e.name === 'string' ? e.name : undefined;
    /* Abort 判定: 任一 code/name 命中就当 cancelled — 不算 tool 失败. */
    if ((code && ABORT_CODE_SET.has(code)) || (name && ABORT_NAME_SET.has(name))) {
      return { error: 'Operation cancelled', code: 'aborted' };
    }
    if (code) {
      if (toolName) cliLogger.debug('TOOL', `[${toolName}] error ${code}: ${e.message || e}`);
      return {
        error: typeof e.message === 'string' && e.message ? e.message : String(e),
        code,
      };
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (toolName) cliLogger.debug('TOOL', `[${toolName}] uncoded throw: ${msg}`);
  return { error: msg || 'tool failed', code: 'tool_throw' };
}

/**
 * 判定 signal 是否真的因 abort 失败而非 timeout/其他。
 * 返回 'aborted' 表示是 abort, undefined 表示不是 (调用方走正常错误路径)。
 */
export function normalizeAbortReason(signal: AbortSignal | undefined): 'aborted' | undefined {
  if (!signal) return undefined;
  return signal.aborted ? 'aborted' : undefined;
}
