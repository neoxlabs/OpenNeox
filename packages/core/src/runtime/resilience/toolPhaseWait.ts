/**
 * Decide whether a tool phase still has active work. In-flight tool calls are
 * authoritative progress signals, while tracked child work is supplementary.
 * A maximum wait prevents a permanently stalled tool from holding the turn.
 */

export interface ToolPhaseWaitInput {
  /** 当前等的是模型响应还是工具执行 */
  phase: 'response' | 'tool';
  /** 本进程发过 tool_call_start 但还没收到 tool_output 的数量 */
  pendingToolCalls: number;
  /** 子 agent run 探针: 还有 agent_ 会话在推进 */
  delegationAlive: boolean;
  /** 这一次等待已经持续了多久 */
  waitedMs: number;
  /** 上限; <= 0 表示不设上限 */
  maxWaitMs: number;
}

/** 环境变量覆盖; 非法值一律回落到默认 */
export function toolPhaseMaxWaitMs(): number {
  const raw = Number(process.env.NEOX_TOOL_PHASE_MAX_WAIT_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 45 * 60_000;
}

/**
 * true = 流上没动静**不算**断流, 继续等同一个 next。
 * false = 走原来的 stall 重试 (真·断流兜底保留)。
 */
export function shouldKeepWaitingInToolPhase(input: ToolPhaseWaitInput): boolean {
  if (input.phase !== 'tool') return false;
  /* 上限到了就不再护着 —— 否则工具真挂死会把这一轮永远挂住 */
  if (input.maxWaitMs > 0 && input.waitedMs >= input.maxWaitMs) return false;
  return input.pendingToolCalls > 0 || input.delegationAlive;
}

/** Provides the signal that kept the phase waiting for diagnostic logging. */
export function describeToolPhaseWait(input: ToolPhaseWaitInput): string {
  if (input.pendingToolCalls > 0) return `${input.pendingToolCalls} 个工具还在飞`;
  if (input.delegationAlive) return '仍有子 agent run 在推进';
  return '没有任何在飞的活';
}
