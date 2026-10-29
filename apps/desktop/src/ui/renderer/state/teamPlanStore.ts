/**
 * teamPlanStore (renderer) —— 团队规划看板的数据源
 * ═══════════════════════════════════════════════════════════════════════════
 * 上一版的 team 看板是纯内存 Map: 刷新一次、切一次会话就变「暂无 Team 运行」, 被用户当场
 * 点名。这一版的定位很清楚: **内存只是缓存, 真相在库里** (team_sessions.mission_graph)。
 *   · 直播: team_plan_update 事件进来就更新缓存 (规划过程实时长)
 *   · 重建: 切到某个会话时 hydrate(sessionId) 走 IPC 从库里捞回来
 * 两条路写同一份快照, 所以刷新前后看到的东西一模一样。
 */

import { useSyncExternalStore } from 'react';

export type TeamStage = 'requirements' | 'roster' | 'assignment' | 'ready';

export interface TeamRequirement {
  id: string; title: string; detail?: string; acceptance?: string;
  module?: string; priority?: 'P0' | 'P1' | 'P2'; dependsOn?: string[];
  estimateHours?: number;
  /** 人天 —— 表格里单独一列 */
  estimateDays?: number;
  /** 任务状态 —— 表格里单独一列 */
  status?: 'todo' | 'doing' | 'blocked' | 'done';
  parentId?: string;
  depth?: number;
  kind?: 'branch' | 'leaf';
  leafReason?: string;
}
export interface TeamMember {
  id: string; role: string; title: string; why?: string; model?: string;
  /** 定级 (自由文本: 资深/中级/专家/P6) + 依据 —— 看板「定级」页 */
  level?: string; levelReason?: string;
}
/** 会议记录 —— 会议台 tab: 需求评审 / 开发研讨 / 测试研讨 / 复盘 / 站会 */
export type TeamMeetingKind = 'requirements' | 'design' | 'test' | 'estimate' | 'review' | 'standup';
export interface TeamMeetingNote { memberId: string; say: string }
export interface TeamMeeting {
  id: string; kind: TeamMeetingKind; title: string;
  participants: string[]; notes: TeamMeetingNote[];
  decisions?: string[]; openQuestions?: string[]; at: number;
}
export interface TeamClaim { memberId: string; requirementIds: string[]; ownedScope?: string[]; why?: string }
export interface TeamMemberReview {
  memberId: string; picks: string[]; analysis: string; concerns?: string; needs?: string[]; at: number;
}

export type TaskState = 'pending' | 'blocked' | 'running' | 'done' | 'failed' | 'skipped';
export interface ExecTask {
  id: string; title: string; memberId: string; wave: number; state: TaskState;
  /** 子会话 id —— 点它就能跳进那个 agent 自己的 timeline */
  agentId?: string;
  startedAt?: number; finishedAt?: number; note?: string; result?: string; changedFiles?: string[];
}
export interface ExecMessage {
  id: string; from: string; to: string;
  kind: 'contract_ready' | 'question' | 'answer' | 'blocker' | 'note';
  text: string; taskId?: string; at: number;
}
export interface TeamExecSnapshot {
  teamId: string; sessionId: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted';
  currentWave: number; totalWaves: number;
  tasks: ExecTask[]; messages: ExecMessage[];
  progress?: { done: number; failed: number; running: number; total: number; pct: number };
  updatedAt: number;
}

export interface TeamPlanSnapshot {
  teamId: string;
  sessionId: string;
  goal: string;
  stage: TeamStage;
  /** 需求分析文档 (给人读的那份) —— 看板「文档」页读它 */
  documentPath?: string;
  requirements: TeamRequirement[];
  roster: TeamMember[];
  reviews: TeamMemberReview[];
  /** 会议记录 —— 会议台 tab */
  meetings: TeamMeeting[];
  claims: TeamClaim[];
  updatedAt: number;
}

