/**
 * SessionScope is the single source of truth for the active session context.
 * Session-scoped stores prevent mutable runtime state from leaking between
 * concurrently served sessions.
 *
 * AsyncLocalStorage carries the scope without adding session identifiers to
 * every function signature.
 *
 * The primitive centralizes session context in one AsyncLocalStorage and a
 * SessionScopedStore<T> that maps module state to the active session.
 *   - 一个 ALS 携带 { sessionId, workspaceRoot }
 *   - 一个 SessionScopedStore<T> —— 把"module-level let"改成"按会话分桶"只需一行
 *
 * ## Inheritance
 *
 * 读某个会话的桶时, **桶不存在就读默认桶**, 而不是直接造一个新的初值。这样:
 *   - CLI / 单会话场景: 没人开 scope, 读写都落默认桶 → 行为跟改造前一字不差
 *   - 桌面多会话: 谁没单独设过就继承全局默认, 设过的只影响自己
 * 反过来做 (每个会话独立初值) 会让"CLI 里 /sandbox read-only 设完立刻失效"。
 *
 * ## Generators
 *
 * ALS 不跨 `yield` 传播 —— 异步生成器每次 next() 是在**调用方**的上下文里恢复的。
 * 所以不要试图把 `runner.run()` 整个包进来 (包了也不生效, 还会给人"已经隔离了"的错觉);
 * 正确做法是包在真正读这些状态的那几段同步/异步调用外面 (工具调用、prompt 组装)。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SessionScope {
  /** 会话 id。空串 / undefined 一律折算成默认桶。 */
  sessionId?: string;
  /** 该会话的工作区根目录 —— 跟 sessionId 一起走, 免得再包一层 ALS。 */
  workspaceRoot?: string;
}

/** 没有会话上下文时用的桶名。CLI / SDK / 测试都落在这里。 */
export const DEFAULT_SESSION_SCOPE = '__default__';

const als = new AsyncLocalStorage<SessionScope>();

/** 在给定会话上下文里跑一段代码。返回值原样透传 (同步/异步都行)。 */
export function runWithSessionScope<T>(scope: SessionScope, fn: () => T): T {
  /* 没有 sessionId 就不必开一层 —— 保持调用栈干净, 也让默认桶语义更显然 */
  if (!scope?.sessionId && !scope?.workspaceRoot) return fn();
  return als.run(scope, fn);
}

/** 当前会话上下文 (没有则 undefined)。 */
export function getSessionScope(): SessionScope | undefined {
  return als.getStore();
}

/** 当前会话的桶名 —— 所有 SessionScopedStore 的默认 key。 */
export function currentSessionScopeId(): string {
  const sid = als.getStore()?.sessionId;
  return sid && sid.trim() ? sid : DEFAULT_SESSION_SCOPE;
}

/** 当前会话的工作区根 (没有则 undefined) —— 给需要它又拿不到 runner 引用的地方用。 */
export function currentSessionWorkspaceRoot(): string | undefined {
  return als.getStore()?.workspaceRoot;
}

/**
 * 按会话分桶的状态容器。
 *
 * 用法 (把一个 module-level let 改成按会话隔离):
 *
 *     // 改造前: let state = createInitialState();
 *     const store = new SessionScopedStore(createInitialState);
 *     // 读: store.get()      写: store.set(next) / store.update(s => ...)
 *
 * 桶数有上限 + LRU 淘汰 —— 长期运行的 daemon 会话 id 是无限的, 不设上限就是
 * "无上限的按会话缓存"那一族内存泄漏。默认桶永不淘汰。
 */
export interface SessionScopedStoreOptions {
  /** 桶数上限, 超了按 LRU 淘汰 (默认桶不淘汰)。 */
  maxScopes?: number;
  /**
   * 会话没有自己的桶时怎么办:
   *   true  (默认) —— **继承默认桶**。适合"设置"类状态 (sandbox 档、项目指令指针):
   *                    CLI 设一次全程生效, 会话单独设过才分家。
   *   false —— 每个会话独立初值。适合"运行时"状态 (压缩熔断器、本轮计划、
   *                    写文件账本): 这类共享等于串味, 没有"继承全局默认"的语义。
   */
  inherit?: boolean;
}

