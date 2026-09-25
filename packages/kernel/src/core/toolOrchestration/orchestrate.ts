/**
 * orchestrateToolUse — 单一工具调用的完整流水线入口
 *
 * 串联 6 个 stage:validate → preHook → gate → execute → postHook → telemetry
 * 任一 stage 返回 block 即短路并组装 Outcome 返回。
 *
 * 关键设计:
 *   1. stageTimings 精确到每个实际跑过的 stage
 *   2. blockedBy 贯穿到最终 Outcome, 上层 UI 可以不再是笼统的 FAIL
 *   3. HARD loop / critical risk 返回 terminateLoop=true, run loop 应结束
 *   4. postHook 的 failure hook 分支会在 execute 失败时自动被调用
 *   5. loopDetector 的 record 在 execute 之后调用(即使失败也记录, 保留语义)
 */

import type { ToolCall } from '../../types/index.js';
import type {
  PipelineStage,
  StageResult,
  ToolUseContext,
  ToolUseOutcome,
} from './types.js';
import { runValidateStage } from './stages/validate.js';
import { runPreHookStage } from './stages/preHook.js';
import { runGateStage } from './stages/gate.js';
import { runExecuteStage } from './stages/execute.js';
import { runPostHookStage } from './stages/postHook.js';
import { runTelemetryStage } from './stages/telemetry.js';

type StageTimings = Partial<Record<PipelineStage, number>>;

function emitEnter(
  ctx: ToolUseContext,
  stage: PipelineStage,
  toolName: string,
  toolCallId: string,
): number {
  ctx.telemetry?.onStageEnter?.(stage, toolName, toolCallId);
  return Date.now();
}

function emitExit(
  ctx: ToolUseContext,
  stage: PipelineStage,
  toolName: string,
  toolCallId: string,
  startedAt: number,
  timings: StageTimings,
  blockedBy?: ToolUseOutcome['blockedBy'],
): void {
  const elapsed = Date.now() - startedAt;
  timings[stage] = elapsed;
  ctx.telemetry?.onStageExit?.(stage, toolName, toolCallId, elapsed, blockedBy);
}

/**
 * 构造"被拦截"的 outcome
 */
function buildBlockedOutcome(params: {
  toolCall: ToolCall;
  resolvedName?: string;
  stage: PipelineStage;
  block: Extract<StageResult, { kind: 'block' }>;
  args?: Record<string, unknown>;
  stageTimings: StageTimings;
  startedAt: number;
}): ToolUseOutcome {
  const { toolCall, resolvedName, stage, block: b, args, stageTimings, startedAt } = params;
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function?.name ?? '',
    resolvedToolName: resolvedName,
    stage,
    success: false,
    output: b.reason,
    blockedBy: b.blockedBy,
    userNotice: b.userNotice,
    terminateLoop: b.terminateLoop,
    stageTimings,
    totalDurationMs: Date.now() - startedAt,
    args,
  };
}

/**
 * 统一"把 outcome 交付给 telemetry 并返回"的收尾动作。
 * 所有出口点(正常走完 / 任一 stage block)都调用这里, 保证:
 *   - telemetry.onToolComplete 一定被调用(供外部收归 metrics)
 *   - stageTimings.telemetry 有值
 *   - onStageEnter/onStageExit('telemetry', ...) 对称 emit
 */
function finalize(
  outcome: ToolUseOutcome,
  ctx: ToolUseContext,
  toolCallId: string,
  stageTimings: StageTimings,
): ToolUseOutcome {
  const toolName = outcome.resolvedToolName ?? outcome.toolName;
  const t = emitEnter(ctx, 'telemetry', toolName, toolCallId);
  runTelemetryStage(outcome, ctx);
  emitExit(ctx, 'telemetry', toolName, toolCallId, t, stageTimings);
  // 更新 outcome 上的 stageTimings 引用是同一个对象, 不必再赋值
  return outcome;
}

/**
 * 主入口
 */
