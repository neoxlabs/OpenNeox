/**
 * Stage 2 — preHook
 *
 * 职责:按注册顺序执行 ctx.preHooks, 任一 hook 返回 allow=false 就短路,
 * blockedBy='pre_hook', reason 用 hook 给的原因(或 hook.name)。
 *
 * 设计要点:
 *   - 失败 fail-closed:hook.run() 自身抛出异常视为拒绝(安全优先),
 *     但输出里明确标注是 hook 故障而不是业务拒绝
 *   - 单个 hook 超时不在这层处理(由 hook 作者或外层 AbortSignal 管)
 */

import { block, ok0, type StageResult } from '../types.js';
import type { ToolUseContext } from '../types.js';

export async function runPreHookStage(
  resolvedName: string,
  args: Record<string, unknown>,
  ctx: ToolUseContext,
): Promise<StageResult<void>> {
  for (const hook of ctx.preHooks) {
    try {
      const result = await hook.run(resolvedName, args);
      if (!result.allow) {
        const reason = result.reason?.trim()
          ? result.reason.trim()
          : `pre-tool hook "${hook.name}" rejected the call`;
        return block('pre_hook', reason);
      }
    } catch (err: any) {
      // Fail-closed: hook 自身出错时拒绝执行, 避免越过安全前置
      return block(
        'pre_hook',
        `pre-tool hook "${hook.name}" threw: ${err?.message ?? String(err)}`,
      );
    }
  }
  return ok0();
}
