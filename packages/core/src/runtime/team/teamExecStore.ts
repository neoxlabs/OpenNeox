
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { TeamPlan } from './teamPlanStore.js';
import { leafRequirements, scheduleWaves } from './teamPlanStore.js';

/** 一条活在执行期的状态 */
export type TaskState = 'pending' | 'blocked' | 'running' | 'done' | 'failed' | 'skipped';

export interface ExecTask {
  /** 叶子需求 id —— 跟规划层同键, 看板两边能对上 */
  id: string;
  title: string;
  /** 谁的活 (roster id) */
  memberId: string;
  /** 第几批 (1-based) */
  wave: number;
  state: TaskState;
  /** 这条活跑在哪个子会话 (= agentId) —— 点进去就是那个 agent 自己的 timeline */
  agentId?: string;
  startedAt?: number;
  finishedAt?: number;
  /** 失败原因 / 跳过原因 */
  note?: string;
  /** 产出摘要 (agent 回的最后一段) */
  result?: string;
  changedFiles?: string[];
}

/** agent 之间的一条消息 —— 用户要看的"不同 Agent 之间的交流" */
export interface ExecMessage {
  id: string;
  /** 谁发的 (roster id / 'conductor' 主脑 / 'system' 机制) */
  from: string;
  /** 发给谁 ('all' = 广播) */
  to: string;
  kind: 'contract_ready' | 'question' | 'answer' | 'blocker' | 'note';
  text: string;
  /** 关联的活 (可选) —— 消息流里能点回那条任务 */
  taskId?: string;
  at: number;
}

