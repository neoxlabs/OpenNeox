/**
 * Stage 5 postHook runs success and failure hooks symmetrically.
 *
 * Hook errors are recorded as diagnostics and do not hide the completed tool
 * result from the model.
 */

import { ok0, type StageResult } from '../types.js';
import type { ToolUseContext } from '../types.js';

export interface PostHookInput {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  success: boolean;
  error?: Error;
}

export interface PostHookDiagnostics {
  /** 运行期间哪些 hook 抛出异常, 供 telemetry 追踪 */
  failedHooks: Array<{ name: string; error: string }>;
}

export async function runPostHookStage(
  input: PostHookInput,
  ctx: ToolUseContext,
): Promise<StageResult<PostHookDiagnostics>> {
  const failedHooks: PostHookDiagnostics['failedHooks'] = [];

  if (input.success) {
    for (const hook of ctx.postSuccessHooks) {
      try {
        await hook.run(input.toolName, input.args, input.output);
      } catch (err: any) {
        failedHooks.push({
          name: hook.name,
          error: err?.message ?? String(err),
        });
      }
    }
  } else {
    for (const hook of ctx.postFailureHooks) {
      try {
        await hook.run(input.toolName, input.args, input.output, input.error);
      } catch (err: any) {
        failedHooks.push({
          name: hook.name,
          error: err?.message ?? String(err),
        });
      }
    }
  }

  // postHook 不短路 —— 永远 ok, 即使内部 hook 失败
  return { kind: 'ok', data: { failedHooks } };
}
