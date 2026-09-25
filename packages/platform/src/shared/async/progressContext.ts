/**
 * ProgressContext —— IntelliJ `ProgressManager.checkCanceled` + `ProgressIndicator`
 * 的 TypeScript 对应物, 基于 Web/Node `AbortController` 实现.
 *
 * 这是 Phase 1 的核心: 所有长任务 (LLM 补全、语义搜索、格式化、索引扫描)
 * 都应该拿一个 ProgressContext, 定期调用 `checkCanceled()`. 外层 UI 事件
 * (新按键、新选中、切 tab) 把原来的 context cancel 掉即可.
 *
 * 关键特性:
 *   1. 级联取消: `parent.child()` 返回的 ctx 会随 parent 一起取消.
 *   2. 外部 AbortSignal 适配: `ProgressContext.fromAbortSignal(signal)` 无缝嫁接.
 *   3. 统一 CanceledError: 所有取消路径抛同一类错误, 上层 try/catch 一次.
 *   4. onCanceled 订阅: 用于清理 inflight 请求 / IPC abort 等副作用.
 */

export class CanceledError extends Error {
  constructor(message = 'operation canceled') {
    super(message);
    this.name = 'CanceledError';
  }
}

export function isCanceledError(err: unknown): boolean {
  if (err instanceof CanceledError) return true;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'CanceledError' || name === 'AbortError') return true;
  return false;
}

export interface ProgressContextOptions {
  /** 调试用标签. */
  readonly label?: string;
  /** 创建时已触发的 AbortSignal. 若已 aborted, ctx 立即进入 canceled. */
  readonly signal?: AbortSignal;
  /** 父 ctx; 父取消后自动触发子取消. */
  readonly parent?: ProgressContext;
  /** 超时毫秒数; 到时自动取消. */
  readonly timeoutMs?: number;
}

type CancelListener = (reason: unknown) => void;

export class ProgressContext {
  readonly label: string;
  private readonly controller: AbortController;
  private readonly listeners = new Set<CancelListener>();
  private cancelReason: unknown = undefined;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private parentUnsubscribe: (() => void) | null = null;
  private externalUnsubscribe: (() => void) | null = null;

  constructor(options: ProgressContextOptions = {}) {
    this.label = options.label ?? 'progress';
    this.controller = new AbortController();

    if (options.signal) this.attachExternalSignal(options.signal);
    if (options.parent) this.attachParent(options.parent);
    if (options.timeoutMs !== undefined && options.timeoutMs >= 0) {
      this.timeoutHandle = setTimeout(
        () => this.cancel(new CanceledError(`${this.label}: timeout after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }
  }

  /** 工厂: 包装一个外部 AbortSignal (Monaco CancellationToken 转过来). */
  static fromAbortSignal(signal: AbortSignal, label?: string): ProgressContext {
    return new ProgressContext({ signal, label });
  }

  /** 工厂: detached context, 只能通过本身 cancel() 关闭. */
  static detached(label?: string): ProgressContext {
    return new ProgressContext({ label });
  }

  /** 该 ctx 是否已被取消. */
  get isCanceled(): boolean {
    return this.controller.signal.aborted;
  }

  /** 暴露给 fetch() / IPC 的 AbortSignal. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 取消原因 (最近一次的). */
  get reason(): unknown {
    return this.cancelReason;
  }

  /**
   * 协作式检查点. 已取消则抛 CanceledError.
   * 长任务应在每次迭代/分块处理后调用. 若任务是 tight-loop, 每 1000 次
   * 迭代调用一次足以 (函数调用本身 <1μs, 但避免热路径上抛异常).
   */
  checkCanceled(): void {
    if (this.isCanceled) {
      const reason = this.cancelReason ?? new CanceledError(`${this.label}: canceled`);
      if (reason instanceof Error) throw reason;
      throw new CanceledError(typeof reason === 'string' ? reason : `${this.label}: canceled`);
    }
  }

  /**
   * 取消此 ctx (及其所有 child). 幂等. 外部 abort / timeout / 手动均走这里.
   */
  cancel(reason?: unknown): void {
    if (this.isCanceled) return;
    this.cancelReason = reason ?? new CanceledError(`${this.label}: canceled`);
    this.clearTimeout_internal();
    this.controller.abort(this.cancelReason);
    for (const listener of this.listeners) {
      try { listener(this.cancelReason); } catch { /* 不让一个听众爆炸影响别人 */ }
    }
    this.listeners.clear();
    this.detachParent();
    this.detachExternal();
  }

  /** 注册一个 cancel 时的回调. 若 ctx 已 canceled, 立即触发. 返回解绑函数. */
  onCanceled(listener: CancelListener): () => void {
    if (this.isCanceled) {
      try { listener(this.cancelReason); } catch { /* swallow */ }
      return () => { /* no-op */ };
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 派生子 ctx. 子会随父一起取消; 子单独 cancel 不影响父. */
  child(label?: string, timeoutMs?: number): ProgressContext {
    return new ProgressContext({
      parent: this,
      label: label ?? `${this.label}.child`,
      timeoutMs,
    });
  }

  /**
   * 把一个 Promise 包起来, 让它在 ctx 取消时立即 reject (不等原 Promise).
   * 原始任务仍在跑 —— 真正的取消需要任务本身配合 `signal`.
   */
  race<T>(promise: Promise<T>): Promise<T> {
    if (this.isCanceled) {
      return Promise.reject(this.cancelReason ?? new CanceledError(`${this.label}: canceled`));
    }
    return new Promise<T>((resolve, reject) => {
      const unsub = this.onCanceled((reason) => reject(reason ?? new CanceledError(`${this.label}: canceled`)));
      promise.then(
        (v) => { unsub(); resolve(v); },
        (e) => { unsub(); reject(e); },
      );
    });
  }

  /** 释放资源但不取消. 若你只想停订阅 parent / timer. */
  dispose(): void {
    this.clearTimeout_internal();
    this.detachParent();
    this.detachExternal();
    this.listeners.clear();
  }

  // ── private ─────────────────────────────────────────────────────────────

  private attachParent(parent: ProgressContext): void {
    if (parent.isCanceled) {
      this.cancel(parent.reason ?? new CanceledError(`${this.label}: parent canceled`));
      return;
    }
    this.parentUnsubscribe = parent.onCanceled((reason) => {
      this.cancel(reason ?? new CanceledError(`${this.label}: parent canceled`));
    });
  }

  private attachExternalSignal(signal: AbortSignal): void {
    if (signal.aborted) {
      this.cancel(signal.reason ?? new CanceledError(`${this.label}: external signal aborted`));
      return;
    }
    const onAbort = () => {
      this.cancel(signal.reason ?? new CanceledError(`${this.label}: external signal aborted`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.externalUnsubscribe = () => signal.removeEventListener('abort', onAbort);
  }

  private detachParent(): void {
    if (this.parentUnsubscribe) {
      try { this.parentUnsubscribe(); } catch { /* swallow */ }
      this.parentUnsubscribe = null;
    }
  }

  private detachExternal(): void {
    if (this.externalUnsubscribe) {
      try { this.externalUnsubscribe(); } catch { /* swallow */ }
      this.externalUnsubscribe = null;
    }
  }

  private clearTimeout_internal(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
