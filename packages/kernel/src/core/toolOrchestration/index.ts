/**
 * Tool Orchestration barrel
 *
 * 对外导出:
 *   - orchestrateToolUse:单入口, 单个 tool call 跑完 6 阶段
 *   - 所有公开的类型(ToolUseContext / ToolUseOutcome / Hook 接口等)
 *
 * 下一步(Stage 2 PR):把 runner.ts L1540-1700 和 agentLoop.ts L890-1150 的
 * 手工流水线替换为 orchestrateToolUse(feature flag 灰度)。
 */

export { orchestrateToolUse } from './orchestrate.js';
export type {
  PipelineStage,
  BlockedBy,
  StageOk,
  StageBlock,
  StageResult,
  PreToolHook,
  PostToolSuccessHook,
  PostToolFailureHook,
  PermissionChecker,
  RiskEvaluator,
  InputGuardrailRunner,
  LoopDetectorGate,
  TelemetrySink,
  ToolUseContext,
  ToolUseOutcome,
} from './types.js';
export { PIPELINE_STAGE_ORDER, ok, ok0, block } from './types.js';

// 各 stage 也导出 —— 方便测试 / 允许调用方自行组合流水线(高级用法)
export { runValidateStage } from './stages/validate.js';
export { runPreHookStage } from './stages/preHook.js';
export { runGateStage } from './stages/gate.js';
export { runExecuteStage } from './stages/execute.js';
export { runPostHookStage } from './stages/postHook.js';
export { runTelemetryStage } from './stages/telemetry.js';

// 统一批次执行器(runner/agentLoop 共用)
export { runOrchestratedBatch, DEFAULT_FILE_SCOPED_WRITE_TOOLS } from './batch.js';
export type { OrchestratedBatchOptions, OrchestratedBatchResult } from './batch.js';
