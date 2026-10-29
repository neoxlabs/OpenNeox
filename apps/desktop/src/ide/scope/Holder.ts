/**
 * Holder —— 惰性实例化包装
 *
 * IDEA `platform/instanceContainer/src/internal/InstanceHolder.kt` 的 JS 等价物.
 *
 * 行为:
 *   - 注册时只存 factory, 不构造实例
 *   - 第一次 `getInstance()` 触发 factory, 之后缓存返回
 *   - 循环依赖检测: 构造过程中再次调用自己的 getInstance → 抛错
 *   - 构造成功后释放 factory 闭包 (回收内存)
 *
 * 性能: warm path 就是读一个字段返回, 无锁无分配.
 */

export class Holder<T> {
  private _instance: T | undefined;
  private _factory: (() => T) | null;
  private _constructing = false;

  constructor(factory: () => T) {
    this._factory = factory;
  }

  /**
   * 拿实例. 第一次调用触发 factory, 之后 hot path 直接返回缓存值.
   *
   * 如果构造过程中又调用了 getInstance (循环依赖) → 抛错.
   */
  getInstance(): T {
    if (this._instance !== undefined) return this._instance;  // hot path

    if (this._constructing) {
      throw new Error('Holder: cyclic service construction detected');
    }
    if (this._factory === null) {
      throw new Error('Holder: factory is null but instance not set (disposed?)');
    }

    this._constructing = true;
    try {
      const instance = this._factory();
      this._instance = instance;
      this._factory = null; // 释放闭包
      return instance;
    } finally {
      this._constructing = false;
    }
  }

  /**
   * 拿实例 (如果已构造). 否则返回 undefined, 不触发构造.
   * 用于 "dispose 时只清已存在的, 不要副作用地实例化未使用的 service".
   */
  tryGetInstance(): T | undefined {
    return this._instance;
  }

  /**
   * 是否已经实例化过. 用于调试 / 统计 / dispose 判断.
   */
  hasInstance(): boolean {
    return this._instance !== undefined;
  }

  /**
   * 释放引用. **不** 调用实例的 dispose —— 那是 scope.dispose() 里通过
   * onDispose 回调统一处理. Holder 这里只释放 holder 自己的引用, 让 GC 能回收.
   */
  clear(): void {
    this._instance = undefined;
    this._factory = null;
  }
}
