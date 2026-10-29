import { useSyncExternalStore } from 'react';
import { getContextSnapshot } from './contextSnapshot';

/* ============================================================
 * 事件协议 (schema 已与 core 路锁定, 字段防御性收敛但不扩义)
 * ============================================================ */

export type TeamLaneStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed';
export type TeamRunStatus = 'planning' | 'plan_ready' | 'running' | 'success' | 'partial' | 'aborted';
export type TeamBlackboardKind = 'result' | 'note' | 'blocker';

export interface TeamRunStartEvent {
  type: 'team_run_start';
  teamId: string;
  goal: string;
  /** 'planning' = 只传 goal 的规划启动 (无泳道)
   *  'plan_ready' = 编队草案已登记 (有泳道, 但一个 agent 都没派)
   *  缺省 = running (老执行路径) */
  status?: 'planning' | 'plan_ready' | 'running';
  lanes: Array<{
    /** laneId 即子会话 id (agentId) — 点泳道跳子会话 / abortSubAgent 都用它 */
    laneId: string;
    role: string;
    agentName: string;
    model?: string;
    scope?: string[];
    /** 这条泳道认领的战略块 id —— 编队跟块清单的连接点 */
    blockIds?: string[];
    milestones?: Array<{ id: string; title: string }>;
  }>;
  timestamp?: number;
}

export interface TeamLaneUpdateEvent {
  type: 'team_lane_update';
  teamId: string;
  laneId: string;
  status: TeamLaneStatus;
  currentAction?: string;
  progress?: { toolCount?: number; changedFiles?: number };
  /** 协议外前向兼容: core 若带已达里程碑 id 列表, 直接采纳 */
  reachedMilestones?: string[];
  timestamp?: number;
}

export interface TeamBlackboardPostEvent {
  type: 'team_blackboard_post';
  teamId: string;
  entry: {
    key: string;
    kind: TeamBlackboardKind;
    ref?: string;
    summary: string;
    author: string;
    ts?: number;
  };
}

export interface TeamRunCompleteEvent {
  type: 'team_run_complete';
  teamId: string;
  status: Exclude<TeamRunStatus, 'running'>;
  report: string;
  laneSummaries?: Array<{
    laneId: string;
    role: string;
    status: string;
    branch?: string;
    changedFiles?: number;
  }>;
  timestamp?: number;
}

export type TeamRunEvent =
  | TeamRunStartEvent
  | TeamLaneUpdateEvent
  | TeamBlackboardPostEvent
  | TeamRunCompleteEvent;

/* ============================================================
 * 快照类型 (不可变 — 每次 apply 换新引用, useSyncExternalStore 契约)
 * ============================================================ */

export interface TeamMilestone {
  id: string;
  title: string;
  reached: boolean;
}

export interface TeamLaneSnapshot {
  laneId: string;
  role: string;
  agentName: string;
  model?: string;
  scope: string[];
  /** 认领的战略块 id (编队草案里才有) */
  blockIds?: string[];
  milestones: TeamMilestone[];
  status: TeamLaneStatus;
  currentAction?: string;
  toolCount: number;
  changedFiles: number;
  updatedAt: number;
}

export interface TeamBlackboardEntry {
  key: string;
  kind: TeamBlackboardKind;
  ref?: string;
  summary: string;
  author: string;
  ts: number;
}

export interface TeamLaneSummary {
  laneId: string;
  role: string;
  status: string;
  branch?: string;
  changedFiles?: number;
}

