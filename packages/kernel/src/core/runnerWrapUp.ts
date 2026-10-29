import { cliLogger } from '../platform/cliLogger.js';
import type { StopReason } from './runTrackers.js';

export const WRAP_UP_AFTER_BLOCK_REMINDER = [
  '<system-reminder>',
  'The last tool call was blocked by a safety guard (repeated identical calls, or a high-risk action), and this turn is ending. Do not call any more tools — they will not run.',
  'Write your final reply to the user now: what is done (with the evidence you already have), what is not done, what got in the way, and the concrete next step you would take.',
  'Do not pretend the blocked step succeeded.',
  '</system-reminder>',
].join('\n');

/** VERIFY-11 的收尾提醒: 不是"工具被拦", 而是"同一个测试错第 3 次, 别再自己硬试" */
export const WRAP_UP_ASK_USER_REMINDER = [
  '<system-reminder>',
  'The same test failure has now happened three times. Stop editing code and stop re-running tests.',
  'Call ask_user once with one concrete question for the user: which test/assertion is failing (quote the key error line), what you already tried, and what you need them to decide (e.g. is the implementation wrong, or is the test expectation out of date?).',
  'Do not claim the tests pass.',
  '</system-reminder>',
].join('\n');

/** "停下问用户"的收尾轮里允许真正执行的工具 (问用户这件事必须落地) */
export const WRAP_UP_ASK_USER_ALLOWED: ReadonlySet<string> = new Set(['ask_user']);

let askUserWrapUpPending = false;
/** 当前这一轮收尾是否为"停下问用户" (dropWrapUpToolCalls 用) */
let wrapUpAsksUser = false;

/** 工具结果处理阶段: 下一个收尾轮要停下问用户 */
export function markAskUserWrapUp(): void {
  askUserWrapUpPending = true;
}

/**
 * 进入收尾轮: 把说明挂到对话尾部, 返回 true 作为 runner 的收尾标记。
 * @param reminder 显式指定文案; 不传则按 flag 自动选 (停下问用户 / 工具被拦)
 */
export function beginWrapUp(
  memory: { appendReminder(text: string): void },
  reminder?: string,
): true {
  wrapUpAsksUser = askUserWrapUpPending;
  askUserWrapUpPending = false;
  cliLogger.warn('RUNNER', wrapUpAsksUser
    ? '[VERIFY-11] same test failure x3 — one wrap-up turn that asks the user, then stop'
    : '[ORCHESTRATE] terminateLoop flagged by a blocked tool — one tool-less wrap-up turn, then stop');
  memory.appendReminder(reminder ?? (wrapUpAsksUser ? WRAP_UP_ASK_USER_REMINDER : WRAP_UP_AFTER_BLOCK_REMINDER));
  return true;
}

/**
 * 收尾轮里模型仍发了工具调用 (原生或正文里的 DSML) → 原地清空, 不执行。
 *
 * allow 例外 (VERIFY-11): "停下问用户"的收尾轮必须让 ask_user 真的执行 —— 否则模型
 * 写了问题却被丢掉, 用户什么也看不到, 比不停还糟。只放行明确点名的工具。
 */
export function dropWrapUpToolCalls(wrapUpTurn: boolean, toolCalls: unknown[], allow?: ReadonlySet<string>): void {
  if (!wrapUpTurn || toolCalls.length === 0) return;
  const allowSet = allow ?? (wrapUpAsksUser ? WRAP_UP_ASK_USER_ALLOWED : undefined);
  if (allowSet && allowSet.size > 0) {
    const kept = (toolCalls as Array<{ function?: { name?: string } }>).filter(
      (tc) => tc?.function?.name && allowSet.has(tc.function.name),
    );
    if (kept.length !== toolCalls.length) {
      cliLogger.warn('RUNNER', `[wrap-up] 收尾轮丢弃 ${toolCalls.length - kept.length} 个工具调用 (只放行 ${[...allowSet].join(', ')})`);
      toolCalls.length = 0;
      (toolCalls as unknown[]).push(...kept);
    }
    return;
  }
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
  /* VERIFY-11: 问用户的收尾轮没问出来, 至少如实说清停在哪 —— 不能报成"工具被拦" */
  if (wrapUpAsksUser) {
    run.terminate('tool_blocked');
    return {
      type: 'error',
      error: 'Stopped: the same test failure kept repeating, and the agent did not ask the user what to do next.',
    };
  }
  run.terminate('tool_blocked');
  return {
    type: 'error',
    error: 'Stopped: a tool was blocked (repeated identical calls or a high-risk action), and the agent did not report where it got to.',
  };
}
