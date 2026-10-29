/**
 * Tool Orchestration — 类型定义
 *
 * 设计目标:把散落在 runner.ts(L1540-1700)和 agentLoop.ts(L890-1150)的两套
 * 工具执行流水线收到单一入口 `orchestrateToolUse`。
 *
 * 6 个阶段:
 *   validate  → preHook → gate → execute → postHook → telemetry
 *
 * 每个 stage 是一个纯函数, 输入 (toolCall, ctx), 输出 StageResult。
 * orchestrate 负责串联, 任一 stage 返回 block 即短路, Outcome 带 stage/blockedBy,
 * 上层 UI 可以展示"被 permission/risk/guardrail 拦了", 不再是笼统的 FAIL。
 *
 * 本文件只定义接口 —— 具体阶段实现在 ./stages/ 下, 真实 runner 接入在下个 PR。
 */

import type { Tool, ToolCall } from '../../types/index.js';

// ════════════════════════════════════════════════════════════════════════════
// Pipeline Stage 枚举
// ════════════════════════════════════════════════════════════════════════════

export type PipelineStage =
  | 'validate'
  | 'preHook'
  | 'gate'
  | 'execute'
  | 'postHook'
  | 'telemetry';

export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  'validate',
  'preHook',
  'gate',
  'execute',
  'postHook',
  'telemetry',
] as const;

/** 拦截原因分类(用于 UI 展示与 telemetry 归因) */
export type BlockedBy =
  | 'unknown_tool'   // validate: 工具名既不匹配也无别名
  | 'invalid_args'   // validate: JSON 解析失败 / schema 不符
  | 'pre_hook'       // preHook: 业务前置 hook 否决
  | 'permission'     // gate: 权限拒绝
  | 'risk'           // gate: 风险评级 critical/high
  | 'guardrail'      // gate: input guardrail 命中(危险命令 / 路径穿越等)
  | 'loop'           // gate: loopDetector HARD 级阻止
  | 'aborted'        // execute: AbortSignal 触发
  | 'timeout'        // execute: 超过硬超时, 工具被 abort(stallGuard)
  | 'execution_error'; // execute: tool.function 抛出异常

// ════════════════════════════════════════════════════════════════════════════
// Stage 通用返回协议
// ════════════════════════════════════════════════════════════════════════════

export type StageOk<T = void> = {
  kind: 'ok';
  /** 当前 stage 生产的数据, 传给下游 stage */
  data: T;
};

export type StageBlock = {
  kind: 'block';
  blockedBy: BlockedBy;
  /** 面向模型的可读原因, 会被写入 tool output */
  reason: string;
  userNotice?: string;
  /** 是否同时建议终止外层 run loop(目前只有 loop HARD 和 critical risk 置 true) */
  terminateLoop?: boolean;
};

export type StageResult<T = void> = StageOk<T> | StageBlock;

// 便捷构造器
export function ok<T>(data: T): StageOk<T> {
  return { kind: 'ok', data };
}
export function ok0(): StageOk<void> {
  return { kind: 'ok', data: undefined };
}
export function block(
  blockedBy: BlockedBy,
  reason: string,
  terminateLoop?: boolean,
  userNotice?: string,
): StageBlock {
  return { kind: 'block', blockedBy, reason, terminateLoop, userNotice };
}

// ════════════════════════════════════════════════════════════════════════════
// Hook 接口(对称的 pre / post-success / post-failure)
// ════════════════════════════════════════════════════════════════════════════

export interface PreToolHook {
  name: string;
  run(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allow: boolean; reason?: string }>;
}

export interface PostToolSuccessHook {
  name: string;
  run(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
  ): Promise<void>;
}

export interface PostToolFailureHook {
  name: string;
  run(
    toolName: string,
    args: Record<string, unknown>,
    errorOutput: string,
    error?: Error,
  ): Promise<void>;
}

// ════════════════════════════════════════════════════════════════════════════
// Gate 子决策器(每个都是可选的, 未配置就跳过)
// ════════════════════════════════════════════════════════════════════════════

export interface PermissionChecker {
  check(
    tool: Tool,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface RiskEvaluator {
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
  ): {
    level: 'low' | 'medium' | 'high' | 'critical';
    summary?: string;
  };
}

export interface InputGuardrailRunner {
  run(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allow: boolean; reason?: string; guardrailName?: string }>;
}

export interface LoopDetectorGate {
  /** HARD 级才阻止执行, SOFT/MEDIUM 由 orchestrate 转为 advisory hint */
  check(
    toolName: string,
    args: Record<string, unknown>,
  ): {
    level: 'none' | 'soft' | 'medium' | 'hard';
    /** 给模型的指令 */
    message?: string;
    userNotice?: string;
  };
  /** 通知 detector 执行结果(用于差异豁免) */
  record(
    toolName: string,
    args: Record<string, unknown>,
    status: 'success' | 'error',
    output: string,
  ): void;
}

// ════════════════════════════════════════════════════════════════════════════
// Telemetry Sink
// ════════════════════════════════════════════════════════════════════════════

export interface TelemetrySink {
  onStageEnter?(stage: PipelineStage, toolName: string, toolCallId: string): void;
  onStageExit?(
    stage: PipelineStage,
    toolName: string,
    toolCallId: string,
    durationMs: number,
    blockedBy?: BlockedBy,
  ): void;
  onToolComplete?(outcome: ToolUseOutcome): void;
}

// ════════════════════════════════════════════════════════════════════════════
// 主上下文(单个 tool call 的生命周期内保持不变)
// ════════════════════════════════════════════════════════════════════════════

export interface ToolUseContext {
  /** 可用工具列表(已 resolve 过名称和 schema) */
  tools: readonly Tool[];

