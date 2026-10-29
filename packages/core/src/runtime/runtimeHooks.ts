
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getGlobalUserHookRunner } from '../core/userHooks.js';
import type { HookEvent } from '../core/hookProtocol.js';

/** 通知式事件: 发出去就完事, 结果没人看。失败只记一行日志。 */
export function notifyHook(event: HookEvent, payload: Record<string, unknown>): void {
  void (async () => {
    try {
      const hooks = getGlobalUserHookRunner();
      if (!hooks?.hasHooksFor(event)) return;
      await hooks.fire(event, { payload });
    } catch (err: any) {
      cliLogger.warn('HOOKS', `${event} hook 出错 (不影响主流程): ${err?.message}`);
    }
  })();
}

/**
 * 一轮收尾 (Stop / StopFailure)。
 *
 * 通知式**从不 await**: 收尾路径上再挂一个用户脚本, 慢的那个会让"任务完成"迟迟不显示。
 * 它本来也拦不住任何东西, 没有等它的理由。
 */
export function notifyTurnEnd(
  event: 'Stop' | 'StopFailure',
  sessionId: string | undefined,
  iterations: number, toolCalls: number, tokens: number, durationMs: number,
): void {
  notifyHook(event, {
    session_id: sessionId,
    iterations, tool_calls: toolCalls, tokens, duration_ms: durationMs,
  });
}

export interface BlockingHookResult {
  allow: boolean;
  reason?: string;
  additionalContext?: string;
}

/** 可拦式事件。脚本崩了按"没有 hook"处理 —— 放行, 不是拦。 */
export async function blockingHook(
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<BlockingHookResult> {
  try {
    const hooks = getGlobalUserHookRunner();
    if (!hooks?.hasHooksFor(event)) return { allow: true };
    const outcome = await hooks.fire(event, { payload });
    return {
      allow: outcome.allow,
      reason: outcome.reason,
      additionalContext: outcome.additionalContext,
    };
  } catch (err: any) {
    cliLogger.warn('HOOKS', `${event} hook 出错, 按没有 hook 处理: ${err?.message}`);
    return { allow: true };
  }
}

export async function applyUserPromptSubmit(
  prompt: string,
  sessionId: string | undefined,
): Promise<{ blocked: false; prompt: string } | { blocked: true; reason: string }> {
  const outcome = await blockingHook('UserPromptSubmit', { prompt, session_id: sessionId });
  if (!outcome.allow) {
    return { blocked: true, reason: outcome.reason ?? 'blocked by UserPromptSubmit hook' };
  }
  return {
    blocked: false,
    prompt: outcome.additionalContext
      ? `${prompt}\n\n<hook-context>\n${outcome.additionalContext}\n</hook-context>`
      : prompt,
  };
}

/** PreCompact 闸 —— 被拦就抛, 让调用点的压缩流程原样中止。 */
export async function preCompactGate(sessionId: string | undefined, messages: number): Promise<void> {
  const outcome = await blockingHook('PreCompact', { session_id: sessionId, messages });
  if (!outcome.allow) throw new Error(outcome.reason ?? 'compaction blocked by PreCompact hook');
}

/** PostCompact 通知 —— 前后 token 和省下的量。 */
export function notifyPostCompact(
  sessionId: string | undefined, before: number, after: number, saved: number,
): void {
  notifyHook('PostCompact', {
    session_id: sessionId, tokens_before: before, tokens_after: after, saved,
  });
}
