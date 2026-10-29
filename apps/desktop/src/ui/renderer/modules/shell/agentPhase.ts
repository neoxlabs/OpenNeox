import type { TimelineEntry } from '../../utils/workspaceUtils';

export type AgentPhase =
  | 'idle'
  | 'connecting'   // 发出去了, 这一轮还一个字都没回
  | 'slow'         // 连接较慢 (看门狗)
  | 'retrying'     // 限流 / 超时 / 断网后自动重试
  | 'failover'     // 切到备用线路
  | 'compacting'   // 压缩上下文
  | 'planning'     // 写计划 / 更新待办
  | 'thinking'     // 推理流在出
  | 'tool'         // 某个工具在跑
  | 'delegating'   // 子 Agent / Explore 在跑
  | 'writing'      // 正文流在出
  | 'working'      // 工具刚跑完, 模型还没开口 (读结果接着想)
  | 'approval'     // 等你批
  | 'asking'       // 等你回答 (ask_user)
  | 'error'
  | 'done';

export interface PhaseInput {
  streaming: boolean;
  approval: boolean;
  error: boolean;
  justDone: boolean;
  /** 运行时状态文案 (dispatchStatus 写的那串) —— 只认几个硬信号 */
  status?: string;
  events: readonly TimelineEntry[] | null | undefined;
}

export interface PhaseResult {
  phase: AgentPhase;
  /** 当 phase=tool / delegating 时, 尾巴上那条在跑的条目 */
  entry?: TimelineEntry;
  /** 重试 / 压缩 的进度 ("2/3") */
  detail?: string;
}

const TOOL_TYPES = new Set(['tool_call', 'tool_result', 'tool_error', 'edit_file', 'file_stream']);
/* 待办 / 计划: update_plan, task_create / task_update / task_list (待办清单那套, 不是子 Agent) */
const PLAN_TOOL = /^(update_plan|todo_?write|todo|task_(create|update|list|get))$/i;
/* 子 Agent: agent / explore / explorer */
const DELEGATE_TOOL = /^(agent|agent_x|explore|explorer|spawn_agent|delegate)$/i;
const ASK_TOOL = /^(ask_user|ask_user_question|ask_followup_question|ask)$/i;

export function derivePhase(input: PhaseInput): PhaseResult {
  const { streaming, approval, error, justDone, status = '', events } = input;
  if (approval) return { phase: 'approval' };

  /* 这一轮: 从尾往回到最后一条用户消息 */
  const turn: TimelineEntry[] = [];
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'user_message') break;
      turn.push(e);
      if (turn.length > 400) break;
    }
  }
  /* turn[0] 是最新的 */

  if (!streaming) {
    const ask = turn.find((e) => e.pending && TOOL_TYPES.has(e.type) && ASK_TOOL.test(e.toolName ?? ''));
    if (ask) return { phase: 'asking', entry: ask };
    if (error) return { phase: 'error' };
    if (justDone) return { phase: 'done' };
    return { phase: 'idle' };
  }

  const n = status.match(/(\d+)\s*\/\s*(\d+)/);
  const prog = n ? `${n[1]}/${n[2]}` : undefined;
  if (/重试|retrying|rate limited|限流/i.test(status)) return { phase: 'retrying', detail: prog };
  if (/备用 Provider|切换到备用|fallback/i.test(status)) return { phase: 'failover' };

  /* 尾巴上还挂着的条目 (pending), 取最新那条; 没有挂着的就看最新一条是什么 */
  const live = turn.find((e) => e.pending);
  if (turn.some((e) => e.type === 'context_compaction' && e.pending) || /compress|压缩/i.test(status)) {
    return { phase: 'compacting', detail: prog };
  }
  if (live) {
    const name = live.toolName ?? '';
    if (live.type === 'thinking') return { phase: 'thinking' };
    if (live.type === 'assistant_message' || live.type === 'assistant_prefix') {
      /* 正文条目刚建、一个字还没有: 算还在想 */
      return { phase: (live.detail ?? '').trim() ? 'writing' : 'thinking' };
    }
    if (live.type === 'plan' || live.type === 'plan_update') return { phase: 'planning' };
    if (live.type === 'explore_status' || live.type === 'worker_status') return { phase: 'delegating', entry: live };
    if (TOOL_TYPES.has(live.type)) {
      if (ASK_TOOL.test(name)) return { phase: 'asking', entry: live };
      if (PLAN_TOOL.test(name)) return { phase: 'planning', entry: live };
      if (DELEGATE_TOOL.test(name)) return { phase: 'delegating', entry: live };
      return { phase: 'tool', entry: live };
    }
  }

  /* 这一轮还没有任何模型输出 */
  const hasOutput = turn.some((e) => e.type === 'thinking' || e.type === 'assistant_message' || e.type === 'assistant_prefix' || TOOL_TYPES.has(e.type) || e.type === 'plan');
  if (!hasOutput) return { phase: /连接较慢|slow/i.test(status) ? 'slow' : 'connecting' };
  /* 计划 / 待办卡是一下就落定的 (type 'plan', 不挂 pending): 刚更新完计划、模型还没开口, 仍算规划 */
  const latest = turn[0];
  if (latest && (latest.type === 'plan' || latest.type === 'plan_update' || (TOOL_TYPES.has(latest.type) && PLAN_TOOL.test(latest.toolName ?? '')))) {
    return { phase: 'planning' };
  }
  return { phase: 'working' };
}

/** 短标签 (岛 / 播报行共用) */
export function phaseLabel(phase: AgentPhase, zh: boolean, detail?: string): string {
  const L: Record<AgentPhase, [string, string]> = {
    idle: ['空闲', 'Idle'],
    connecting: ['连接中', 'Connecting'],
    slow: ['连接较慢', 'Slow connection'],
    retrying: ['重试中', 'Retrying'],
    failover: ['切换线路', 'Switching route'],
    compacting: ['整理上下文', 'Compacting'],
    planning: ['规划中', 'Planning'],
    thinking: ['思考中', 'Thinking'],
    tool: ['执行中', 'Running'],
    delegating: ['子任务进行中', 'Sub-agent working'],
    writing: ['回复中', 'Writing'],
    working: ['整理结果', 'Reviewing results'],
    approval: ['等你确认', 'Needs you'],
    asking: ['等你回答', 'Your answer'],
    error: ['出错了', 'Error'],
    done: ['完成', 'Done'],
  };
  const base = L[phase][zh ? 0 : 1];
  return detail ? `${base} ${detail}` : base;
}