export interface TeamRunSnapshot {
  sessionId: string;
  teamId: string;
  goal: string;
  status: TeamRunStatus;
  lanes: TeamLaneSnapshot[];
  blackboard: TeamBlackboardEntry[];
  report?: string;
  laneSummaries?: TeamLaneSummary[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

/* ============================================================
 * store 本体
 * ============================================================ */

/** 一个 session 同时只有一个 Team (新 team_run_start 直接替换) */
const teamsBySession = new Map<string, TeamRunSnapshot>();
const listeners = new Set<() => void>();

const EMPTY_RUNS: TeamRunSnapshot[] = [];
/** 全局"进行中 Team"缓存 — TeamPanelModal 跨 session 显示; 成员没变则保持旧引用 */
let activeRunsCache: TeamRunSnapshot[] = EMPTY_RUNS;

function rebuildActiveRuns(): void {
  const next: TeamRunSnapshot[] = [];
  for (const t of teamsBySession.values()) {
    if (t.status === 'running' || t.status === 'planning' || t.status === 'plan_ready') next.push(t);
  }
  next.sort((a, b) => b.startedAt - a.startedAt);
  const same = next.length === activeRunsCache.length
    && next.every((t, i) => t === activeRunsCache[i]);
  if (!same) activeRunsCache = next.length === 0 ? EMPTY_RUNS : next;
}

function emit(): void {
  rebuildActiveRuns();
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[teamRunStore]', err); }
  }
}

function normalizeLaneStatus(s: unknown): TeamLaneStatus {
  return s === 'running' || s === 'blocked' || s === 'done' || s === 'failed'
    ? s
    : 'running';
}

/** 黑板 key 命中里程碑 — 支持裸 id / milestone:<id> / milestone/<id> 三种写法 */
function milestoneMatchesKey(milestoneId: string, key: string): boolean {
  return key === milestoneId || key === `milestone:${milestoneId}` || key === `milestone/${milestoneId}`;
}

/** laneSummaries.status (自由字符串) → 泳道终态; 认不出返回 null 保持原状 */
function summaryStatusToLaneStatus(s: string): TeamLaneStatus | null {
  const k = (s || '').toLowerCase();
  if (k === 'done' || k === 'success' || k === 'completed') return 'done';
  if (k === 'failed' || k === 'error' || k === 'aborted') return 'failed';
  if (k === 'blocked') return 'blocked';
  return null;
}

/**
 * 纯状态机: 应用一个 team 事件, 返回是否改变了状态。
 * 与副作用 (auto-open surface) 分离, 单测直接打这里 / ingestTeamRunEvent。
 */
export function applyTeamEvent(sessionId: string, event: TeamRunEvent): boolean {
  if (!sessionId || !event || typeof (event as { teamId?: unknown }).teamId !== 'string') return false;

  if (event.type === 'team_run_start') {
    const now = event.timestamp ?? Date.now();
    const lanes: TeamLaneSnapshot[] = (Array.isArray(event.lanes) ? event.lanes : [])
      .filter((l) => l && typeof l.laneId === 'string')
      .map((l) => ({
        laneId: l.laneId,
        role: String(l.role ?? 'member'),
        agentName: String(l.agentName ?? l.laneId),
        model: l.model ? String(l.model) : undefined,
        scope: Array.isArray(l.scope) ? l.scope.map(String) : [],
        blockIds: Array.isArray((l as { blockIds?: unknown[] }).blockIds)
          ? (l as { blockIds: unknown[] }).blockIds.map(String)
          : [],
        milestones: (Array.isArray(l.milestones) ? l.milestones : [])
          .filter((m) => m && typeof m.id === 'string')
          .map((m) => ({ id: m.id, title: String(m.title ?? m.id), reached: false })),
        /* 编队草案里的泳道还没开跑 —— 别标 running, 否则面板显示一排"运行中"的假象 */
        status: (event.status === 'plan_ready' ? 'pending' : 'running') as TeamLaneStatus,
        toolCount: 0,
        changedFiles: 0,
        updatedAt: now,
      }));
    teamsBySession.set(sessionId, {
      sessionId,
      teamId: event.teamId,
      goal: String(event.goal ?? ''),
      status: event.status === 'planning' ? 'planning'
        : event.status === 'plan_ready' ? 'plan_ready'
          : 'running',
      lanes,
      blackboard: [],
      startedAt: now,
      updatedAt: now,
    });
    emit();
    return true;
  }

  const prev = teamsBySession.get(sessionId);
  /* 中途事件没头 (重连丢 start) 或 teamId 不匹配 (陈旧事件) — 忽略, 不建半截状态 */
  if (!prev || prev.teamId !== event.teamId) return false;

  if (event.type === 'team_lane_update') {
    if (typeof event.laneId !== 'string' || !event.laneId) return false;
    const now = event.timestamp ?? Date.now();
    const status = normalizeLaneStatus(event.status);
    let found = false;
    let lanes = prev.lanes.map((lane) => {
      if (lane.laneId !== event.laneId) return lane;
      found = true;
      const reachedIds = new Set(Array.isArray(event.reachedMilestones) ? event.reachedMilestones : []);
      const milestones = (status === 'done' || reachedIds.size > 0)
        ? lane.milestones.map((m) => (
            status === 'done' || reachedIds.has(m.id) ? { ...m, reached: true } : m
          ))
        : lane.milestones;
      return {
        ...lane,
        status,
        currentAction: typeof event.currentAction === 'string' ? event.currentAction : lane.currentAction,
        toolCount: typeof event.progress?.toolCount === 'number' ? event.progress.toolCount : lane.toolCount,
        changedFiles: typeof event.progress?.changedFiles === 'number' ? event.progress.changedFiles : lane.changedFiles,
        milestones,
        updatedAt: now,
      };
    });
    if (!found) {
      /* 没拿到 start 里的这条泳道 (SSE 漏帧兜底, 对齐 subAgentsStore 的兜底建条) */
      lanes = [...lanes, {
        laneId: event.laneId,
        role: 'member',
        agentName: event.laneId,
        scope: [],
        milestones: [],
        status,
        currentAction: typeof event.currentAction === 'string' ? event.currentAction : undefined,
        toolCount: Number(event.progress?.toolCount) || 0,
        changedFiles: Number(event.progress?.changedFiles) || 0,
        updatedAt: now,
      }];
    }
    teamsBySession.set(sessionId, { ...prev, lanes, updatedAt: now });
    emit();
    return true;
  }

  if (event.type === 'team_blackboard_post') {
    const raw = event.entry;
    if (!raw || typeof raw.key !== 'string' || !raw.key) return false;
    const entry: TeamBlackboardEntry = {
      key: raw.key,
      kind: raw.kind === 'result' || raw.kind === 'note' || raw.kind === 'blocker' ? raw.kind : 'note',
      ref: typeof raw.ref === 'string' ? raw.ref : undefined,
      summary: String(raw.summary ?? ''),
      author: String(raw.author ?? ''),
      ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
    };
    /* 同 key upsert: 旧条目移除, 新条目追加到尾 (时间序列语义 = 最近一次落板) */
    const blackboard = [...prev.blackboard.filter((e) => e.key !== entry.key), entry];
    /* key 命中里程碑 → 点亮 (设计: 到达里程碑即写黑板, Conductor 广播) */
    let lanesChanged = false;
    const lanes = prev.lanes.map((lane) => {
      if (!lane.milestones.some((m) => !m.reached && milestoneMatchesKey(m.id, entry.key))) return lane;
      lanesChanged = true;
      return {
        ...lane,
        milestones: lane.milestones.map((m) => (
          milestoneMatchesKey(m.id, entry.key) ? { ...m, reached: true } : m
        )),
      };
    });
    teamsBySession.set(sessionId, {
      ...prev,
      blackboard,
      lanes: lanesChanged ? lanes : prev.lanes,
      updatedAt: entry.ts,
    });
    emit();
    return true;
  }

  if (event.type === 'team_run_complete') {
    const now = event.timestamp ?? Date.now();
    const status: TeamRunStatus =
      event.status === 'success' || event.status === 'partial' || event.status === 'aborted'
        ? event.status
        : 'partial';
    const laneSummaries: TeamLaneSummary[] = (Array.isArray(event.laneSummaries) ? event.laneSummaries : [])
      .filter((s) => s && typeof s.laneId === 'string')
      .map((s) => ({
        laneId: s.laneId,
        role: String(s.role ?? ''),
        status: String(s.status ?? ''),
        branch: typeof s.branch === 'string' ? s.branch : undefined,
        changedFiles: typeof s.changedFiles === 'number' ? s.changedFiles : undefined,
      }));
    const summaryByLane = new Map(laneSummaries.map((s) => [s.laneId, s]));
    /* 终态回折: summary 有就用 summary; 没 summary 且整队 success → 收敛成 done */
    const lanes = prev.lanes.map((lane) => {
      const summary = summaryByLane.get(lane.laneId);
      const mapped = summary ? summaryStatusToLaneStatus(summary.status) : null;
      const nextStatus: TeamLaneStatus = mapped
        ?? (lane.status === 'running' && status === 'success' ? 'done' : lane.status);
      const changedFiles = typeof summary?.changedFiles === 'number' ? summary.changedFiles : lane.changedFiles;
      const milestones = nextStatus === 'done'
        ? lane.milestones.map((m) => (m.reached ? m : { ...m, reached: true }))
        : lane.milestones;
      if (nextStatus === lane.status && changedFiles === lane.changedFiles && milestones === lane.milestones) return lane;
      return { ...lane, status: nextStatus, changedFiles, milestones, updatedAt: now };
    });
    teamsBySession.set(sessionId, {
      ...prev,
      status,
      report: String(event.report ?? ''),
      laneSummaries,
      lanes,
      updatedAt: now,
      completedAt: now,
    });
    emit();
    return true;
  }

  return false;
}

/* ============================================================
 * 打开 team surface (kind 'team', singleton — surfaceStore 内已做单实例合并)
 * ============================================================ */

const TEAM_TITLE_MAX = 32;

function teamSurfaceTitle(goal?: string): string {
  const g = (goal ?? '').trim().replace(/\s+/g, ' ');
  if (!g) return 'Team';
  return g.length > TEAM_TITLE_MAX ? `${g.slice(0, TEAM_TITLE_MAX)}…` : g;
}

/**
 * 右栏打开 team surface — team_run_start 自动调, TeamPanelModal 的"进行中 Team"卡点击也调。
 * 动态 import surfaceStore (对齐 NeoxRuntimeBridge 的接线方式), node 测试环境无 window 直接跳过。
 */
export function openTeamSurface(sessionId: string, opts: { teamId: string; goal?: string; reveal?: boolean }): void {
  if (!sessionId || !opts?.teamId || typeof window === 'undefined') return;
  void import('./surfaceStore').then(({ ingestSurfaceEvent }) => {
    const now = Date.now();
    ingestSurfaceEvent(sessionId, {
      action: 'open',
      surface: {
        id: `team-${opts.teamId}`,
        kind: 'team',
        source: { type: 'inline', content: '' },
        title: teamSurfaceTitle(opts.goal),
        pinned: false,
        metadata: { teamId: opts.teamId, singleton: true },
        createdAt: now,
        updatedAt: now,
      },
    }, opts.reveal ? { reveal: true } : undefined);
  }).catch((err) => {
    console.warn('[teamRunStore] open team surface failed:', err);
  });
}

/**
 * stream 接入口 — useStreamHandler 的 team_* 四个 case 都打这里。
 * apply 状态机 + team_run_start 时自动开 surface。
 */
export function ingestTeamRunEvent(sessionId: string, event: TeamRunEvent): void {
  const changed = applyTeamEvent(sessionId, event);
  if (changed && event.type === 'team_run_start') {
    openTeamSurface(sessionId, { teamId: event.teamId, goal: event.goal });
  }
}

/* ============================================================
 * 订阅 hooks
 * ============================================================ */

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

export function getTeamRunSnapshot(sessionId: string | null | undefined): TeamRunSnapshot | null {
  if (!sessionId) return null;
  return teamsBySession.get(sessionId) ?? null;
}

/** 当前 session 的 Team (含已完成 — 完成态要显 report), 无则 null */
export function useTeamRun(sessionId: string | null | undefined): TeamRunSnapshot | null {
  const sid = sessionId ?? '';
  return useSyncExternalStore(
    subscribe,
    () => (sid ? teamsBySession.get(sid) ?? null : null),
    () => null,
  );
}

/** 全部 session 里"进行中"的 Team — TeamPanelModal 顶部卡用 */
export function useActiveTeamRuns(): TeamRunSnapshot[] {
  return useSyncExternalStore(subscribe, () => activeRunsCache, () => EMPTY_RUNS);
}

export function _resetTeamRunStoreForTest(): void {
  teamsBySession.clear();
  activeRunsCache = EMPTY_RUNS;
  listeners.clear();
}

/* ============================================================
 * DEV mock — core 路还没合流时驱动完整 UI 验证。
 *
 * 用法 (dev build, DevTools console):
 *   window.__neoxMockTeamRun()            // 自动挑 session (最近流式会话 → 最近更新会话)
 *   window.__neoxMockTeamRun('<sessionId>')  // 指定 session
 *   返回 cancel(); 再次调用会自动取消上一轮未播完的事件。
 * ============================================================ */

let activeMockCancel: (() => void) | null = null;

async function resolveMockSessionId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const fromSnapshot = getContextSnapshot()?.sessionId;
  if (fromSnapshot) return fromSnapshot;
  try {
    const api = (window as unknown as { neox?: { getSessions?: () => Promise<Array<Record<string, unknown>>> } }).neox;
    const sessions = await api?.getSessions?.();
    if (Array.isArray(sessions) && sessions.length > 0) {
      const sorted = [...sessions].sort((a, b) => {
        const ta = Number(a?.updatedAt ?? a?.lastActiveAt ?? a?.createdAt ?? 0);
        const tb = Number(b?.updatedAt ?? b?.lastActiveAt ?? b?.createdAt ?? 0);
        return tb - ta;
      });
      const id = sorted[0]?.id;
      if (typeof id === 'string') return id;
    }
  } catch { /* fall through */ }
  return null;
}

