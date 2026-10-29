import { ProjectService } from '../context/ProjectService.js';
import { EMBEDDING_BRIDGE, SEMANTIC_BRIDGE } from '../context/tokens.js';
import { getProjectStartupDiagnostics } from './projectStartupDiagnostics.js';
import { CoalescingScheduler } from '@neoxlabs/platform/shared/scheduling/coalescingScheduler.js';
import { CanceledError, ProgressContext } from '@neoxlabs/platform/shared/async/progressContext.js';
import {
  DUMB_PHASES,
  SMART_PHASES,
  INITIAL_PROJECT_STARTUP_STATUS,
  type DumbAwareState,
  type ProjectStartupPhase,
  type ProjectStartupStatus,
  type ProjectStartupTaskState,
} from '@neoxlabs/platform/shared/projectStartup/types.js';

export type {
  DumbAwareState,
  ProjectStartupPhase,
  ProjectStartupStatus,
  ProjectStartupTaskState,
};

/** Listener 接收每次 status 快照 (已去重合并). */
export type ProjectStartupListener = (status: ProjectStartupStatus) => void;

export interface RunWhenSmartOptions {
  /** 调试标签, 记 diagnostic 用. */
  label?: string;
  /** 总等待超时; 到时抛 CanceledError. 默认无限. */
  timeoutMs?: number;
  /** 外部 AbortSignal; aborted 则取消等待 (reject CanceledError). */
  signal?: AbortSignal;
}

interface PendingSmartTask {
  label: string;
  resolve: (ctx: ProgressContext) => void;
  reject: (err: unknown) => void;
  ctx: ProgressContext;
}

export class ProjectStartupCoordinator extends ProjectService {
  private started = false;
  private runPromise: Promise<void> | null = null;
  private status: ProjectStartupStatus = { ...INITIAL_PROJECT_STARTUP_STATUS };

  // ── DumbService 扩展: 状态订阅 + runWhenSmart 队列 ────────────────────────
  private readonly listeners = new Set<ProjectStartupListener>();
  private readonly pendingSmart: PendingSmartTask[] = [];
  /**
   * 合并高频 status 变更: semantic/embedding/phase 可能在一个 tick 里
   * 同步 flip 三次, 我们只想广播一次.
   */
  private readonly broadcastScheduler = new CoalescingScheduler({
    delayMs: 8,
    maxDelayMs: 40,
  });