const bySession = new Map<string, TeamPlanSnapshot>();
/** 执行态 —— 跟规划态分开存: 规划是"计划", 执行是"现场", 两者生命周期不同 */
const execBySession = new Map<string, TeamExecSnapshot>();
const listeners = new Set<() => void>();
/* hydrate 去重 —— 同一会话并发请求只发一次 IPC */
const hydrating = new Set<string>();

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[teamPlanStore]', err); }
  }
}

function normalize(raw: any, sessionId: string): TeamPlanSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const stage = ['requirements', 'roster', 'assignment', 'ready'].includes(raw.stage) ? raw.stage : 'requirements';
  return {
    teamId: String(raw.teamId ?? ''),
    sessionId: String(raw.sessionId ?? sessionId),
    goal: String(raw.goal ?? ''),
    stage,
    documentPath: raw.documentPath ? String(raw.documentPath) : undefined,
    requirements: Array.isArray(raw.requirements) ? raw.requirements : [],
    roster: Array.isArray(raw.roster) ? raw.roster : [],
    reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
    meetings: Array.isArray(raw.meetings) ? raw.meetings : [],
    claims: Array.isArray(raw.claims) ? raw.claims : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export function ingestTeamPlanEvent(sessionId: string, event: any): boolean {
  const snap = normalize(event, sessionId);
  if (!sessionId || !snap) return false;
  const first = !bySession.has(sessionId);
  bySession.set(sessionId, snap);
  emit();
  return first;
}

/** 直播: team_exec_update 事件 —— 执行台靠它实时长 */
export function ingestTeamExecEvent(sessionId: string, event: any): boolean {
  if (!sessionId || !event) return false;
  const first = !execBySession.has(sessionId);
  execBySession.set(sessionId, {
    teamId: String(event.teamId ?? ''),
    sessionId,
    status: event.status ?? 'running',
    currentWave: Number(event.currentWave) || 0,
    totalWaves: Number(event.totalWaves) || 0,
    tasks: Array.isArray(event.tasks) ? event.tasks : [],
    messages: Array.isArray(event.messages) ? event.messages : [],
    progress: event.progress,
    updatedAt: Number(event.timestamp) || Date.now(),
  });
  emit();
  return first;
}

export function getTeamExecSnapshot(sessionId?: string | null): TeamExecSnapshot | null {
  return sessionId ? execBySession.get(sessionId) ?? null : null;
}

export function useTeamExec(sessionId?: string | null): TeamExecSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? execBySession.get(sessionId) ?? null : null),
    () => null,
  );
}

/** 重建: 从库里捞 (切会话 / 刷新后调一次)。规划 + 执行两份一起捞。 */
export async function hydrateTeamPlan(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId || hydrating.has(sessionId)) return;
  hydrating.add(sessionId);
  try {
    const raw = await (window as any).neox?.getTeamPlan?.(sessionId);
    const snap = normalize(raw, sessionId);
    if (snap) { bySession.set(sessionId, snap); emit(); }
    else if (bySession.delete(sessionId)) emit();   /* 库里没有 = 这个会话不是团队会话 */
    /* 执行态同样要重建 —— 否则切走再回来执行台是一片空白 (规划态那一版就是这么被点名的) */
    try {
      const ex = await (window as any).neox?.getTeamExec?.(sessionId);
      if (ex && Array.isArray(ex.tasks)) {
        execBySession.set(sessionId, {
          teamId: String(ex.teamId ?? ''), sessionId,
          status: ex.status ?? 'done',
          currentWave: Number(ex.currentWave) || 0,
          totalWaves: Number(ex.totalWaves) || 0,
          tasks: ex.tasks, messages: Array.isArray(ex.messages) ? ex.messages : [],
          progress: ex.progress,
          updatedAt: Number(ex.updatedAt) || Date.now(),
        });
        emit();
      }
    } catch { /* 执行态读不到不影响规划态 */ }
  } catch {
    /* 读不到就保持现状 —— 宁可显示旧快照, 也别把看板清空 */
  } finally {
    hydrating.delete(sessionId);
  }
}