async function mockTeamRun(explicitSessionId?: string): Promise<(() => void) | null> {
  if (activeMockCancel) { activeMockCancel(); activeMockCancel = null; }
  const sessionId = await resolveMockSessionId(explicitSessionId);
  if (!sessionId) {
    console.warn('[teamRunStore] mock: 找不到 session — 请先发一条消息, 或显式传 sessionId: window.__neoxMockTeamRun("<sessionId>")');
    return null;
  }
  const teamId = `team-mock-${Date.now().toString(36)}`;
  console.info(`[teamRunStore] mock team run → session=${sessionId} teamId=${teamId}`);

  const LANE_PLAN = 'mock-lane-planner';
  const LANE_IMPL = 'mock-lane-impl';
  const LANE_REVIEW = 'mock-lane-review';

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const push = (delay: number, ev: TeamRunEvent): void => {
    timers.push(setTimeout(() => ingestTeamRunEvent(sessionId, ev), delay));
  };

  push(0, {
    type: 'team_run_start',
    teamId,
    goal: '重构结算模块: 拆分计费引擎、补齐折扣规则、交叉审查回归风险',
    lanes: [
      {
        laneId: LANE_PLAN, role: 'planner', agentName: 'Planner', model: 'claude-sonnet',
        scope: ['docs/plan/**'],
        milestones: [{ id: 'm-interface', title: '接口定型' }, { id: 'm-plan-done', title: '规划完成' }],
      },
      {
        laneId: LANE_IMPL, role: 'implementer', agentName: 'Implementer', model: 'grok-code',
        scope: ['src/billing/**', 'src/discount/**'],
        milestones: [{ id: 'm-engine', title: '计费引擎' }, { id: 'm-impl-done', title: '实现完成' }],
      },
      {
        laneId: LANE_REVIEW, role: 'reviewer', agentName: 'Reviewer', model: 'gpt-5',
        scope: [],
        milestones: [{ id: 'm-verdict', title: '验收结论' }],
      },
    ],
    timestamp: Date.now(),
  });
  push(700, { type: 'team_lane_update', teamId, laneId: LANE_PLAN, status: 'running', currentAction: '梳理计费模块边界与依赖', progress: { toolCount: 3, changedFiles: 0 } });
  push(1300, { type: 'team_lane_update', teamId, laneId: LANE_IMPL, status: 'running', currentAction: '阅读 src/billing 现状', progress: { toolCount: 5, changedFiles: 0 } });
  push(2000, { type: 'team_blackboard_post', teamId, entry: { key: 'note-plan-draft', kind: 'note', summary: '计费引擎按 usage/subscription 两轴拆分, 折扣规则独立成 policy 层', author: 'Planner', ts: Date.now() + 2000 } });
  push(2800, { type: 'team_blackboard_post', teamId, entry: { key: 'milestone:m-interface', kind: 'result', ref: 'docs/plan/billing-interface.md', summary: '接口定型: BillingEngine.calculate(order) → Invoice', author: 'Planner', ts: Date.now() + 2800 } });
  push(3400, { type: 'team_lane_update', teamId, laneId: LANE_PLAN, status: 'done', currentAction: '规划完成, 已写黑板', progress: { toolCount: 9, changedFiles: 1 } });
  push(4000, { type: 'team_lane_update', teamId, laneId: LANE_IMPL, status: 'blocked', currentAction: '等待折扣规则口径确认', progress: { toolCount: 11, changedFiles: 3 } });
  push(4600, { type: 'team_blackboard_post', teamId, entry: { key: 'blocker-discount', kind: 'blocker', summary: '旧数据里存在负数折扣, 需要 Conductor 拍板兼容策略', author: 'Implementer', ts: Date.now() + 4600 } });
  push(5400, { type: 'team_lane_update', teamId, laneId: LANE_IMPL, status: 'running', currentAction: '按"负数折扣视为 0"继续实现', progress: { toolCount: 14, changedFiles: 5 } });
  push(6200, { type: 'team_lane_update', teamId, laneId: LANE_REVIEW, status: 'running', currentAction: '交叉审查计费引擎 diff', progress: { toolCount: 4, changedFiles: 0 } });
  push(7000, { type: 'team_lane_update', teamId, laneId: LANE_IMPL, status: 'done', currentAction: '实现完成, 21 文件', progress: { toolCount: 23, changedFiles: 21 }, reachedMilestones: ['m-engine', 'm-impl-done'] });
  push(7800, { type: 'team_blackboard_post', teamId, entry: { key: 'milestone:m-verdict', kind: 'result', summary: 'VERDICT: PASS — 回归风险集中在 legacy 订单迁移, 已补 2 个用例', author: 'Reviewer', ts: Date.now() + 7800 } });
  push(8200, { type: 'team_lane_update', teamId, laneId: LANE_REVIEW, status: 'done', currentAction: '验收通过', progress: { toolCount: 8, changedFiles: 2 } });
  push(9000, {
    type: 'team_run_complete',
    teamId,
    status: 'success',
    report: '重构完成: 计费引擎拆分为 usage/subscription 两轴, 折扣规则独立 policy 层。\nReviewer 交叉验收 PASS; legacy 订单迁移补了 2 个回归用例。',
    laneSummaries: [
      { laneId: LANE_PLAN, role: 'planner', status: 'done', changedFiles: 1 },
      { laneId: LANE_IMPL, role: 'implementer', status: 'done', branch: 'team/billing-impl', changedFiles: 21 },
      { laneId: LANE_REVIEW, role: 'reviewer', status: 'done', changedFiles: 2 },
    ],
    timestamp: Date.now() + 9000,
  });

  const cancel = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    if (activeMockCancel === cancel) activeMockCancel = null;
  };
  activeMockCancel = cancel;
  return cancel;
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __neoxMockTeamRun?: typeof mockTeamRun }).__neoxMockTeamRun = mockTeamRun;
}