  notifyRendererReady(reason = 'renderer-ready'): { started: boolean } {
    this.setStatus({ rendererReady: true });
    if (this.started) return { started: false };

    this.started = true;
    this.setStatus({ started: true, phase: 'interactive' });
    this.runPromise = this.run(reason).catch((error) => {
      if (this.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        phase: 'failed',
        error: message,
        semantic: this.status.semantic === 'running' ? 'failed' : this.status.semantic,
        embedding: this.status.embedding === 'running' ? 'failed' : this.status.embedding,
      });
      console.error('[ProjectStartupCoordinator] startup failed:', error);
    });
    return { started: true };
  }

  getStatus(): ProjectStartupStatus {
    return { ...this.status };
  }

  /** 当前是否处于 DumbMode (索引/初始化中, 功能应降级). */
  isDumb(): boolean {
    return DUMB_PHASES.has(this.status.phase);
  }

  /** 当前是否处于 SmartMode (可以安全调 semantic / rename / find usages). */
  isSmart(): boolean {
    return SMART_PHASES.has(this.status.phase);
  }

  /** 启动失败. 既不 dumb 也不 smart —— UI 应提示用户重建索引. */
  isFailed(): boolean {
    return this.status.phase === 'failed';
  }

  /** 三分状态别名, 给 UI 做 switch 用. */
  dumbAwareState(): DumbAwareState {
    if (this.isFailed()) return 'failed';
    return this.isSmart() ? 'smart' : 'dumb';
  }

  /**
   * 订阅 status 变更. 返回 unsubscribe.
   * 监听器在广播合并窗口 (默认 8ms) 后收到最新快照, 所以短时间内多次
   * setStatus 只触发一次回调.
   */
  onChange(listener: ProjectStartupListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * IntelliJ `DumbService.runWhenSmart` 对应物.
   *
   * 行为:
   *   - 当前已 smart → 立即以 in-flight ProgressContext 调用 fn.
   *   - 当前 dumb → 放入 pending 队列, 转 smart 时按入队顺序执行.
   *   - 当前 failed / scope disposed / timeout → reject CanceledError.
   *
   * 返回 Promise, resolve 为 fn 的返回值.
   */
  runWhenSmart<T>(
    fn: (ctx: ProgressContext) => Promise<T> | T,
    options: RunWhenSmartOptions = {},
  ): Promise<T> {
    const label = options.label ?? 'runWhenSmart';

    if (this.signal.aborted) {
      return Promise.reject(new CanceledError(`${label}: coordinator disposed`));
    }
    if (this.isFailed()) {
      return Promise.reject(new CanceledError(`${label}: startup failed`));
    }

    if (this.isSmart()) {
      const ctx = new ProgressContext({
        parent: undefined,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        label,
      });
      return Promise.resolve()
        .then(() => fn(ctx))
        .finally(() => ctx.dispose());
    }

    // dumb 或 opening: 排队等 smart
    return new Promise<T>((resolve, reject) => {
      const ctx = new ProgressContext({
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        label,
      });

      const task: PendingSmartTask = {
        label,
        ctx,
        resolve: (runCtx) => {
          Promise.resolve()
            .then(() => fn(runCtx))
            .then(resolve, reject)
            .finally(() => runCtx.dispose());
        },
        reject: (err) => {
          ctx.dispose();
          reject(err);
        },
      };

      // 外部 signal / timeout 触发时, 从队列里清掉并 reject
      ctx.onCanceled((reason) => {
        const idx = this.pendingSmart.indexOf(task);
        if (idx >= 0) this.pendingSmart.splice(idx, 1);
        reject(reason ?? new CanceledError(`${label}: canceled`));
      });

      this.pendingSmart.push(task);
    });
  }

  // ── 内部: 状态 setter 与广播 ────────────────────────────────────────────

  /** 合并式 status 修改. 只有字段确实变了才 broadcast. */
  private setStatus(partial: Partial<ProjectStartupStatus>): void {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof ProjectStartupStatus>) {
      const nextValue = partial[key];
      if (nextValue === undefined) continue;
      if (this.status[key] !== nextValue) {
        (this.status as unknown as Record<string, unknown>)[key] = nextValue;
        changed = true;
      }
    }
    if (!changed) return;

    // smart 首次达到 → flush pending runWhenSmart 任务
    if (this.isSmart() && this.pendingSmart.length > 0) {
      this.flushPendingSmart();
    }

    // failed → 全部 reject
    if (this.isFailed() && this.pendingSmart.length > 0) {
      const toReject = this.pendingSmart.splice(0);
      const failErr = new CanceledError(`startup failed: ${this.status.error ?? 'unknown'}`);
      for (const t of toReject) t.reject(failErr);
    }

    this.broadcast();
  }

  private broadcast(): void {
    if (this.signal.aborted) return;
    this.broadcastScheduler.schedule({
      identity: 'broadcast-status',
      run: () => {
        const snapshot = this.getStatus();
        // 1. main 进程内的订阅者 (其他 service 可能用 runWhenSmart 代替)
        for (const listener of Array.from(this.listeners)) {
          try { listener(snapshot); } catch (err) {
            console.error('[ProjectStartupCoordinator] listener threw:', err);
          }
        }
        // 2. 推给 renderer —— 替代原本 500ms 轮询 + 拉取的模式
        try {
          const wc = this.window.webContents;
          if (!wc.isDestroyed()) {
            wc.send('project-startup:state-changed', snapshot);
          }
        } catch (err) {
          // 窗口已关 / 进程已退出 → 安全忽略
          console.debug('[ProjectStartupCoordinator] webContents.send failed:', err);
        }
      },
    });
  }

  private flushPendingSmart(): void {
    if (this.pendingSmart.length === 0) return;
    const batch = this.pendingSmart.splice(0);
    for (const task of batch) {
      if (task.ctx.isCanceled) continue;  // 外部 signal / timeout 已取消
      task.resolve(task.ctx);
    }
  }

  // ── 启动主流程 (原逻辑, 仅替换 this.status.xxx = ... 为 setStatus) ─────────

  private async run(reason: string): Promise<void> {
    const diagnostics = getProjectStartupDiagnostics(this.workspacePath);
    diagnostics.markPhaseStart('project-startup-total', { reason });
    diagnostics.log('project-startup:begin', { reason });

    this.ensureActive();
    this.setStatus({ phase: 'scanning', semantic: 'running', embedding: 'running' });

    const semanticBridge = this.scope.getService(SEMANTIC_BRIDGE);
    const embeddingBridge = this.scope.getService(EMBEDDING_BRIDGE);

    diagnostics.markPhaseStart('project-startup-set-workspace');
    await Promise.all([
      semanticBridge.setWorkspace(this.workspacePath, { startBackground: false }),
      embeddingBridge.setWorkspace(this.workspacePath, { startBackground: false }),
    ]);
    diagnostics.markPhaseEnd('project-startup-set-workspace');

    const updatePhase = (): void => {
      if (this.status.semantic === 'ready' && this.status.embedding === 'ready') {
        this.setStatus({ phase: 'ready' });
      } else if (this.status.semantic === 'ready') {
        this.setStatus({ phase: 'enriching' });
      } else if (this.status.embedding === 'ready') {
        // embedding 先完, 等 semantic → 仍然算 smart 的过渡状态. IDEA 传统里
        // embedding 不触发 smart, 这里沿用: 必须 semantic ready 才 >= smart.
        this.setStatus({ phase: 'scanning' });
      } else {
        this.setStatus({ phase: 'scanning' });
      }
    };

    const semanticTask = semanticBridge.startBootstrapIfNeeded('startup-coordinator').then(() => {
      this.ensureActive();
      this.setStatus({ semantic: 'ready' });
      // semantic ready → 第一次进入 smart, 立即 flush queue
      if (this.status.embedding !== 'ready') {
        this.setStatus({ phase: 'smart' });
      }
      updatePhase();
      diagnostics.log('project-startup:semantic-ready');
    });

    const embeddingTask = embeddingBridge.buildIndex(false).then(() => {
      this.ensureActive();
      this.setStatus({ embedding: 'ready' });
      updatePhase();
      diagnostics.log('project-startup:embedding-ready');
    });

    await Promise.all([semanticTask, embeddingTask]);

    this.ensureActive();
    this.setStatus({ phase: 'ready', completed: true });
    diagnostics.log('project-startup:ready');
    diagnostics.markPhaseEnd('project-startup-total', {
      semantic: this.status.semantic,
      embedding: this.status.embedding,
    });
  }

  private ensureActive(): void {
    if (this.signal.aborted) {
      throw new Error('project startup aborted');
    }
  }

  dispose(): void {
    this.runPromise = null;
    this.broadcastScheduler.dispose();
    this.listeners.clear();
    if (this.pendingSmart.length > 0) {
      const toReject = this.pendingSmart.splice(0);
      const disposed = new CanceledError('project coordinator disposed');
      for (const t of toReject) t.reject(disposed);
    }
  }
}
