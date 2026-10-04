/**
 * PTC Tool Binder — 将 Tool[] 转为沙箱可调用的 async 函数
 *
 * 规则：
 * - ptc_execute 自身不绑定（防递归）
 * - askUserTool 不绑定（脚本里不能交互）
 * - 其余工具全部绑定为 async (args) => result
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';

/** 不允许在 PTC 脚本中调用的工具 */
const EXCLUDED_TOOLS = new Set([
  'ptc_execute',
  'ask_user',
  'askUserTool',
  'use_skill',
]);

export interface ToolBinding {
  fn: (args: any) => Promise<string>;
  name: string;
  isReadOnly: boolean;
}

/**
 * 创建工具函数绑定
 * 返回 { toolName: async (args) => result } 映射
 */
export function createToolBindings(tools: Tool[]): Record<string, ToolBinding> {
  const bindings: Record<string, ToolBinding> = {};

  for (const tool of tools) {
    if (EXCLUDED_TOOLS.has(tool.name)) continue;
    if (typeof tool.function !== 'function') continue;

    const isReadOnly = (tool as any).permission?.category === 'READ'
      || ['readfile', 'search', 'search_files', 'list_directory', 'show_tree',
          'smart_tree', 'analyze_code', 'git_status', 'git_diff', 'git_blame',
          'git_branch_list', 'git_log', 'smart_read', 'get_definitions',
          'get_references', 'search_symbol'].includes(tool.name);

    bindings[tool.name] = {
      name: tool.name,
      isReadOnly,
      fn: async (args: any) => {
        const result = await tool.function!(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    };
  }

  return bindings;
}

/**
 * 生成工具函数签名描述（用于 system prompt）
 */
export function describeToolBindings(tools: Tool[]): string {
  const bindings = createToolBindings(tools);
  const lines: string[] = [];

  for (const [name, binding] of Object.entries(bindings)) {
    const tool = tools.find(t => t.name === name);
    if (!tool) continue;

    // 提取参数名
    const params = tool.parameters?.properties
      ? Object.keys(tool.parameters.properties)
      : [];
    const required = tool.parameters?.required as string[] || [];
    const paramStr = params.map(p => required.includes(p) ? p : `${p}?`).join(', ');

    const tag = binding.isReadOnly ? '[R]' : '[W]';
    const desc = (tool.description || '').split('\n')[0].substring(0, 60);
    lines.push(`  ${tag} await ${name}({ ${paramStr} }) — ${desc}`);
  }

  return lines.join('\n');
}
