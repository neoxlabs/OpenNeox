/**
 * ServiceRegistry —— 按 token 存储 Holder 的注册表
 *
 * IDEA `InstanceContainerImpl` + `InstanceContainerState` 的 JS 等价物.
 *
 * 数据结构 (跟 IDEA 对齐)
 * -----------------------
 * - 主索引 `holders: Map<string, Holder>` —— 按 token.name 存, 一处注册一次.
 *   String key 跨 bundle / hot-reload 稳定.
 * - Hot-path cache `classCache: WeakMap<Token, Holder>` —— 按 token 对象
 *   reference equality 存. IDEA 源码注释直接写 "String equality on each access
 *   adds up" —— reference equality 跳过字符串哈希, warm service 查找更快.
 *
 * 注册语义:
 * - 同 token 重复注册抛错 (避免静默覆盖)
 * - 不是事务式: 注册一个 token 之后立即可见 (JS 单线程, 不需要 lock-free CAS)
 *
 * dispose: 清空两个索引 + 对每个 holder 调 clear() 释放实例引用.
 * (真正的 dispose 逻辑在 scope.onDispose 回调栈里执行, 这里只是释放 holder 引用)
 */

import type { ServiceToken } from './types.js';
import { Holder } from './Holder.js';

export class ServiceRegistry {
  private holders = new Map<string, Holder<unknown>>();
  /** Hot-path cache: token 对象 ref → holder. token 被 GC 时自动清理. */
  private classCache = new WeakMap<ServiceToken<unknown>, Holder<unknown>>();
  private disposed = false;

  /**
   * 注册一个 service factory.
   * 同 token 重复注册抛错.
   */
  register<T>(token: ServiceToken<T>, factory: () => T): void {
    if (this.disposed) {
      throw new Error('ServiceRegistry: cannot register after dispose');
    }
    if (this.holders.has(token.name)) {
      throw new Error(`Service "${token.name}" already registered`);
    }
    const holder = new Holder<T>(factory);
    this.holders.set(token.name, holder as Holder<unknown>);
    // classCache 按需填充 (惰性), 不在注册时提前加入.
    // 这样 WeakMap 的 key 始终是"已经至少被查询过一次的 token", 节省一点内存.
  }

  /**
   * 查找一个 holder. 找不到返回 undefined (caller 负责沿 parent 链 fallback).
   * Hot path: 先查 WeakMap, miss 才查 string Map.
   */
  find<T>(token: ServiceToken<T>): Holder<T> | undefined {
    if (this.disposed) return undefined;

    // WeakMap hot path
    const cached = this.classCache.get(token);
    if (cached !== undefined) {
      return cached as Holder<T>;
    }

    // String map slow path
    const holder = this.holders.get(token.name);
    if (holder !== undefined) {
      this.classCache.set(token, holder);
      return holder as Holder<T>;
    }

    return undefined;
  }

  /**
   * 遍历所有已注册的 token name. 用于调试 / dispose 顺序确认.
   */
  listNames(): string[] {
    return [...this.holders.keys()];
  }

  /**
   * 释放所有 holder 引用. 不 dispose 实例 (scope 负责).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const holder of this.holders.values()) {
      holder.clear();
    }
    this.holders.clear();
    // WeakMap 无 clear, 直接重置 (tokens 被 GC 时会自动清)
    this.classCache = new WeakMap();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
