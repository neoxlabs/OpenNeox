/**
 * Mode System - 模式系统
 *
 * 导出所有模式相关的类和工具
 */

// 导出类型（interface 只在类型层面存在，编译后不会有运行时代码）
export type { ModeStrategy } from './ModeStrategy.js';
// 导出类（class 会编译成运行时代码）
export { ModeStrategyFactory } from './ModeStrategy.js';
export { AskMode } from './AskMode.js';
export { AgentMode as AgentModeStrategy } from './AgentMode.js';
export { AutoMode } from './AutoMode.js';

// 导入并注册所有模式
import { ModeStrategyFactory } from './ModeStrategy.js';
import { AskMode } from './AskMode.js';
import { AgentMode as AgentModeStrategy } from './AgentMode.js';
import { AutoMode } from './AutoMode.js';

// 自动注册所有模式策略
ModeStrategyFactory.register(new AskMode());
ModeStrategyFactory.register(new AgentModeStrategy());
ModeStrategyFactory.register(new AutoMode());

/**
 * 获取模式策略的便捷函数
 */
export function getModeStrategy(mode: import('../../types/permissions.js').AgentMode) {
  return ModeStrategyFactory.getStrategy(mode);
}
