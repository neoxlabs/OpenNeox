import type { Tool, ToolCapabilitySet } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';

export type ToolParallelSafety = 'safe' | 'unsafe';

const LEGACY_PARALLEL_SAFE_TOOLS = new Set<string>([
  'readfile',
  'search',
  'search_files',
  'list_directory',
  'show_tree',
  'analyze_code',
  'search_symbol',
  'get_definitions',
  'get_references',
  'git_status',
  'git_diff',
  'git_blame',
  'git_branch_list',
]);

export interface RuntimeCapabilitySnapshot {
  capabilities: Required<ToolCapabilitySet>;
  enabledTools: Set<string>;
  parallelSafeTools: Set<string>;
}

export function resolveToolParallelSafety(tool: Tool): ToolParallelSafety {
  if (tool.parallelSafety === 'safe' || tool.parallelSafety === 'unsafe') {
    return tool.parallelSafety;
  }

  // isReadOnly 直接决定并行安全性
  if (tool.isReadOnly === true) {
    return 'safe';
  }
  if (tool.isReadOnly === false) {
    return 'unsafe';
  }

  const category = tool.permission?.category;
  if (category === ToolCategory.READ) {
    return 'safe';
  }
  if (category === ToolCategory.WRITE || category === ToolCategory.EXECUTE || category === ToolCategory.SYSTEM) {
    return 'unsafe';
  }

  // 兼容：旧工具没有 isReadOnly 标记时回退到硬编码
  if (LEGACY_PARALLEL_SAFE_TOOLS.has(tool.name)) {
    return 'safe';
  }

  return 'unsafe';
}

export function buildRuntimeCapabilitySnapshot(
  tools: Tool[],
  capabilities?: ToolCapabilitySet
): RuntimeCapabilitySnapshot {
  const normalizedCapabilities: Required<ToolCapabilitySet> = {
    terminal: capabilities?.terminal === true,
    editor: capabilities?.editor === true,
    debug: capabilities?.debug === true,
    trace: capabilities?.trace === true,
    gui: capabilities?.gui === true,
  };

  const enabledTools = new Set<string>();
  const parallelSafeTools = new Set<string>();

  for (const tool of tools) {
    enabledTools.add(tool.name);
    if (resolveToolParallelSafety(tool) === 'safe') {
      parallelSafeTools.add(tool.name);
    }
  }

  return {
    capabilities: normalizedCapabilities,
    enabledTools,
    parallelSafeTools,
  };
}

export function applyParallelSafety(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    parallelSafety: resolveToolParallelSafety(tool),
  }));
}
