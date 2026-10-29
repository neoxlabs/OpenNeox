/**
 * ProjectService —— 项目级服务的抽象基类
 *
 * 约定
 * ----
 * 每个 project 级服务都继承这个类, constructor 接 ProjectScope.
 * 基类自动:
 *   - 提供 workspacePath / window / signal 等 scope 字段的快捷访问
 *   - 在构造时把 `this.dispose()` 注册到 scope 的 disposables 栈
 *     (scope.dispose() 时反向执行)
 *
 * 子类只需要
 * ---------
 * - 调 super(scope)
 * - 实现 dispose() —— scope 关闭时自动调用
 * - 想要 async cleanup 的话, dispose 返回 Promise 即可
 *
 * 结构化强制: 构造参数是 ProjectScope 而不是其他什么. AppScope 容器无法提供
 * ProjectScope, 所以错误放置 level → 构造时 throw.
 */

import type { BrowserWindow } from 'electron';
import type { ProjectScope } from './ProjectScope.js';

export abstract class ProjectService {
  protected readonly scope: ProjectScope;

  constructor(scope: ProjectScope) {
    this.scope = scope;
    // 自动把 dispose 挂到 scope 的回调栈
    // scope 关闭时反向执行, 保证先注册的 service 最后 dispose (parent 最先构造, 最后关)
    scope.onDispose(() => this.dispose(), this.constructor.name);
  }

  /** 快捷访问: 本 scope 绑定的 workspace 绝对路径 */
  protected get workspacePath(): string {
    return this.scope.workspacePath;
  }

  /** 快捷访问: 本 scope 的 BrowserWindow */
  protected get window(): BrowserWindow {
    return this.scope.window;
  }

  /**
   * 快捷访问: AbortSignal.
   * 所有 project 级的 fetch / 长连接 / timer 都应该拿这个 signal.
   * scope.dispose() → abortController.abort() → 自动取消.
   */
  protected get signal(): AbortSignal {
    return this.scope.signal;
  }

  /** 子类必须实现的清理逻辑. */
  abstract dispose(): void | Promise<void>;
}
