/**
 * WriteIntentRegistry —— IntelliJ `WriteAction` / 读写锁的 TypeScript 对应物.
 *
 * 设计核心
 * --------
 * IntelliJ 的 ReadAction/WriteAction 保证 "分析任务永远看不到半写状态":
 *   1. 后台 NonBlockingReadAction 跑在读锁里
 *   2. Write 要跑时, 所有 non-blocking read 立即被 cancel
 *   3. Write 完成后, 被 cancel 的 read 按 retry 策略重新跑
 *
 * Neox 的场景对照:
 *   - Agent apply 批量 edit  →  write intent (files=[涉及的文件])
 *   - 用户保存文件            →  write intent (files=[该文件])
 *   - inline-edit 流式改写    →  write intent
 *   - Semantic 搜索 / Hover   →  read intent
 *   - Cmd+T / Find Usages    →  read intent
 *
 * 冲突判定:
 *   - write intent 的 files 与 read intent 的 files 有交集 → 冲突
 *   - workspace-level write intent (files=[] 或 workspace=true) → 与所有 read 冲突
 *   - workspace-level read intent → 与所有 write 冲突
 *
 * 与 P1 基础设施的协作:
 *   - read 侧用 `registerRead(ctx, ...)` 把 ProgressContext 绑到 registry
 *   - 冲突触发时 → registry 调 ctx.cancel(new WriteIntentConflict)
 *   - 任务抛 CanceledError → 上层 retryableTask (若包裹) 自动重跑
 */
import { CanceledError, ProgressContext } from './progressContext.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WriteIntentOptions {
  /**
   * 涉及的文件路径 (绝对路径). 空数组 = workspace 级 intent, 与所有 read 冲突.
   * 用于支持"这个 write 只影响某几个文件"的精确匹配 —— Hover 无关文件的
   * read 不会被误伤.
   */
  files?: string[];
  /** 调试/日志标签, e.g. 'inline-edit', 'agent-apply', 'save'. */
  label: string;
  /**
   * 外部 AbortSignal. signal aborted → registry 自动 end() 这个 intent.
   * 典型场景: inline-edit 的 controller.signal, stream 终止就自动释放.
   */
  signal?: AbortSignal;
  /**
   * 硬超时. 到时自动 end (认为调用方忘了调 end). 默认无限.
   * 建议对所有 write intent 设 60s 上限做保险.
   */
  timeoutMs?: number;
}

export interface WriteIntentToken {
  /** 唯一 ID, 用于 end. */
  readonly id: number;
  readonly label: string;
  readonly files: readonly string[];
  readonly isWorkspaceScope: boolean;
  readonly startedAt: number;
}

export interface ReadIntentOptions {
  /**
   * read 涉及的文件范围. 空数组 = workspace 级 read (所有 write 都冲突).
   * Semantic 搜索 / 命令面板 → workspace 级; Hover on file X → [X].
   */
  files?: string[];
  /** 调试标签. */
  label?: string;
}

export class WriteIntentConflict extends CanceledError {
  constructor(
    public readonly intentLabel: string,
    public readonly intentFiles: readonly string[],
    message?: string,
  ) {
    super(message ?? `read canceled by write intent "${intentLabel}"`);
    this.name = 'WriteIntentConflict';
  }
}

interface ActiveWrite {
  token: WriteIntentToken;
  controller: AbortController;
  /** 清理 signal/timeout 监听 */
  teardown: () => void;
  /** 所有等待这个 intent end 的 waiter */
  waiters: Array<() => void>;
}

