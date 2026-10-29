/**
 * Scope —— 抽象基类: 一个"作用域容器"
 *
 * IDEA `ComponentManagerImpl` 的 JS 等价物.
 *
 * 核心职责
 * --------
 * 1. **服务注册表** (ServiceRegistry) —— 按 token 存 Holder, lazy 实例化
 * 2. **parent 链 fallback** —— 本 scope 找不到的 service 沿 parent 上溯
 * 3. **AbortController** —— scope 关闭时 abort, 所有监听此 signal 的 async op 自动取消
 * 4. **DisposableTree** —— 回调栈, 反向执行 (LIFO, IDEA ObjectTree 风格)
 * 5. **ScopedEventBus** —— 作用域内的事件总线, parent 指向上级 scope 的 bus
 *
 * 子类需要做的事
 * -------------
 * - 调 `super({ parent, level })`
 * - 在 constructor body 里注册自己的 service
 * - 添加自己的字段 (比如 ProjectScope 的 workspacePath / window)
 */

import { ServiceRegistry } from './ServiceRegistry.js';
import { ScopedEventBus } from './ScopedEventBus.js';
import type { ServiceToken, DisposableNode } from './types.js';

export interface ScopeInitOptions {
  parent: Scope | null;
  level: 'app' | 'project';
}

export abstract class Scope {
  readonly parent: Scope | null;
  readonly level: 'app' | 'project';

  /**
   * AbortController —— scope 关闭时 abort().
   * 所有 project 级的 fetch / timer / 长连接都应该拿这个 signal, scope dispose
   * 时 async op 自动取消, 无需手动 cleanup.
   */
  readonly abortController: AbortController;

  /** 作用域事件总线 (parent 链用于 level 隔离) */
  readonly bus: ScopedEventBus;

  protected readonly registry: ServiceRegistry;
  protected readonly disposables: DisposableNode[] = [];
  protected _disposed = false;

  protected constructor(options: ScopeInitOptions) {
    this.parent = options.parent;
    this.level = options.level;
    this.abortController = new AbortController();
    this.registry = new ServiceRegistry();
    this.bus = new ScopedEventBus(options.level, options.parent?.bus ?? null);
  }

  /** scope 关闭后为 true. 任何 get/register/onDispose 都会抛错. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** AbortController.signal 的便捷访问 */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Service 注册 / 查找
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 注册一个 service factory (lazy).
   * 同 token 重复注册抛错.
   */
  register<T>(token: ServiceToken<T>, factory: (scope: this) => T): void {
    this.assertNotDisposed();
    this.registry.register(token, () => factory(this));
  }

  /**
   * 拿 service. 第一次 get 触发 factory.
   * 本 scope 找不到时沿 parent 链 fallback.
   */
  getService<T>(token: ServiceToken<T>): T {
    this.assertNotDisposed();
    const holder = this.registry.find(token);
    if (holder) return holder.getInstance();
    if (this.parent) return this.parent.getService(token);
    throw new Error(`Service "${token.name}" not registered in ${this.level} scope chain`);
  }

  /**
   * 安全版本: 不抛错, 返回 undefined.
   */
  tryGetService<T>(token: ServiceToken<T>): T | undefined {
    if (this._disposed) return undefined;
    const holder = this.registry.find(token);
    if (holder) return holder.getInstance();
    if (this.parent) return this.parent.tryGetService(token);
    return undefined;
  }

  /**
   * 只读取已实例化的 service, 不触发构造。
   */
  peekService<T>(token: ServiceToken<T>): T | undefined {
    if (this._disposed) return undefined;
    const holder = this.registry.find(token);
    if (holder) return holder.tryGetInstance();
    if (this.parent) return this.parent.peekService(token);
    return undefined;
  }

  /**
   * 检查 service 是否已注册 (不触发实例化).
   */
  hasService<T>(token: ServiceToken<T>): boolean {
    if (this._disposed) return false;
    if (this.registry.find(token)) return true;
    return this.parent?.hasService(token) ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Dispose 链
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 注册一个 dispose 回调. scope.dispose() 时反向执行 (LIFO).
   *
   * 通常由 ProjectService 基类在构造时自动调用, 业务代码不直接用.
   */
  onDispose(fn: () => void | Promise<void>, label?: string): void {
    this.assertNotDisposed();
    this.disposables.push({ fn, label });
  }

  /**
   * 释放 scope.
   *
   * 执行顺序:
   *   1. 标记 disposed 防止新的注册
   *   2. abort() —— 立刻让所有监听 signal 的 async op 取消
   *   3. 反向遍历 disposables, 逐个执行 (单个抛错不影响其他)
   *   4. 清空 registry (释放 holder 引用)
   *   5. 清空 event bus
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    // 1. abort signal
    try {
      this.abortController.abort();
    } catch {
      /* ignore */
    }

    // 2. 反向执行 disposables
    for (let i = this.disposables.length - 1; i >= 0; i--) {
      const node = this.disposables[i];
      try {
        await node.fn();
      } catch (err) {
        console.error(
          `[Scope:${this.level}] dispose callback ${node.label ?? '<anonymous>'} threw:`,
          err,
        );
      }
    }
    this.disposables.length = 0;

    // 3. 清 registry
    this.registry.dispose();

    // 4. 清 bus
    this.bus.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════════════

  protected assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(`Scope (${this.level}) has been disposed`);
    }
  }
}
