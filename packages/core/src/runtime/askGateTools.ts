import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createSummarizedResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { isAskSideEffectBlocked } from '../tools/askUserTool.js';

/** 会产生副作用的工具 —— 写盘 / 跑命令 / 动浏览器 / 提交代码 */
export const SIDE_EFFECT_TOOL_NAMES = new Set([
  'write_file', 'edit', 'edit_batch', 'delete_file', 'rename_file', 'create_directory',
  'execute_shell', 'execute_python', 'execute_javascript', 'run_dev_server', 'service_adopt',
  'browser_run', 'browser_navigate', 'browser_click', 'browser_type', 'browser_fill_form',
  'git_commit', 'git_branch',
  'sheet_write_range', 'sheet_set_cells', 'sheet_new_workbook', 'sheet_export_file',
  'word_edit_paragraph', 'generate_image', 'edit_image',
]);

const BLOCKED_MESSAGE = '你问了用户但没等到回答 —— 这一轮不再执行会改文件 / 跑命令 / 动浏览器的操作。'
  + '直接结束回复: 一两句话说清你卡在哪、需要用户给什么信息。用户回来答了, 下一轮自然恢复。';

/* 已套过闸的对象 —— 工具树 (decorateTool) 和 buildRunner (原地包装) 两处都会包 */
const gated = new WeakSet<Tool>();

/** 单个工具套闸。非副作用工具原样返回 (零开销)。幂等。 */
export function wrapAskGateTool(tool: Tool, sessionId: string | undefined): Tool {
  if (!SIDE_EFFECT_TOOL_NAMES.has(tool.name)) return tool;
  if (gated.has(tool)) return tool;
  const originalFn = tool.function;
  if (typeof originalFn !== 'function') return tool;
  const wrapped = {
    ...tool,
    function: ((...args: any[]) => {
      if (isAskSideEffectBlocked(sessionId)) {
        /* precondition = 「环境不具备」而不是「工具坏了」: 界面按引导渲染, 不报红 (见 toolResult.ts) */
        return JSON.stringify(createSummarizedResult(tool.name, 'error', '等用户回答中 — 本轮不执行副作用操作', {
          error: BLOCKED_MESSAGE,
          precondition: true,
        }));
      }
      return (originalFn as any).apply(null, args);
    }) as any,
  } as Tool;
  gated.add(wrapped);
  return wrapped;
}

/**
 * 原地包装整个数组 —— **不产生新数组** (跟 sessionScopedTools 同一条契约:
 * ToolTreeEngine.liveTools 靠引用身份做到"解锁即对 runner 可见")。
 */
export function wrapAskGateToolsInPlace(tools: Tool[], sessionId: string | undefined): Tool[] {
  for (let i = 0; i < tools.length; i++) {
    const wrapped = wrapAskGateTool(tools[i], sessionId);
    if (wrapped !== tools[i]) tools[i] = wrapped;
  }
  return tools;
}