export interface TeamExecState {
  teamId: string;
  sessionId: string;
  workDir?: string;
  status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'aborted';
  /** 当前跑到第几批 (1-based; 0 = 还没开始) */
  currentWave: number;
  totalWaves: number;
  tasks: ExecTask[];
  messages: ExecMessage[];
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

const execBySession = new Map<string, TeamExecState>();

/* agentId (= 子会话 id, 形如 `M2#TEN-3`) → 父会话 id。
 * 领地闸跑在子会话里, 但团队方案挂在父会话上 —— 派兵时顺手登记一条, 闸就能反查到方案,
 * 不用去猜 sessionStore 的 parent hint (那条链是给占位行用的, 时序不保证)。 */
const agentOwner = new Map<string, { sessionId: string; memberId: string }>();

export function registerExecAgent(agentId: string, sessionId: string, memberId: string): void {
  agentOwner.set(agentId, { sessionId, memberId });
}
export function lookupExecAgent(agentId?: string | null): { sessionId: string; memberId: string } | null {
  return agentId ? agentOwner.get(agentId) ?? null : null;
}

type ExecPersistFn = (state: TeamExecState) => void;
let persistImpl: ExecPersistFn | null = null;
export function setTeamExecPersistence(fn: ExecPersistFn | null): void { persistImpl = fn; }

function touch(st: TeamExecState): TeamExecState {
  st.updatedAt = Date.now();
  execBySession.set(st.sessionId, st);
  try { persistImpl?.(st); } catch (err: any) {
    cliLogger.warn('TEAM_EXEC', `落盘失败 (不阻塞执行): ${err?.message ?? err}`);
  }
  return st;
}

export function getTeamExec(sessionId?: string | null): TeamExecState | null {
  return sessionId ? execBySession.get(sessionId) ?? null : null;
}

/**
 * 从规划层建执行态 —— 把 (批次 × 叶子 × 领取人) 展开成任务清单。
 *
 * 幂等: 已经在跑的会话直接返回现状, 不重建 (免得重复派兵)。
 */
export function startTeamExec(plan: TeamPlan, workDir?: string): TeamExecState {
  const exist = execBySession.get(plan.sessionId);
  if (exist && (exist.status === 'running' || exist.status === 'paused')) return exist;

  const waves = scheduleWaves(plan);
  const ownerOf = (rid: string) => plan.claims.find((c) => c.requirementIds.includes(rid))?.memberId;
  const byId = new Map(plan.requirements.map((r) => [r.id, r]));
  const tasks: ExecTask[] = [];
  waves.forEach((wave, wi) => {
    for (const id of wave) {
      const r = byId.get(id);
      if (!r) continue;
      tasks.push({
        id,
        title: r.title,
        memberId: ownerOf(id) ?? '?',
        wave: wi + 1,
        /* 第 1 批天然可跑; 后面的批次先挂 blocked, 等前一批收口时放行 */
        state: wi === 0 ? 'pending' : 'blocked',
      });
    }
  });
  const now = Date.now();
  return touch({
    teamId: plan.teamId,
    sessionId: plan.sessionId,
    workDir,
    status: 'running',
    currentWave: waves.length > 0 ? 1 : 0,
    totalWaves: waves.length,
    tasks,
    messages: [],
    startedAt: now,
    updatedAt: now,
  });
}

export function updateTask(
  sessionId: string,
  taskId: string,
  patch: Partial<Omit<ExecTask, 'id'>>,
): TeamExecState | null {
  const st = getTeamExec(sessionId);
  if (!st) return null;
  const t = st.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  Object.assign(t, patch);
  return touch(st);
}

export function postExecMessage(sessionId: string, msg: Omit<ExecMessage, 'id' | 'at'> & { at?: number }): TeamExecState | null {
  const st = getTeamExec(sessionId);
  if (!st) return null;
  st.messages.push({
    ...msg,
    at: msg.at ?? Date.now(),
    id: `msg_${st.messages.length + 1}_${Date.now().toString(36)}`,
  });
  return touch(st);
}


/** 重派一条活 —— 失败/做歪的活重置回待派, 调度器下一轮重新派兵 */
export function retryTask(sessionId: string, taskId: string): TeamExecState | null {
  const st = getTeamExec(sessionId);
  const t = st?.tasks.find((x) => x.id === taskId);
  if (!st || !t) return null;
  if (t.state === 'running') return null;   // 在跑的不许重派 (会起两个同 id 的 agent)
  t.state = 'pending';
  t.note = undefined; t.result = undefined; t.agentId = undefined;
  t.startedAt = undefined; t.finishedAt = undefined;
  /* 重派可能把已经收口的批次拉回未收口 —— 状态跟着退回 running, 否则调度器不会再看它 */
  if (st.status === 'done' || st.status === 'failed') st.status = 'running';
  if (t.wave < st.currentWave) st.currentWave = t.wave;
  return touch(st);
}

/** 跳过一条活 —— 不做了, 但要留理由 (谁都能复核为什么跳) */
export function skipTask(sessionId: string, taskId: string, reason: string): TeamExecState | null {
  const st = getTeamExec(sessionId);
  const t = st?.tasks.find((x) => x.id === taskId);
  if (!st || !t) return null;
  t.state = 'skipped';
  t.note = reason;
  t.finishedAt = Date.now();
  return touch(st);
}

/** 改派 —— 换个人做这条活 (返回 null = 目标成员不在这个团队的任务里) */
export function reassignTask(sessionId: string, taskId: string, memberId: string): TeamExecState | null {
  const st = getTeamExec(sessionId);
  const t = st?.tasks.find((x) => x.id === taskId);
  if (!st || !t) return null;
  if (t.state === 'running') return null;   // 在跑的先停下再改派
  t.memberId = memberId;
  if (t.state !== 'pending') {
    t.state = 'pending';
    t.note = undefined; t.result = undefined; t.agentId = undefined;
    t.startedAt = undefined; t.finishedAt = undefined;
    if (st.status === 'done' || st.status === 'failed') st.status = 'running';
    if (t.wave < st.currentWave) st.currentWave = t.wave;
  }
  return touch(st);
}

/** 这一批还有没有没收口的活 */
export function waveOpenTasks(st: TeamExecState, wave: number): ExecTask[] {
  return st.tasks.filter((t) => t.wave === wave && (t.state === 'pending' || t.state === 'blocked' || t.state === 'running'));
}

/**
 * 一批收口 → 放行下一批。
 *
 * 这就是"跨批串行"的落点: 下一批的活在前一批全部 done/failed/skipped 之前一律 blocked。
 * @returns 新的 currentWave (没有下一批则返回 0 表示全跑完)
 */
export function advanceWave(sessionId: string): number {
  const st = getTeamExec(sessionId);
  if (!st) return 0;
  if (waveOpenTasks(st, st.currentWave).length > 0) return st.currentWave;   // 还没收口
  const next = st.currentWave + 1;
  if (next > st.totalWaves) {
    st.status = st.tasks.some((t) => t.state === 'failed') ? 'failed' : 'done';
    st.finishedAt = Date.now();
    touch(st);
    return 0;
  }
  st.currentWave = next;
  for (const t of st.tasks) {
    if (t.wave === next && t.state === 'blocked') t.state = 'pending';
  }
  touch(st);
  return next;
}

/** 当前批里可以立刻派出去的活 (pending) */
export function runnableTasks(sessionId: string): ExecTask[] {
  const st = getTeamExec(sessionId);
  if (!st || st.status !== 'running') return [];
  return st.tasks.filter((t) => t.wave === st.currentWave && t.state === 'pending');
}

export function isTeamExecActive(sessionId?: string | null): boolean {
  const st = getTeamExec(sessionId);
  return !!st && (st.status === 'running' || st.status === 'paused');
}

export function setTeamExecStatus(sessionId: string, status: TeamExecState['status']): TeamExecState | null {
  const st = getTeamExec(sessionId);
  if (!st) return null;
  st.status = status;
  if (status === 'done' || status === 'failed' || status === 'aborted') st.finishedAt = Date.now();
  return touch(st);
}

export function clearTeamExec(sessionId: string): void { execBySession.delete(sessionId); }

/** 执行进度摘要 —— 药丸/看板/工具回执共用一份口径 */
export function execProgress(st: TeamExecState): {
  done: number; failed: number; running: number; total: number; pct: number;
} {
  const done = st.tasks.filter((t) => t.state === 'done').length;
  const failed = st.tasks.filter((t) => t.state === 'failed').length;
  const running = st.tasks.filter((t) => t.state === 'running').length;
  const total = st.tasks.length;
  return { done, failed, running, total, pct: total ? Math.round(((done + failed) / total) * 100) : 0 };
}

export function checkTerritory(
  plan: TeamPlan,
  memberId: string,
  relPath: string,
): { allowed: true } | { allowed: false; owner?: string; scopes: string[] } {
  const norm = relPath.replace(/^\.\//, '').replace(/\\/g, '/');
  const mine = plan.claims.find((c) => c.memberId === memberId)?.ownedScope ?? [];
  const hit = (scopes: string[]) => scopes.some((s) => {
    const sc = s.replace(/^\.\//, '').replace(/\\/g, '/');
    return sc.endsWith('/') ? norm.startsWith(sc) : (norm === sc || norm.startsWith(`${sc}/`));
  });
  if (hit(mine)) return { allowed: true };
  /* 谁的地盘? 报出来 —— agent 拿到这个就知道该找谁要契约, 而不是自己硬改 */
  const owner = plan.claims.find((c) => c.memberId !== memberId && hit(c.ownedScope ?? []))?.memberId;
  return { allowed: false, owner, scopes: mine };
}
