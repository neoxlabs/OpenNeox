/**
 * Compatibility type definitions for parallel tool execution.
 *
 * Runtime orchestration uses runOrchestratedBatch; this module keeps shared
 * interfaces available to runner helpers without importing implementation code.
 */

// ════════════════════════════════════════════════════════════════════════════
// 类型定义(保留)
// ════════════════════════════════════════════════════════════════════════════

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  thoughtSignature?: string;
  __kimi_builtin?: boolean;
  __kimi_original_name?: string;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  success: boolean;
  executionTime?: number;
  /**
   * The result was blocked by a guard rather than failing inside the tool.
   */
  blockedBy?: import('./toolOrchestration/types.js').BlockedBy;
  /** 给**用户**看的一句人话 (给模型的指令仍在 output 里)。没有就由 UI 按 blockedBy 兜底。 */
  userNotice?: string;
  /** Legacy compatibility field; current orchestration reports state changes
   * through its telemetry outcome. */
  contextModifier?: ContextModifier;
}

/**
 * @deprecated 见 ToolResult.contextModifier 注释。类型暂留防外部 import
 * 时 break, 但无运行时使用点。
 */
export interface ContextModifier {
  toolCallId: string;
  type: 'cwd_change' | 'env_change' | 'state_change';
  payload: Record<string, unknown>;
}

/**
 * @deprecated 原 ParallelToolExecutor.analyzePlan 的产出。其批次分组逻辑
 * 已由 runOrchestratedBatch 替代, 本类型无业务使用。
 */
export interface ToolExecutionPlan {
  parallel: ToolCall[];
  sequential: ToolCall[];
  totalTools: number;
  parallelCount: number;
  sequentialCount: number;
}

/**
 * 保留给 CLI_DEBUG_CONSOLE 下的性能事件(buildParallelExecutionStatsEvent),
 * runner 只填 totalTime, 其他字段保留默认 0/1 占位。
 */
export interface ToolExecutionStats {
  totalTime: number;
  parallelTime: number;
  sequentialTime: number;
  timeSaved: number;
  speedup: number;
}
