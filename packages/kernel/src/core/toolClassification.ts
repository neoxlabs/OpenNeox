/**
 * 工具分类映射
 *
 * 定义每个工具的结果类型，决定其结果是否进入 LLM 长期上下文
 *
 * 分类原则：
 * - Ephemeral: 执行确认型，模型只需知道成功/失败，不需要看内容
 * - Contextual: 信息供给型，模型需要内容来继续推理
 * - Summarized: 摘要型，完整输出太长，但关键信息需要保留
 */

import { ToolResultType } from './types/toolResult.js';

export const TOOL_RESULT_CLASSIFICATION: Record<string, ToolResultType> = {
  // ============================================
  // 特点：模型只需知道"执行过了"，不需要看内容
  // ============================================

  // 文件写入
  'write_file': ToolResultType.EPHEMERAL,
  'Write': ToolResultType.EPHEMERAL,  // Anthropic 别名

  // 文件编辑
  'edit': ToolResultType.EPHEMERAL,
  'edit_file': ToolResultType.EPHEMERAL,
  'Edit': ToolResultType.EPHEMERAL,   // Anthropic 别名

  // 目录操作
  'create_directory': ToolResultType.EPHEMERAL,
  'mkdir': ToolResultType.EPHEMERAL,

  // 文件删除/重命名
  'delete_file': ToolResultType.EPHEMERAL,
  'rename_file': ToolResultType.EPHEMERAL,
  'move_file': ToolResultType.EPHEMERAL,
  'copy_file': ToolResultType.EPHEMERAL,

  // Git 写入操作
  'git_commit': ToolResultType.EPHEMERAL,
  'git_add': ToolResultType.EPHEMERAL,
  'git_push': ToolResultType.EPHEMERAL,
  'git_checkout': ToolResultType.EPHEMERAL,
  'git_branch': ToolResultType.EPHEMERAL,
  'git_merge': ToolResultType.EPHEMERAL,
  'git_stash': ToolResultType.EPHEMERAL,

  // 包管理写入操作
  'npm_install': ToolResultType.EPHEMERAL,
  'npm_uninstall': ToolResultType.EPHEMERAL,
  'pip_install': ToolResultType.EPHEMERAL,

  // ============================================
  // 特点：是模型继续思考的原材料，必须保留
  // ============================================

  // 文件读取
  'readfile': ToolResultType.CONTEXTUAL,  // 智能读取

  // 搜索工具
  'search': ToolResultType.CONTEXTUAL,
  'grep': ToolResultType.CONTEXTUAL,
  'Grep': ToolResultType.CONTEXTUAL,  // Anthropic 别名
  'glob': ToolResultType.CONTEXTUAL,
  'Glob': ToolResultType.CONTEXTUAL,
  'search_files': ToolResultType.CONTEXTUAL,
  'ripgrep': ToolResultType.CONTEXTUAL,

  // 目录浏览
  'ls': ToolResultType.CONTEXTUAL,
  'list_directory': ToolResultType.CONTEXTUAL,
  'show_tree': ToolResultType.CONTEXTUAL,

  // Git 读取操作
  'git_diff': ToolResultType.CONTEXTUAL,
  'git_status': ToolResultType.CONTEXTUAL,
  'git_blame': ToolResultType.CONTEXTUAL,
  'git_branch_list': ToolResultType.CONTEXTUAL,
  'git_log': ToolResultType.CONTEXTUAL,
  'git_show': ToolResultType.CONTEXTUAL,

  // Web 搜索/获取
  'web_search': ToolResultType.CONTEXTUAL,
  'WebSearch': ToolResultType.CONTEXTUAL,
  'web_fetch': ToolResultType.CONTEXTUAL,
  'WebFetch': ToolResultType.CONTEXTUAL,

  // 代码分析
  'analyze_code': ToolResultType.CONTEXTUAL,
  'search_symbol': ToolResultType.CONTEXTUAL,
  'get_definitions': ToolResultType.CONTEXTUAL,
  'get_references': ToolResultType.CONTEXTUAL,

  // ============================================
  // 特点：完整输出太长，只保留关键信息
  // ============================================

  // Shell 执行
  'execute_shell': ToolResultType.SUMMARIZED,
  'Bash': ToolResultType.SUMMARIZED,  // Anthropic 别名
  'bash': ToolResultType.SUMMARIZED,
  'shell': ToolResultType.SUMMARIZED,

  // 测试运行
  'run_tests': ToolResultType.SUMMARIZED,
  'run_lint': ToolResultType.SUMMARIZED,
  'run_format': ToolResultType.SUMMARIZED,
  'test': ToolResultType.SUMMARIZED,
  'pytest': ToolResultType.SUMMARIZED,
  'jest': ToolResultType.SUMMARIZED,

  // 构建
  'build': ToolResultType.SUMMARIZED,
  'compile': ToolResultType.SUMMARIZED,
  'npm_build': ToolResultType.SUMMARIZED,

  // 代码执行
  'code_interpreter': ToolResultType.SUMMARIZED,
  'python_exec': ToolResultType.SUMMARIZED,
};

