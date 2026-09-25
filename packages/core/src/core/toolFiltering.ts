/**
 * Tool Filtering Utilities
 * 工具过滤工具 - 根据模式过滤可用工具集
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { AgentMode, ToolCategory } from '@neoxlabs/kernel/types/permissions.js';

/**
 * 自动判断工具是否为只读工具
 */
export function isReadOnlyTool(toolName: string, tool?: Tool): boolean {
  // 如果有权限元数据，优先使用
  if (tool?.permission?.category) {
    return tool.permission.category === ToolCategory.READ;
  }

  // 根据工具名称判断
  const name = toolName.toLowerCase();

  // 明确的只读工具
  const readOnlyPatterns = [
    'read', 'grep', 'glob', 'search', 'list', 'show',
    'get', 'fetch', 'find', 'view', 'cat', 'ls',
    'describe', 'inspect', 'analyze', 'check'
  ];

  return readOnlyPatterns.some(pattern => name.includes(pattern));
}

/**
 * 根据模式过滤工具集
 */
export function filterToolsByMode(tools: Tool[], mode: AgentMode): Tool[] {
  if (mode === AgentMode.AGENT || mode === AgentMode.AUTO) {
    // AGENT 和 AUTO 模式：允许所有工具
    return tools;
  }

  if (mode === AgentMode.ASK) {
    // ASK 模式：只允许只读工具
    return tools.filter(tool => {
      // 显式配置允许在 ASK 模式下使用
      if (tool.permission?.allowInAskMode === true) {
        return true;
      }

      // 显式配置不允许
      if (tool.permission?.allowInAskMode === false) {
        return false;
      }

      // 自动判断
      return isReadOnlyTool(tool.name, tool);
    });
  }

  return tools;
}

/**
 * 获取模式的 system prompt 提示
 */
export function getModeSystemPrompt(mode: AgentMode): string {
  switch (mode) {
    case AgentMode.ASK:
      return `You are in ASK mode (read-only). You can:
- Read files and search code
- Analyze and understand the codebase
- Answer questions about the project
- Explore the project structure

You CANNOT make any changes. If the user needs edits, inform them and suggest they switch to AGENT mode.`;

    case AgentMode.AGENT:
      return `You are in AGENT mode (standard). You can:
- Read and analyze the codebase
- Make file edits and create new files
- Run commands and scripts
- Perform all available operations

Some operations may require user approval before execution.`;

    case AgentMode.AUTO:
      return `You are in AUTO mode (automatic). You have full access to:
- Read and write files
- Execute commands
- Make changes to the project
- All available tools without approval

All operations will execute automatically without user confirmation.`;

    default:
      return '';
  }
}

/**
 * 检查工具是否在当前模式下可用
 */
export function isToolAllowedInMode(tool: Tool, mode: AgentMode): boolean {
  const filteredTools = filterToolsByMode([tool], mode);
  return filteredTools.length > 0;
}
