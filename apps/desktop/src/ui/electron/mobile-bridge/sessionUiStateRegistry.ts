/**
 * sessionUiStateRegistry.ts — Mobile bridge 可恢复 UI 状态 (plan / 活跃子代理).
 *
 * 跟 pendingActionsRegistry 同范式: streaming event 是 best-effort, phone 断线 /
 * 中途 subscribe 会漏掉早前推过的 plan_update / subagent_started。这里存"当前真相",
 * session.subscribe 时打包进 ui_state 让 phone 一次性恢复。
 *
 * 生命周期:
 *   - plan: 每次 plan_update 全量覆盖; session 存续期间一直保留 (跨 turn 有效,
 *     跟 desktop timeline plan 卡语义一致)。
 *   - subagents: worker_start 记录, worker_complete 移除; agent_turn_done /
 *     session_interrupted 时全清 (turn 结束不可能还有活 worker, 防泄漏)。
 */

export interface PlanStepSnapshot {
  step: string;
  status: string; // pending | in_progress | completed (+ 兼容未来扩展)
}

export interface PlanSnapshot {
  explanation: string | null;
  plan: PlanStepSnapshot[];
  updated_at: number;
}

export interface ActiveSubagentSnapshot {
  agent_id: string;
  task: string;
  model: string | null;
  role_name: string | null;
  is_background: boolean;
  /* true = agentTool 派的真子 agent (agentId 即子会话 id, 可 session.history);
   * false = Explore/并行探索之类的纯展示 worker, 没有独立会话。 */
  is_agent_tool: boolean;
  model_inherited: boolean;
  started_at: number;
}

const planBySession = new Map<string, PlanSnapshot>();
const subagentsBySession = new Map<string, Map<string, ActiveSubagentSnapshot>>();

export function recordPlanUpdate(
  sessionId: string,
  snapshot: { explanation?: string | null; plan: PlanStepSnapshot[] },
): void {
  if (!sessionId) return;
  planBySession.set(sessionId, {
    explanation: snapshot.explanation ?? null,
    plan: snapshot.plan.map((s) => ({ step: s.step, status: s.status })),
    updated_at: Date.now(),
  });
}

export function getPlan(sessionId: string): PlanSnapshot | null {
  const p = planBySession.get(sessionId);
  if (!p) return null;
  return { ...p, plan: p.plan.map((s) => ({ ...s })) };
}

export function recordSubagentStart(
  sessionId: string,
  info: Omit<ActiveSubagentSnapshot, 'started_at'> & { started_at?: number },
): void {
  if (!sessionId || !info.agent_id) return;
  let m = subagentsBySession.get(sessionId);
  if (!m) {
    m = new Map();
    subagentsBySession.set(sessionId, m);
  }
  m.set(info.agent_id, { ...info, started_at: info.started_at ?? Date.now() });
}

export function recordSubagentDone(sessionId: string, agentId: string): void {
  const m = subagentsBySession.get(sessionId);
  if (!m) return;
  m.delete(agentId);
  if (m.size === 0) subagentsBySession.delete(sessionId);
}

export function getActiveSubagents(sessionId: string): ActiveSubagentSnapshot[] {
  return [...(subagentsBySession.get(sessionId)?.values() ?? [])].map((s) => ({ ...s }));
}

export function clearActiveSubagents(sessionId: string): void {
  subagentsBySession.delete(sessionId);
}

/** session 删除时全清 (plan + subagents). */
export function clearSessionUiState(sessionId: string): void {
  planBySession.delete(sessionId);
  subagentsBySession.delete(sessionId);
}

export function _clearAllSessionUiStateForTest(): void {
  planBySession.clear();
  subagentsBySession.clear();
}