const RESULT_TYPE_MAP: Record<string, ToolResultType> = {
  ephemeral: ToolResultType.EPHEMERAL,
  contextual: ToolResultType.CONTEXTUAL,
  summarized: ToolResultType.SUMMARIZED,
};

export function getToolResultType(toolNameOrTool: string | { name: string; resultType?: string }): ToolResultType {
  const toolName = typeof toolNameOrTool === 'string' ? toolNameOrTool : toolNameOrTool.name;

  if (typeof toolNameOrTool !== 'string' && toolNameOrTool.resultType) {
    const mapped = RESULT_TYPE_MAP[toolNameOrTool.resultType];
    if (mapped !== undefined) return mapped;
  }

  if (toolName.startsWith('mcp__')) {
    return ToolResultType.SUMMARIZED;
  }
  // 先尝试精确匹配
  if (toolName in TOOL_RESULT_CLASSIFICATION) {
    return TOOL_RESULT_CLASSIFICATION[toolName];
  }

  // 尝试小写匹配
  const lowerName = toolName.toLowerCase();
  for (const [key, value] of Object.entries(TOOL_RESULT_CLASSIFICATION)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }

  // 默认返回 CONTEXTUAL（保守策略，确保不丢失重要信息）
  return ToolResultType.CONTEXTUAL;
}

/**
 * 判断工具是否是写入类型（Ephemeral）
 */
export function isWriteTool(toolName: string): boolean {
  return getToolResultType(toolName) === ToolResultType.EPHEMERAL;
}

/**
 * 判断工具是否是读取类型（Contextual）
 */
export function isReadTool(toolName: string): boolean {
  return getToolResultType(toolName) === ToolResultType.CONTEXTUAL;
}

/**
 * 判断工具是否是命令执行类型（Summarized）
 */
export function isCommandTool(toolName: string): boolean {
  return getToolResultType(toolName) === ToolResultType.SUMMARIZED;
}

/**
 * 获取工具分类的描述
 */
export function getToolResultTypeDescription(type: ToolResultType): string {
  switch (type) {
    case ToolResultType.EPHEMERAL:
      return 'Ephemeral (执行确认型) - 不进入长期上下文';
    case ToolResultType.CONTEXTUAL:
      return 'Contextual (信息供给型) - 进入上下文';
    case ToolResultType.SUMMARIZED:
      return 'Summarized (摘要型) - 压缩后进入上下文';
    default:
      return 'Unknown';
  }
}

/**
 * 打印所有工具的分类（调试用）
 */
export function printToolClassification(): void {
  const grouped = {
    [ToolResultType.EPHEMERAL]: [] as string[],
    [ToolResultType.CONTEXTUAL]: [] as string[],
    [ToolResultType.SUMMARIZED]: [] as string[],
  };

  for (const [tool, type] of Object.entries(TOOL_RESULT_CLASSIFICATION)) {
    grouped[type].push(tool);
  }

  console.log('🟢 EPHEMERAL (不进入上下文):', grouped[ToolResultType.EPHEMERAL].join(', '));
  console.log('🔵 CONTEXTUAL (进入上下文):', grouped[ToolResultType.CONTEXTUAL].join(', '));
  console.log('🟡 SUMMARIZED (摘要后进入):', grouped[ToolResultType.SUMMARIZED].join(', '));
}
