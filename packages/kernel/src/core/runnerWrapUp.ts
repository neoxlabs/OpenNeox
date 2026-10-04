import { cliLogger } from '../platform/cliLogger.js';
import type { StopReason } from './runTrackers.js';

export const WRAP_UP_AFTER_BLOCK_REMINDER = [
  '<system-reminder>',
  'The last tool call was blocked by a safety guard (repeated identical calls, or a high-risk action), and this turn is ending. Do not call any more tools — they will not run.',
  'Write your final reply to the user now: what is done (with the evidence you already have), what is not done, what got in the way, and the concrete next step you would take.',
  'Do not pretend the blocked step succeeded.',
  '</system-reminder>',
].join('\n');

/** 进入收尾轮: 把说明挂到对话尾部, 返回 true 作为 runner 的收尾标记 */
export function beginWrapUp(memory: { appendReminder(text: string): void }): true {
  cliLogger.warn('RUNNER', '[ORCHESTRATE] terminateLoop flagged by a blocked tool — one tool-less wrap-up turn, then stop');
  memory.appendReminder(WRAP_UP_AFTER_BLOCK_REMINDER);
  return true;
}

/** 收尾轮里模型仍发了工具调用 (原生或正文里的 DSML) → 原地清空, 不执行 */
export function dropWrapUpToolCalls(wrapUpTurn: boolean, toolCalls: unknown[]): void {
  if (!wrapUpTurn || toolCalls.length === 0) return;
  cliLogger.warn('RUNNER', `[wrap-up] 收尾轮仍发出 ${toolCalls.length} 个工具调用, 丢弃不执行`);
  toolCalls.length = 0;
}

/**
 * 收尾轮的结束: 不再走任何"继续"护栏, 模型说了什么就是什么。
 * 一个字都没说才报错 —— 至少让界面说明为什么停, 不许静默结束。
 */
export function finishWrapUpTurn(
  run: { finalOutput?: string; terminate(reason: StopReason): void },
  fullContent: string,
): { type: 'error'; error: string } | null {
  run.finalOutput = fullContent;
  if (fullContent.trim()) return null;
  run.terminate('tool_blocked');
  return {
    type: 'error',
    error: 'Stopped: a tool was blocked (repeated identical calls or a high-risk action), and the agent did not report where it got to.',
  };
}
