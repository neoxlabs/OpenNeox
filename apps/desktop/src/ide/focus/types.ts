/**
 * FocusService 类型定义
 *
 * "Focus scope" = 当前键盘焦点逻辑上属于哪个 IDE 子系统。
 * 不是 DOM 的 document.activeElement —— 那个粒度太细。
 * 这是一个粗粒度的逻辑分类，用来决定：
 *   - ⌘C/⌘V 是文件树的复制粘贴还是编辑器的复制粘贴
 *   - F2 是文件树的 rename 还是编辑器的 rename refactor
 *   - 一组快捷键应不应该响应
 *
 * 对标 IntelliJ Platform 的 ActionUpdateThread + DataContext 的 Project View
 * focus 概念，但极度简化（只有一个全局 scope，不做层级 / fallback）。
 */

import { createServiceToken } from '../container/ServiceContainer.js';
import { createTopic } from '../bus/MessageBus.js';
import type { ServiceToken } from '../container/ServiceContainer.js';
import type { Topic } from '../bus/MessageBus.js';

/**
 * 已知的 focus scope 列表。
 *
 * 用 string literal union 而不是 enum 是为了：
 *   - 插件可以自由扩展（'fileTree' | 'editor' | (string & {})）
 *   - 序列化 / 调试更友好
 *
 * 'global' 是 fallback —— 当没有任何具体 scope 被 push 时的默认值。
 * 它不代表"全局快捷键应该响应"，而是代表"什么 scope 都不在"。
 * useCommandShortcut 不传 scope 时表示"global，永远响应"，这是
 * 和 'global' 字面量的语义区别。
 */
export type FocusScope = 'global' | 'fileTree' | 'editor' | (string & {});

/**
 * FocusService 在 MessageBus 上发布的事件。
 *
 * 订阅者可以观察 focus 变化（例如未来某个状态栏要显示"当前焦点：Project View"）。
 * 大多数消费者用同步 API isActive() 即可，不需要订阅。
 */
export interface FocusEvents {
  /** focus scope 切换。previous 可能是 'global' */
  onScopeChanged(payload: { current: FocusScope; previous: FocusScope }): void;
}

/** FocusService 在 MessageBus 上的 topic */
export const FOCUS_TOPIC: Topic<FocusEvents> = createTopic<FocusEvents>('focus');

/**
 * FocusService 在 ServiceContainer 中的 token。
 * 作用域 = 'app'：focus 是应用级状态，跨 workspace 不变。
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export const FOCUS_SERVICE: ServiceToken<import('./FocusService.js').FocusService> =
  createServiceToken('focus', 'app');