  /** 解析别名 → canonical 名称, 返回 null 表示找不到 */
  resolveAlias(name: string): string | null;

  /** 取消信号 */
  signal: AbortSignal;

  steeringSignal?: AbortSignal;

  /** 当前迭代号(用于 telemetry / error pattern) */
  iteration: number;

  /** 工作区根(guardrail 内需要) */
  workspacePath?: string;

  /** 任务 Agent 提示(guardrail 数据里的 agent_name 字段) */
  agentName?: string;

  // ─── Gate 组件(可选) ─────────────────────────────────────
  permission?: PermissionChecker;
  risk?: RiskEvaluator;
  inputGuardrails?: InputGuardrailRunner;
  loopDetector?: LoopDetectorGate;

  /** 如果 true, 跳过 permission 检查(Auto Mode / 白名单场景) */
  shouldAutoApprove?: boolean;

  // ─── Hooks(可空数组) ────────────────────────────────────
  preHooks: PreToolHook[];
  postSuccessHooks: PostToolSuccessHook[];
  postFailureHooks: PostToolFailureHook[];

  // ─── 执行(唯一必填, orchestrate 通过它调 tool.function) ─
  /**
   * 由 caller 实现:拿到已解析的 tool + args, 实际调用 tool.function 并返回
   * 标准化的 { output, success }。这里抽象出来是为了让 orchestrate 不关心
   * runner 路径(parallelExecutor)或 agentLoop 路径(tool.function 直调)的差异。
   */
  invokeTool(
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    /** LLM 给的 tool_use_id, 用于让 tool 的流式事件 (如 shell_output_stream)
     *  能跟 timeline entry.toolCallId 对齐. 没传时由实现自己生成. */
    toolCallId?: string,
  ): Promise<{ output: string; success: boolean; uiMeta?: import('../types/toolResult.js').ToolUiMeta }>;

  // ─── 可观测(可选) ────────────────────────────────────────
  telemetry?: TelemetrySink;
}

// ════════════════════════════════════════════════════════════════════════════
// 结果结构
// ════════════════════════════════════════════════════════════════════════════

export interface ToolUseOutcome {
  /** tool_call_id(来自 LLM 返回) */
  toolCallId: string;
  /** LLM 给的原始工具名(可能是别名) */
  toolName: string;
  /** 解析后的 canonical 名(若 validate 阶段就拒绝则 undefined) */
  resolvedToolName?: string;
  /** 本次结束于哪个阶段:'telemetry' 表示正常走完, 其他表示在该阶段被 block */
  stage: PipelineStage;
  /** 最终是否成功(stage='telemetry' 且 execute 返回 success 才 true) */
  success: boolean;
  /** 最终输出(block 时是 reason, 成功/执行失败时是 tool output) */
  output: string;
  /**
   * UI 专属 meta(双轨道分离):当工具返回 ToolResult 对象(或 stringify 过的)
   * 时,这里携带 summary/status/kind/file_path/metadata 等信息给 UI 事件层用,
   * 不进入 LLM 消息体.undefined 表示工具返回的是纯字符串,UI 走旧路径.
   */
  uiMeta?: import('../types/toolResult.js').ToolUiMeta;
  /** 若被拦截, 告知被谁拦 */
  blockedBy?: BlockedBy;
  /** 被拦截时给用户看的一句人话 (output 里那份是给模型的) */
  userNotice?: string;
  /** 是否需要终止外层 run loop */
  terminateLoop?: boolean;
  /**
   * SOFT/MEDIUM 循环的 advisory 提示(非阻断)。上层可以选择把它拼到 output
   * 末尾(agentLoop 原行为)或注入 system memory(runner 新行为)。
   */
  loopAdvisoryMessage?: string;
  /** 每个 stage 的耗时(仅包含真正跑过的 stage) */
  stageTimings: Partial<Record<PipelineStage, number>>;
  /** 总耗时(毫秒) */
  totalDurationMs: number;
  /** 解析后的参数(供上层追踪, block 在 validate 时可能为 undefined) */
  args?: Record<string, unknown>;
  /** execute 阶段抛出的异常详情 */
  error?: { name: string; message: string };
}