export async function orchestrateToolUse(
  toolCall: ToolCall,
  ctx: ToolUseContext,
): Promise<ToolUseOutcome> {
  const startedAt = Date.now();
  const stageTimings: StageTimings = {};
  const toolCallId = toolCall.id;
  const rawName = toolCall.function?.name ?? '';

  // ═══ Stage 1: validate ═══
  const t1 = emitEnter(ctx, 'validate', rawName, toolCallId);
  const validated = runValidateStage(toolCall, ctx);
  if (validated.kind === 'block') {
    emitExit(ctx, 'validate', rawName, toolCallId, t1, stageTimings, validated.blockedBy);
    const outcome = buildBlockedOutcome({
      toolCall,
      stage: 'validate',
      block: validated,
      stageTimings,
      startedAt,
    });
    return finalize(outcome, ctx, toolCallId, stageTimings);
  }
  emitExit(ctx, 'validate', rawName, toolCallId, t1, stageTimings);
  const { tool, resolvedName, args } = validated.data;

  // ═══ Stage 2: preHook ═══
  const t2 = emitEnter(ctx, 'preHook', resolvedName, toolCallId);
  const pre = await runPreHookStage(resolvedName, args, ctx);
  if (pre.kind === 'block') {
    emitExit(ctx, 'preHook', resolvedName, toolCallId, t2, stageTimings, pre.blockedBy);
    const outcome = buildBlockedOutcome({
      toolCall,
      resolvedName,
      stage: 'preHook',
      block: pre,
      args,
      stageTimings,
      startedAt,
    });
    return finalize(outcome, ctx, toolCallId, stageTimings);
  }
  emitExit(ctx, 'preHook', resolvedName, toolCallId, t2, stageTimings);

  // ═══ Stage 3: gate(permission + risk + guardrail + loop) ═══
  const t3 = emitEnter(ctx, 'gate', resolvedName, toolCallId);
  const gate = await runGateStage(tool, args, ctx);
  if (gate.kind === 'block') {
    emitExit(ctx, 'gate', resolvedName, toolCallId, t3, stageTimings, gate.blockedBy);
    const outcome = buildBlockedOutcome({
      toolCall,
      resolvedName,
      stage: 'gate',
      block: gate,
      args,
      stageTimings,
      startedAt,
    });
    return finalize(outcome, ctx, toolCallId, stageTimings);
  }
  emitExit(ctx, 'gate', resolvedName, toolCallId, t3, stageTimings);
  const loopAdvisoryMessage = gate.data.loopAdvisoryMessage;

  // ═══ Stage 4: execute ═══
  const t4 = emitEnter(ctx, 'execute', resolvedName, toolCallId);
  const exec = await runExecuteStage(tool, args, ctx, toolCallId);

  if (exec.kind === 'block') {
    // execute 异常或 abort
    emitExit(ctx, 'execute', resolvedName, toolCallId, t4, stageTimings, exec.blockedBy);

    // 仍然走 postFailureHooks(对称设计):让 errorPatternMemory 等观测组件收到信号
    const t5f = emitEnter(ctx, 'postHook', resolvedName, toolCallId);
    await runPostHookStage(
      { toolName: resolvedName, args, output: exec.reason, success: false },
      ctx,
    );
    emitExit(ctx, 'postHook', resolvedName, toolCallId, t5f, stageTimings);

    // 通知 loopDetector 记录(带 error 状态)
    try {
      ctx.loopDetector?.record(resolvedName, args, 'error', exec.reason);
    } catch { /* 忽略 detector 自身异常 */ }

    const outcome = buildBlockedOutcome({
      toolCall,
      resolvedName,
      stage: 'execute',
      block: exec,
      args,
      stageTimings,
      startedAt,
    });
    return finalize(outcome, ctx, toolCallId, stageTimings);
  }

  emitExit(ctx, 'execute', resolvedName, toolCallId, t4, stageTimings);
  const { output, success, durationMs: executeMs, uiMeta } = exec.data;
  // execute 自报时长 vs 外层壁钟差别不大, 但自报更准, 记到 timings
  stageTimings.execute = executeMs;

  // ═══ Stage 5: postHook(成功/失败对称分发) ═══
  const t5 = emitEnter(ctx, 'postHook', resolvedName, toolCallId);
  await runPostHookStage(
    { toolName: resolvedName, args, output, success },
    ctx,
  );
  emitExit(ctx, 'postHook', resolvedName, toolCallId, t5, stageTimings);

  // loop detector 记录(供差异豁免)
  try {
    ctx.loopDetector?.record(resolvedName, args, success ? 'success' : 'error', output);
  } catch { /* 忽略 */ }

  // ═══ Stage 6: telemetry ═══
  const outcome: ToolUseOutcome = {
    toolCallId,
    toolName: rawName,
    resolvedToolName: resolvedName,
    stage: 'telemetry',
    success,
    output,
    uiMeta,
    loopAdvisoryMessage,
    stageTimings,
    totalDurationMs: Date.now() - startedAt,
    args,
  };

  return finalize(outcome, ctx, toolCallId, stageTimings);
}