export function getTeamPlanSnapshot(sessionId?: string | null): TeamPlanSnapshot | null {
  return sessionId ? bySession.get(sessionId) ?? null : null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useTeamPlan(sessionId?: string | null): TeamPlanSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? bySession.get(sessionId) ?? null : null),
    () => null,
  );
}

/** 看板上把一条需求分配给某个成员 (memberId=null 收回) —— 用户操作, 走 IPC 写回 core 并落库 */
export async function assignRequirement(
  sessionId: string, requirementId: string, memberId: string | null,
): Promise<void> {
  try {
    const updated = await (window as any).neox?.assignTeamRequirement?.({ sessionId, requirementId, memberId });
    const snap = normalize(updated, sessionId);
    if (snap) { bySession.set(sessionId, snap); emit(); }
  } catch (err) {
    console.error('[teamPlanStore] assign failed', err);
  }
}

export async function execCommand(
  sessionId: string,
  cmd: 'retry' | 'skip' | 'reassign',
  taskId: string,
  arg?: string,
): Promise<boolean> {
  try {
    const st = await (window as any).neox?.teamExecCommand?.({ sessionId, cmd, taskId, arg });
    if (st && Array.isArray(st.tasks)) {
      execBySession.set(sessionId, {
        teamId: String(st.teamId ?? ''), sessionId,
        status: st.status ?? 'running',
        currentWave: Number(st.currentWave) || 0,
        totalWaves: Number(st.totalWaves) || 0,
        tasks: st.tasks, messages: Array.isArray(st.messages) ? st.messages : [],
        updatedAt: Date.now(),
      });
      emit();
      return true;
    }
  } catch (err) { console.error('[teamPlanStore] execCommand failed', err); }
  return false;
}

export async function dismissTeam(sessionId: string, force = false): Promise<{ ok: boolean; reason?: string; runningTasks?: string[] }> {
  try {
    const res = await (window as any).neox?.teamDismiss?.({ sessionId, force });
    if (res?.ok) {
      bySession.delete(sessionId);
      execBySession.delete(sessionId);
      emit();
    }
    return res ?? { ok: false, reason: 'ipc unavailable' };
  } catch (err: any) {
    console.error('[teamPlanStore] dismissTeam failed', err);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

export function teamStageMeta(plan: TeamPlanSnapshot, isZh: boolean): { label: string; step: string; detail: string } {
  const claimed = new Set(plan.claims.flatMap((c) => c.requirementIds));
  const hasKid = new Set(plan.requirements.map((r) => r.parentId).filter(Boolean) as string[]);
  const leaves = plan.requirements.filter((r) => (r.kind ? r.kind === 'leaf' : !hasKid.has(r.id)));
  const unclaimed = leaves.filter((r) => !claimed.has(r.id)).length;
  const isTree = plan.requirements.some((r) => r.parentId);
  /** 拆解中/拆完都用这一句 —— 树形时说清两个口径, 平铺时只说条数 */
  const scale = isTree
    ? (isZh ? `${plan.requirements.length} 节点 · ${leaves.length} 叶子` : `${plan.requirements.length} nodes · ${leaves.length} leaves`)
    : (isZh ? `${plan.requirements.length} 条` : `${plan.requirements.length}`);
  switch (plan.stage) {
    case 'requirements':
      return { label: isZh ? '解析需求' : 'Requirements', step: '1/4',
        detail: isZh ? `已拆 ${scale}` : `${scale}` };
    case 'roster':
      return { label: isZh ? '定编制' : 'Roster', step: '2/4',
        detail: isZh ? `${scale} · ${plan.roster.length} 人` : `${scale} · ${plan.roster.length} members` };
    case 'assignment':
      return { label: isZh ? '领取需求' : 'Claiming', step: '3/4',
        detail: isZh ? `还剩 ${unclaimed} 条没人领` : `${unclaimed} unclaimed` };
    case 'ready':
      return { label: isZh ? '方案就绪' : 'Plan ready', step: '4/4',
        detail: isZh ? `${scale} · ${plan.roster.length} 人` : `${scale} · ${plan.roster.length} members` };
  }
}
