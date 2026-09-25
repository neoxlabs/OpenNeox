/**
 * Ask Mode - 只读模式
 *
 * 特点：
 * - 只允许读取工具
 * - 不允许任何写入/执行操作
 * - 适合代码分析、探索、问答
 */

import type { Tool } from '../../types/index.js';
import { AgentMode, ToolCategory } from '../../types/permissions.js';
import type { ModeStrategy } from './ModeStrategy.js';

export class AskMode implements ModeStrategy {
  readonly mode = AgentMode.ASK;

  filterTools(allTools: Tool[]): Tool[] {
    return allTools.filter(tool => this.isReadOnlyTool(tool));
  }

  getSystemPrompt(): string {
    return `You are in ASK mode (read-only). You can:
- Read files and search code
- Analyze and understand the codebase
- Answer questions about the project
- Explore the project structure

You CANNOT make any changes. If the user needs edits, inform them that you are in read-only mode and suggest they switch to AGENT mode.

Available operations: Reading, Searching, Analyzing, Exploring.`;
  }

  shouldAutoApprove(): boolean {
    // ASK 模式下，允许的工具都是只读的，可以自动批准
    return true;
  }

  getDescription(): string {
    return 'Read-only mode - Analyze and explore code without making changes';
  }

  getIcon(): string {
    return '🔒';
  }

  /**
   * 判断是否为只读工具
   */
  private isReadOnlyTool(tool: Tool): boolean {
    // 显式配置
    if (tool.permission?.allowInAskMode === true) {
      return true;
    }

    if (tool.permission?.allowInAskMode === false) {
      return false;
    }

    // 根据分类判断
    if (tool.permission?.category) {
      return tool.permission.category === ToolCategory.READ;
    }

    // 根据名称推断
    const name = tool.name.toLowerCase();
    const readOnlyPatterns = [
      'read', 'grep', 'glob', 'search', 'list', 'show',
      'get', 'fetch', 'find', 'view', 'cat', 'ls',
      'describe', 'inspect', 'analyze', 'check',
    ];

    return readOnlyPatterns.some(pattern => name.includes(pattern));
  }
}
