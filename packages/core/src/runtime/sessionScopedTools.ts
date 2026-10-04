import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { runWithTargetSession } from '../tools/targetModeTools.js';

export const TARGET_TOOL_NAMES = new Set([
  'activate_target', 'plan_target', 'check_target_done',
  'abandon_target', 'pause_target', 'continue_target',
]);
export const SESSION_SCOPED_TOOL_NAMES = new Set([...TARGET_TOOL_NAMES, 'call_tool']);

/* 已经包过的对象 —— 工具树 (decorateTool) 和 buildRunner (原地包装) 两处都会包, 包两层没意义 */
const scoped = new WeakSet<Tool>();

/** 给单个工具套上 session ALS。非 session-scoped 工具原样返回 (零开销)。幂等。 */
export function wrapSessionScopedTool(tool: Tool, sessionId: string | undefined): Tool {
  if (!sessionId) return tool;
  if (!SESSION_SCOPED_TOOL_NAMES.has(tool.name)) return tool;
  if (scoped.has(tool)) return tool;
  const originalFn = tool.function;
  if (typeof originalFn !== 'function') return tool;
  const wrapped = {
    ...tool,
    function: ((...args: any[]) =>
      runWithTargetSession(sessionId, () => (originalFn as any).apply(null, args))) as any,
  } as Tool;
  scoped.add(wrapped);
  return wrapped;
}

/**
 * 原地包装整个数组 —— **不产生新数组**, 保住调用方持有的引用。
 * (ToolTreeEngine.liveTools 就是靠这个引用做到"解锁即对 runner 可见"。)
 */
export function wrapSessionScopedToolsInPlace(tools: Tool[], sessionId: string | undefined): Tool[] {
  if (!sessionId) return tools;
  for (let i = 0; i < tools.length; i++) {
    const wrapped = wrapSessionScopedTool(tools[i], sessionId);
    if (wrapped !== tools[i]) tools[i] = wrapped;
  }
  return tools;
}
