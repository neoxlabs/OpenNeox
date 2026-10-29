/**
 * @neox/ide/toolWindow —— Tool Window 注册系统
 *
 * sidebar / bottom panel 的"面板"插槽抽象，对标 IntelliJ Platform 的
 * Tool Window。详见 ToolWindowRegistry.ts 头部注释。
 */

export { ToolWindowRegistry } from './ToolWindowRegistry.js';
export type {
  ToolWindowRegistryOptions,
  ToolWindowUnregister,
} from './ToolWindowRegistry.js';
export {
  TOOL_WINDOWS_TOPIC,
  TOOL_WINDOW_REGISTRY,
} from './types.js';
export type {
  ToolWindowAnchor,
  ToolWindowDescriptor,
  ToolWindowEvents,
} from './types.js';
