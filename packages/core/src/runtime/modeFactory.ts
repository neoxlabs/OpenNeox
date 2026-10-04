/**
 * ModeFactory - Agent 运行模式工具类
 *
 * assistant 模式已移除 —— 现在只剩 agentic。类型/工具保留为单值, 兼容历史调用方。
 * - agentic: 主 Agent + 多 Agent 子任务派遣 (explore/code/shell/plan), 日常开发。
 */

/** Agent 运行模式 (assistant 已移除, 只剩 agentic)。 */
export type AgentRunMode = 'agentic';

/** 旧模式名一律归一到 agentic (single/basic/assistant 等历史值)。 */
export function normalizeRunMode(_mode?: string | null): AgentRunMode {
  return 'agentic';
}

/** ModeFactory - 模式工具类（仅静态方法）。assistant 移除后只剩 agentic。 */
export class ModeFactory {
  static getDefaultMode(): AgentRunMode {
    return 'agentic';
  }

  static isValidMode(mode: string): mode is AgentRunMode {
    return mode === 'agentic' || mode === 'single' || mode === 'basic';
  }

  static getAvailableModes(): AgentRunMode[] {
    return ['agentic'];
  }

  static getModeDescription(_mode: AgentRunMode | string): string {
    return 'Agentic 模式 - 多 Agent 协作，日常开发';
  }
}
