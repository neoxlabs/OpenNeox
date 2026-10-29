/**
 * Auto Mode - 自动模式
 *
 * 特点：
 * - 允许所有工具
 * - 所有操作自动批准
 * - 适合批量操作、自动化任务
 * -  谨慎使用
 */

import type { Tool } from '../../types/index.js';
import { AgentMode } from '../../types/permissions.js';
import type { ModeStrategy } from './ModeStrategy.js';

export class AutoMode implements ModeStrategy {
  readonly mode = AgentMode.AUTO;

  filterTools(allTools: Tool[]): Tool[] {
    // AUTO 模式允许所有工具
    return allTools;
  }

  getSystemPrompt(): string {
    return `你处于 Auto 模式（全自动），所有操作无需用户确认，直接执行。

工作建议：
- 对于复杂或不熟悉的任务，建议先用 explore 了解相关代码再动手
- 简单明确的任务可以直接执行
- 涉及多文件批量操作时，考虑用 ptc_execute 提升效率
- 操作前自行 double-check，因为没有审批环节

可用能力：所有工具，自动批准。`;
  }

  shouldAutoApprove(): boolean {
    // AUTO 模式自动批准所有工具
    return true;
  }

  getDescription(): string {
    return 'Automatic mode - All operations execute without approval (use with caution)';
  }

  getIcon(): string {
    return '⚡';
  }
}