export class SessionScopedStore<T> {
  private readonly buckets = new Map<string, { value: T; touchedAt: number }>();
  private readonly maxScopes: number;
  private readonly inherit: boolean;

  constructor(
    private readonly factory: () => T,
    options: SessionScopedStoreOptions = {},
  ) {
    this.maxScopes = options.maxScopes ?? 64;
    this.inherit = options.inherit ?? true;
  }

  /** 读当前会话的值。没有自己的桶时: inherit=true 读默认桶, inherit=false 造独立初值。 */
  get(scope: string = currentSessionScopeId()): T {
    const own = this.buckets.get(scope);
    if (own) {
      own.touchedAt = Date.now();
      return own.value;
    }
    if (this.inherit && scope !== DEFAULT_SESSION_SCOPE) {
      const fallback = this.buckets.get(DEFAULT_SESSION_SCOPE);
      if (fallback) {
        fallback.touchedAt = Date.now();
        return fallback.value;
      }
    }
    const created = this.factory();
    /* inherit 模式下初值落**默认桶** (让后续会话继续继承同一份);
     * 非 inherit 模式落本会话自己的桶。 */
    const target = this.inherit ? DEFAULT_SESSION_SCOPE : scope;
    this.buckets.set(target, { value: created, touchedAt: Date.now() });
    this.evictIfNeeded();
    return created;
  }

  /** 该会话是否有自己的桶 (没有 = 正在继承默认值)。 */
  hasOwn(scope: string = currentSessionScopeId()): boolean {
    return this.buckets.has(scope);
  }

  set(value: T, scope: string = currentSessionScopeId()): void {
    this.buckets.set(scope, { value, touchedAt: Date.now() });
    this.evictIfNeeded();
  }

  /** 就地改 —— 语义等于 set(fn(get()))，省掉调用方自己取一遍。 */
  update(fn: (current: T) => T, scope: string = currentSessionScopeId()): T {
    const next = fn(this.get(scope));
    this.set(next, scope);
    return next;
  }

  /** 清掉某个会话的桶 (会话结束时调) —— 之后它会回到继承默认值。 */
  clearScope(scope: string = currentSessionScopeId()): void {
    this.buckets.delete(scope);
  }

  /** 全清 —— 只给 /clear 和测试用。 */
  clearAll(): void {
    this.buckets.clear();
  }

  /** 当前有几个桶 —— 泄漏排查用。 */
  size(): number {
    return this.buckets.size;
  }

  private evictIfNeeded(): void {
    if (this.buckets.size <= this.maxScopes) return;
    const victims = [...this.buckets.entries()]
      .filter(([key]) => key !== DEFAULT_SESSION_SCOPE)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .slice(0, this.buckets.size - this.maxScopes);
    for (const [key] of victims) this.buckets.delete(key);
  }
}

/** 所有已注册的 store —— 会话结束时一次性清干净, 免得每加一个 store 就要去改清理点。 */
const registry = new Set<{ clearScope: (scope?: string) => void }>();

/** 建一个"会话结束会被自动清理"的 store。除非你确实想手动管生命周期, 都用这个。 */
export function createSessionScopedStore<T>(
  factory: () => T,
  options?: SessionScopedStoreOptions,
): SessionScopedStore<T> {
  const store = new SessionScopedStore<T>(factory, options);
  registry.add(store);
  return store;
}

/** 会话结束 (evict / 关闭 / /clear) 时调 —— 把这个会话在所有 store 里的桶都清掉。 */
export function disposeSessionScope(sessionId: string): void {
  if (!sessionId || !sessionId.trim()) return;
  for (const store of registry) store.clearScope(sessionId);
}

/** 仅测试用: 把所有 store 清空。 */
export function __resetAllSessionScopedStores(): void {
  for (const store of registry) (store as SessionScopedStore<unknown>).clearAll();
}
