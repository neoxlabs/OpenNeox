/**
 * Mode Strategy - 模式策略接口
 *
 * 使用策略模式，避免在 Runner 中到处 if-else 判断模式
 */

import type { Tool } from '../../types/index.js';
import { AgentMode } from '../../types/permissions.js';

/**
 * Mode Strategy Interface
 *
 * 每个模式实现此接口，定义模式特定的行为
 */
export interface ModeStrategy {
  /** 模式名称 */
  readonly mode: AgentMode;

  /**
   * 过滤可用工具集
   * @param allTools - 所有可用工具
   * @returns 当前模式下允许的工具
   */
  filterTools(allTools: Tool[]): Tool[];

  /**
   * 获取模式的 system prompt
   * @returns System prompt 文本
   */
  getSystemPrompt(): string;

  /**
   * 是否自动批准所有工具
   * @returns true = 自动批准, false = 需要权限检查
   */
  shouldAutoApprove(): boolean;

  /**
   * 获取模式描述（用于 UI 显示）
   */
  getDescription(): string;

  /**
   * 获取模式图标/标识
   */
  getIcon(): string;
}

/**
 * Mode Strategy Factory
 */
export class ModeStrategyFactory {
  private static strategies = new Map<AgentMode, ModeStrategy>();

  /**
   * 注册模式策略
   */
  static register(strategy: ModeStrategy): void {
    this.strategies.set(strategy.mode, strategy);
  }

  /**
   * 获取模式策略
   */
  static getStrategy(mode: AgentMode): ModeStrategy {
    const strategy = this.strategies.get(mode);
    if (!strategy) {
      throw new Error(`No strategy registered for mode: ${mode}`);
    }
    return strategy;
  }

  /**
   * 获取所有模式
   */
  static getAllModes(): AgentMode[] {
    return Array.from(this.strategies.keys());
  }
}
