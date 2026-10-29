/**
 * Agent Mode - 标准模式
 *
 * 特点：
 * - 允许所有工具
 * - 危险操作需要用户确认
 * - 适合常规开发工作
 */

import type { Tool } from '../../types/index.js';
import { AgentMode as AgentModeEnum } from '../../types/permissions.js';
import type { ModeStrategy } from './ModeStrategy.js';

export class AgentMode implements ModeStrategy {
  readonly mode = AgentModeEnum.AGENT;

  filterTools(allTools: Tool[]): Tool[] {
    // AGENT 模式允许所有工具
    return allTools;
  }

  getSystemPrompt(): string {
    return `你处于 Agent 模式（标准模式），拥有完整的工具访问权限。

工作建议：
- 对于复杂或不熟悉的任务，建议先用 explore 了解相关代码再动手
- 简单明确的任务可以直接执行，不必每次都 explore
- 涉及多文件批量操作时，考虑用 ptc_execute 提升效率
- 不确定方案时用 ask_user 跟用户确认

可用能力：
- 读取和分析代码库（readfile、search、explore）
- 编辑和创建文件（edit、write_file）
- 运行命令和脚本（execute_shell）
- 批量编排工具调用（ptc_execute，如果可用）
- 向用户提问确认（ask_user）

危险操作（删除文件、git force push 等）需要用户确认后执行。`;
  }

  shouldAutoApprove(): boolean {
    // AGENT 模式需要权限检查
    return false;
  }

  getDescription(): string {
    return 'Standard mode - Full access with approval for dangerous operations';
  }

  getIcon(): string {
    return '⚙️';
  }
}