interface ActiveRead {
  id: number;
  ctx: ProgressContext;
  files: readonly string[];
  isWorkspaceScope: boolean;
  label: string;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class WriteIntentRegistry {
  private nextId = 1;
  private readonly writes = new Map<number, ActiveWrite>();
  private readonly reads = new Map<number, ActiveRead>();

  /**
   * 声明开始一个写操作. 同步返回 token, 调用方必须在 finally 里调 end(token).
   *
   * 副作用: 所有当前 active reads 的 ctx 会被 cancel (若冲突).
   */
  begin(options: WriteIntentOptions): WriteIntentToken {
    const files = Object.freeze(dedupeAbs(options.files ?? []));
    const isWorkspaceScope = files.length === 0;
    const token: WriteIntentToken = {
      id: this.nextId++,
      label: options.label,
      files,
      isWorkspaceScope,
      startedAt: Date.now(),
    };

    const controller = new AbortController();
    const teardownFns: Array<() => void> = [];

    // 外部 signal → 自动 end
    if (options.signal) {
      if (options.signal.aborted) {
        // 立即返回 token, 但在下一微任务 end (允许调用方拿到 token)
        Promise.resolve().then(() => this.end(token));
      } else {
        const onAbort = () => this.end(token);
        options.signal.addEventListener('abort', onAbort, { once: true });
        teardownFns.push(() => options.signal?.removeEventListener('abort', onAbort));
      }
    }

    // 硬超时
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const handle = setTimeout(() => {
        console.warn(`[WriteIntent] "${options.label}" hit timeout (${options.timeoutMs}ms), auto-end`);
        this.end(token);
      }, options.timeoutMs);
      teardownFns.push(() => clearTimeout(handle));
    }

    const write: ActiveWrite = {
      token,
      controller,
      teardown: () => { for (const fn of teardownFns) { try { fn(); } catch { /* swallow */ } } },
      waiters: [],
    };
    this.writes.set(token.id, write);

    // 取消所有冲突的 active reads
    for (const read of Array.from(this.reads.values())) {
      if (intersects(files, isWorkspaceScope, read.files, read.isWorkspaceScope)) {
        read.ctx.cancel(new WriteIntentConflict(token.label, files));
        this.reads.delete(read.id);
      }
    }

    return token;
  }

  /** 结束 write intent. 幂等; token 无效时 no-op. */
  end(token: WriteIntentToken): void {
    this.endById(token.id);
  }

  /**
   * 按 id 结束 —— 给 IPC 层使用 (跨进程只序列化 id, 不序列化整个 token).
   * 幂等; id 未知时 no-op.
   */
  endById(id: number): boolean {
    const write = this.writes.get(id);
    if (!write) return false;
    this.writes.delete(id);

    write.teardown();
    write.controller.abort();

    // 通知所有 waiter (waitUntilIdle 相关)
    for (const w of write.waiters) {
      try { w(); } catch { /* swallow */ }
    }
    return true;
  }

  /**
   * 注册一个 read ctx. 返回 unregister 函数.
   *
   * 行为:
   *   1. 若当前已有冲突 write intent → 立即 cancel ctx (throws 在 checkCanceled 时)
   *   2. 否则加入 reads map; 后续有冲突 write intent begin → 自动 cancel
   *   3. ctx 自己被 cancel / finish → 自动从 reads map 移除
   */
  registerRead(ctx: ProgressContext, options: ReadIntentOptions = {}): () => void {
    const files = Object.freeze(dedupeAbs(options.files ?? []));
    const isWorkspaceScope = files.length === 0;
    const label = options.label ?? 'read';

    // 立即检查冲突
    for (const write of this.writes.values()) {
      if (intersects(files, isWorkspaceScope, write.token.files, write.token.isWorkspaceScope)) {
        ctx.cancel(new WriteIntentConflict(write.token.label, write.token.files));
        return () => { /* already canceled */ };
      }
    }

    if (ctx.isCanceled) {
      return () => { /* no-op */ };
    }

    const id = this.nextId++;
    const read: ActiveRead = { id, ctx, files, isWorkspaceScope, label };
    this.reads.set(id, read);

    // ctx 自然结束时自动 unregister
    const unsubCtx = ctx.onCanceled(() => {
      this.reads.delete(id);
    });

    return () => {
      this.reads.delete(id);
      unsubCtx();
    };
  }

