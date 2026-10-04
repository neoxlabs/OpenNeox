/**
 * Stage 6 — telemetry
 *
 * 调用 ctx.telemetry.onToolComplete(outcome) 完成整个流水线。
 * 这个 stage 不会返回 block —— 到这里就是走完全程了。
 *
 * stage 函数抽得这么薄, 是为了让 orchestrate 可以把 "进入每个 stage"
 * 的 onStageEnter/onStageExit 遥测也贯穿到这里, 形成完整审计线。
 */

import { ok0, type StageResult } from '../types.js';
import type { ToolUseContext, ToolUseOutcome } from '../types.js';

export function runTelemetryStage(
  outcome: ToolUseOutcome,
  ctx: ToolUseContext,
): StageResult<void> {
  try {
    ctx.telemetry?.onToolComplete?.(outcome);
  } catch {
    // Telemetry 异常绝不影响主流程, 静默吞掉。
    // 调试时由 telemetry sink 内部自行 console.warn。
  }
  return ok0();
}
