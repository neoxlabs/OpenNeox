/**
 * FocusService —— IDE 子系统的"逻辑焦点"追踪器。
 *
 * 设计目标
 * --------
 * 1. **粗粒度**：不跟踪 DOM activeElement，只跟踪一个 string scope。
 *    "fileTree" / "editor" / "global" / 插件自定义...
 * 2. **同步查询**：isActive(scope) 返回 boolean，给 useCommandShortcut 这种
 *    必须在 keydown listener 里同步判断的场景用。
 * 3. **可观察**：scope 变化时通过 MessageBus 发 FOCUS_TOPIC.onScopeChanged，
 *    需要响应的 UI（状态栏、命令面板上下文显示等）可以订阅。
 * 4. **无 DOM 依赖**：可在测试环境跑，不需要 jsdom。
 *
 * 不变式
 * ------
 * - currentScope 永远有值（默认 'global'）
 * - setScope(x) 时 x === currentScope → no-op，不发事件
 * - clear() 等价于 setScope('global')
 *
 * 跟 DOM focus 的关系
 * ------------------
 * 这一层故意不监听 document 的 focusin/focusout 事件 —— 太底层、容易
 * 误触发（点 input 也算焦点）。组件应该显式 push focus：
 *   useEffect(() => {
 *     focus.setScope('fileTree')
 *     return () => focus.clear()  // 或 setScope('global')
 *   }, [])
 *
 * 当未来需要"按 DOM activeElement 自动推断 scope"时，再加一个 hook 包装。
 */

import type { MessageBus } from '../bus/MessageBus.js';
import { FOCUS_TOPIC } from './types.js';
import type { FocusScope } from './types.js';

export interface FocusServiceOptions {
  bus: MessageBus;
  /** 默认 scope，主要是为了测试可注入。生产用 'global' */
  initialScope?: FocusScope;
}

export class FocusService {
  private currentScope: FocusScope;
  private readonly bus: MessageBus;
  private readonly listeners = new Set<() => void>();

  constructor(options: FocusServiceOptions) {
    this.bus = options.bus;
    this.currentScope = options.initialScope ?? 'global';
  }

  /** 当前 scope，永远有值 */
  getScope(): FocusScope {
    return this.currentScope;
  }

  /** 同步判断某 scope 是否处于焦点。给 keydown listener 等同步判断点用 */
  isActive(scope: FocusScope): boolean {
    return this.currentScope === scope;
  }

  /**
   * 切换 scope。如果跟当前一样 → no-op。
   *
   * 触发顺序：
   *   1. 更新内部 currentScope
   *   2. 通知本地 listeners（同步）—— useSyncExternalStore 用
   *   3. 通过 MessageBus 发 FOCUS_TOPIC.onScopeChanged —— 跨组件订阅用
   */
  setScope(scope: FocusScope): void {
    if (this.currentScope === scope) return;
    const previous = this.currentScope;
    this.currentScope = scope;
    this.notifyListeners();
    this.bus.publisher(FOCUS_TOPIC).onScopeChanged({ current: scope, previous });
  }

  /** 清回 'global'。等价于 setScope('global') */
  clear(): void {
    this.setScope('global');
  }

  /**
   * 订阅"scope 变化了"信号。给 React useSyncExternalStore 用。
   * listener 不接收任何参数，调用方应该 getScope() 拿最新值。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ============================================================================
  // 内部
  // ============================================================================

  private notifyListeners(): void {
    // 复制一份避免迭代时修改
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener();
      } catch (err) {
        console.error('[FocusService] listener threw:', err);
      }
    }
  }
}
