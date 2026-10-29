
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 原始参数留多少进日志。够看清破损形态, 又不至于把日志撑爆。 */
const RAW_SNIPPET_LIMIT = 4000;

const STEERS: Record<string, string> = {
  create_slides:
    ' HINT: create_slides JSON payloads this large get corrupted mid-generation and cannot be repaired.'
    + ' Do NOT retry the same call. Build it page by page instead: deck_begin (outline) → deck_add_slide'
    + ' (one page per call) → deck_export.'
    + ' Only retry create_slides if you shrink to <=5 slides with minimal slot text.',

  browser_run:
    ' HINT: this is almost always the JS you embedded in a step. Inside JSON strings use SINGLE quotes'
    + ' for JS (\'h1\' not "h1"), keep each expression on ONE line, and prefer selector/text steps over'
    + ' eval so there is no code to quote at all.',

  /* computer_run 的 steps 是纯数据 (编号/文本/按键), 写坏基本是引号或逗号。 */
  computer_run:
    ' HINT: computer_run steps are plain data — {action, target, text}. No code, no nested quotes.'
    + ' If you need to type text containing quotes, escape them properly.',
};

/**
 * 记一条带现场的失败日志, 返回该附加给模型的定向指引 (没有就是空串)。
 */
export function reportToolArgsFailure(toolName: string | undefined, rawArgs: string, reason?: string): string {
  const name = String(toolName ?? '(unknown)');
  cliLogger.warn(
    'TOOL',
    `❌ args parse failed for ${name}: ${reason ?? 'parse failed'}`
    + `\n---raw(${rawArgs.length})---\n${rawArgs.slice(0, RAW_SNIPPET_LIMIT)}\n---end---`,
  );
  return STEERS[name] ?? '';
}
