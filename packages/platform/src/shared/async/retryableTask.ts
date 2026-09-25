/**
 * retryableTask —— IntelliJ `NonBlockingReadAction` 的 TypeScript 对应物.
 *
 * 核心思想: 后台任务被外部事件 (文档编辑、write intent) 打断时, 如果前置条件
 * 仍然成立, 就在新的 ProgressContext 里重新跑, 而不是失败放弃. 最多重试
 * `maxRetries` 次, 或外层 ctx / 显式 shouldRetry 表达"不要再跑".
 *
 * 这让业务代码能写成 "读-计算-交付" 的天真风格, 不需要自己处理 generation /
 * race condition. 语义搜索、AST 重解析、索引查询都应该走这里.
 *
 * 用法:
 * ```ts
 * const outer = ProgressContext.detached('semantic-search');
 * const result = await runRetryable(
 *   (ctx) => semanticService.resolve(query, ctx),
 *   { outerCtx: outer, conditions: [() => project.isReady()] },
 *);
 * ```
 */
import { CanceledError, isCanceledError, ProgressContext } from './progressContext.js';

export interface RetryableOptions<_T> {
  /**
   * 外层 ctx —— 通常绑定 editor / session / tab 的生命周期.
   * outer.isCanceled=true 则不再重试, 直接把 CanceledError 向上抛.
   * (undefined 时内部会 detached, 但那样就没人能"真正停止"了, 建议总是传.)
   */
  outerCtx?: ProgressContext;
  /** 最大重试次数 (不含首次执行). 默认 3. 0 = 不重试. */
  maxRetries?: number;
  /** 每次重试前等待的毫秒. 默认 0. 可设为渐进式, 见 `retryDelayMs`=function. */
  retryDelayMs?: number | ((attempt: number) => number);
  /**
   * 重试前检查的条件. 任一返回 false 都放弃 (向上抛 CanceledError).
   * 例如: `[() => !document.isBeingEdited(),  => project.isIndexed()]`
   */
  conditions?: Array<() => boolean>;
  /**
   * 自定义: 给定失败原因 + 当前已重试次数, 是否继续?
   * 默认实现: "只重试 CanceledError 且 attempt < maxRetries".
   */
  shouldRetry?: (reason: unknown, attempt: number) => boolean;
  /** 调试标签. 默认 'retryable'. */
  label?: string;
  /** 单次执行超时. 可与 outerCtx 叠加; 到时视为 CanceledError 走重试路径. */
  perAttemptTimeoutMs?: number;
  /** 额外外部 AbortSignal —— 触发后等价于 outerCtx 被 cancel. */
  signal?: AbortSignal;
  /** 重试时的 hook (主要用于日志 / metrics). */
  onRetry?: (reason: unknown, nextAttempt: number) => void;
}

export async function runRetryable<T>(
  fn: (ctx: ProgressContext) => Promise<T> | T,
  options: RetryableOptions<T> = {},
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const delaySpec = options.retryDelayMs ?? 0;
  const label = options.label ?? 'retryable';
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let attempt = 0;
  // attempt = 0 是首次; > 0 是重试.
  // 总执行次数上限 = maxRetries + 1.
  for (;;) {
    // 外层终止检查: outer ctx / 附加 signal 已终止, 直接退出.
    if (options.outerCtx?.isCanceled) {
      throw toCanceledError(options.outerCtx.reason, `${label}: outer canceled`);
    }
    if (options.signal?.aborted) {
      throw toCanceledError(options.signal.reason, `${label}: signal aborted`);
    }

    // 条件前置校验 (首次也校验, 避免浪费)
    if (!checkConditions(options.conditions)) {
      throw new CanceledError(`${label}: preconditions not met`);
    }

    const attemptCtx = new ProgressContext({
      parent: options.outerCtx,
      signal: options.signal,
      label: `${label}#${attempt}`,
      timeoutMs: options.perAttemptTimeoutMs,
    });

    try {
      return await Promise.resolve(fn(attemptCtx));
    } catch (err) {
      attemptCtx.dispose();
      // 外层已终止, 直接抛; 即使是 CanceledError 也不重试.
      if (options.outerCtx?.isCanceled) {
        throw toCanceledError(options.outerCtx.reason, `${label}: outer canceled`);
      }
      if (options.signal?.aborted) {
        throw toCanceledError(options.signal.reason, `${label}: signal aborted`);
      }
      if (attempt >= maxRetries) throw err;
      if (!shouldRetry(err, attempt)) throw err;

      attempt += 1;
      options.onRetry?.(err, attempt);

      const delay = typeof delaySpec === 'function' ? delaySpec(attempt) : delaySpec;
      if (delay > 0) {
        await sleepWithCancel(delay, options.outerCtx, options.signal);
      }
    } finally {
      attemptCtx.dispose();
    }
  }
}

function defaultShouldRetry(reason: unknown, _attempt: number): boolean {
  return isCanceledError(reason);
}

function checkConditions(conditions: Array<() => boolean> | undefined): boolean {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    try {
      if (!c()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function toCanceledError(reason: unknown, fallbackMsg: string): Error {
  // 归一化: 所有"取消"路径对外都抛 CanceledError, 上层一次 catch 即可.
  // 原始 reason (AbortError / DOMException 等) 通过 `cause` 保留以供调试.
  if (reason instanceof CanceledError) return reason;
  if (reason instanceof Error) {
    const wrapped = new CanceledError(`${fallbackMsg}: ${reason.message}`);
    (wrapped as { cause?: unknown }).cause = reason;
    return wrapped;
  }
  if (typeof reason === 'string') return new CanceledError(reason);
  return new CanceledError(fallbackMsg);
}

function sleepWithCancel(ms: number, outer?: ProgressContext, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      unsubOuter();
      unsubSignal();
      resolve();
    }, ms);

    const unsubOuter = outer
      ? outer.onCanceled((reason) => {
          clearTimeout(handle);
          unsubSignal();
          reject(toCanceledError(reason, 'retry-sleep: outer canceled'));
        })
      : () => { /* no-op */ };

    const onSignalAbort = () => {
      clearTimeout(handle);
      unsubOuter();
      reject(toCanceledError(signal?.reason, 'retry-sleep: signal aborted'));
    };
    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });
    const unsubSignal = signal
      ? () => signal.removeEventListener('abort', onSignalAbort)
      : () => { /* no-op */ };
  });
}