  /**
   * 高阶包装: 在 read 语义下跑 fn.
   *   - cancel-on-conflict (默认): 有 write intent → ctx 立即 cancel, fn 随之抛错
   *   - wait-then-run: 有 write intent → 等所有冲突的 write 结束再跑 fn
   */
  async runUnderRead<T>(
    fn: (ctx: ProgressContext) => Promise<T> | T,
    options: ReadIntentOptions & {
      parent?: ProgressContext;
      strategy?: 'cancel-on-conflict' | 'wait-then-run';
    } = {},
  ): Promise<T> {
    const strategy = options.strategy ?? 'cancel-on-conflict';

    if (strategy === 'wait-then-run') {
      await this.waitUntilCompatible(options.files ?? []);
    }

    const ctx = new ProgressContext({
      parent: options.parent,
      label: options.label ?? 'read',
    });
    const unregister = this.registerRead(ctx, options);

    try {
      return await Promise.resolve(fn(ctx));
    } finally {
      unregister();
      ctx.dispose();
    }
  }

  /**
   * 等到所有 active write intents 结束 (或超时). 不影响 read.
   * 用于批量 apply 后 "等所有写完再重新搜索索引" 的场景.
   */
  waitUntilIdle(timeoutMs?: number): Promise<void> {
    if (this.writes.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const activeWrites = Array.from(this.writes.values());
      let remaining = activeWrites.length;
      let settled = false;
      const onOne = () => {
        if (settled) return;
        remaining -= 1;
        if (remaining <= 0) {
          settled = true;
          resolve();
        }
      };
      for (const write of activeWrites) {
        write.waiters.push(onOne);
      }

      if (timeoutMs !== undefined && timeoutMs > 0) {
        setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new CanceledError(`waitUntilIdle: timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /** 查询某路径当前是否被任何 write intent 锁住. */
  isLocked(filePath: string): boolean {
    const abs = normalizePath(filePath);
    for (const write of this.writes.values()) {
      if (write.token.isWorkspaceScope) return true;
      if (write.token.files.includes(abs)) return true;
    }
    return false;
  }

  /** 诊断: 当前 active 状态. */
  snapshot(): {
    writes: Array<{ id: number; label: string; files: readonly string[]; isWorkspaceScope: boolean; ageMs: number }>;
    reads: Array<{ id: number; label: string; files: readonly string[]; isWorkspaceScope: boolean }>;
  } {
    const now = Date.now();
    return {
      writes: Array.from(this.writes.values()).map((w) => ({
        id: w.token.id,
        label: w.token.label,
        files: w.token.files,
        isWorkspaceScope: w.token.isWorkspaceScope,
        ageMs: now - w.token.startedAt,
      })),
      reads: Array.from(this.reads.values()).map((r) => ({
        id: r.id,
        label: r.label,
        files: r.files,
        isWorkspaceScope: r.isWorkspaceScope,
      })),
    };
  }

  /** 测试/热重载用: 强制清空所有状态. */
  dispose(): void {
    for (const write of Array.from(this.writes.values())) {
      this.end(write.token);
    }
    for (const read of Array.from(this.reads.values())) {
      read.ctx.cancel(new CanceledError('WriteIntentRegistry disposed'));
    }
    this.reads.clear();
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async waitUntilCompatible(files: readonly string[]): Promise<void> {
    const target = dedupeAbs(files);
    const isWorkspaceScope = target.length === 0;
    while (true) {
      const conflicting = Array.from(this.writes.values()).filter((w) =>
        intersects(target, isWorkspaceScope, w.token.files, w.token.isWorkspaceScope),
      );
      if (conflicting.length === 0) return;
      await Promise.all(
        conflicting.map((w) => new Promise<void>((resolve) => w.waiters.push(resolve))),
      );
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  // 简化: 只处理 trailing slash + backslash → slash. 调用方应传绝对路径.
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function dedupeAbs(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const norm = normalizePath(f);
    if (norm) out.add(norm);
  }
  return Array.from(out);
}

function intersects(
  aFiles: readonly string[],
  aWorkspaceScope: boolean,
  bFiles: readonly string[],
  bWorkspaceScope: boolean,
): boolean {
  // workspace 级 (空 files) 与任何对方都冲突
  if (aWorkspaceScope || bWorkspaceScope) return true;
  // 文件级: 检查交集
  if (aFiles.length === 0 || bFiles.length === 0) return false;
  const setA = new Set(aFiles);
  for (const b of bFiles) {
    if (setA.has(b)) return true;
  }
  return false;
}
