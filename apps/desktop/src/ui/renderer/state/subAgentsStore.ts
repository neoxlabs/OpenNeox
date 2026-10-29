/**
 * subAgentsStore — 订阅 server 的 sub_agent SSE 事件, 维护 per-session 活跃的
 * 后台 sub-agent 清单. 跟 backgroundTasksStore 平行 — 这边是 dispatch 出去的
 * LLM 子 agent (BackgroundAgentManager), 那边是 shell 后台进程 (processManager).
 *
 * 事件 shape (来自 server/main.ts onBackgroundAgentLifecycle):
 *   { type:'sub_agent', action:'started'|'updated'|'done'|'aborted',
 *     agentId, name, description, status, elapsed, toolUseCount, timestamp }
 *
 * 设计:
 *  · running 一直显, done/aborted 6s 自动淡出 (用户已经在 timeline 看到完成卡)
 *  · sub-agent LLM loop 无 SIGTSTP 概念 — 只有 abort, 没有 pause/resume
 *  · 跨 session 隔离 — UI bar 按 sessionId 过滤
 */
import { useSyncExternalStore } from 'react';
import { noteStreamDrop } from './streamDropLedger';

export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface SubAgent {
  agentId: string;
  name?: string;
  description: string;
  status: SubAgentStatus;
  startedAtMs: number;
  elapsedSeconds: number;
  toolUseCount: number;
  /** 子 agent 已产出 tokens (lifecycle updated 事件带上来, 状态条并入显示) */
  outputTokens: number;
  model?: string;
  modelInherited?: boolean;
  fadeAtMs?: number;
}

const FADE_OUT_AFTER_MS_OK = 5000;
const FADE_OUT_AFTER_MS_BAD = 10000;
function fadeMsForStatus(s: SubAgentStatus): number {
  return s === 'completed' ? FADE_OUT_AFTER_MS_OK : FADE_OUT_AFTER_MS_BAD;
}

const agentsBySession = new Map<string, Map<string, SubAgent>>();
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const cachedArrayBySession = new Map<string, SubAgent[]>();

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[subAgentsStore]', err); }
  }
}

function rebuildArrayCache(sessionId: string): void {
  const map = agentsBySession.get(sessionId);
  if (!map || map.size === 0) {
    cachedArrayBySession.delete(sessionId);
    return;
  }
  const arr = Array.from(map.values()).sort((a, b) => a.startedAtMs - b.startedAtMs);
  cachedArrayBySession.set(sessionId, arr);
}

function scheduleFade(sessionId: string, agentId: string): void {
  const existing = fadeTimers.get(agentId);
  if (existing) clearTimeout(existing);
  const map = agentsBySession.get(sessionId);
  const a = map?.get(agentId);
  if (!a) return;
  const fadeMs = fadeMsForStatus(a.status);
  a.fadeAtMs = Date.now() + fadeMs;
  rebuildArrayCache(sessionId);
  emit();
  fadeTimers.set(agentId, setTimeout(() => {
    fadeTimers.delete(agentId);
    const m2 = agentsBySession.get(sessionId);
    if (!m2) return;
    m2.delete(agentId);
    if (m2.size === 0) agentsBySession.delete(sessionId);
    rebuildArrayCache(sessionId);
    rebuildRunningIds();
    emit();
  }, fadeMs));
}

function normalizeStatus(s: string | undefined): SubAgentStatus {
  if (s === 'running' || s === 'completed' || s === 'failed' || s === 'aborted') return s;
  if (s === 'done') return 'completed';
  return 'running';
}

export interface SubAgentEventPayload {
  action: 'started' | 'updated' | 'done' | 'aborted';
  agentId: string;
  name?: string;
  description?: string;
  status?: string;
  elapsed?: number;
  toolUseCount?: number;
  outputTokens?: number;
  model?: string;
  modelInherited?: boolean;
}

export function ingestSubAgentEvent(sessionId: string, payload: SubAgentEventPayload): void {
  if (!sessionId || !payload?.agentId) return;
  let map = agentsBySession.get(sessionId);
  if (!map) { map = new Map(); agentsBySession.set(sessionId, map); }

  if (payload.action === 'started') {
    map.set(payload.agentId, {
      agentId: payload.agentId,
      name: payload.name,
      description: String(payload.description ?? ''),
      status: 'running',
      startedAtMs: Date.now(),
      elapsedSeconds: 0,
      toolUseCount: 0,
      outputTokens: 0,
      model: payload.model,
      modelInherited: payload.modelInherited,
    });
    rebuildArrayCache(sessionId);
    rebuildRunningIds();
    emit();
    return;
  }

  const cur = map.get(payload.agentId);
  if (!cur) {
    /* 没拿到 started (UI 后 mount 或 SSE 漏了一帧) — 兜底建一条 */
    map.set(payload.agentId, {
      agentId: payload.agentId,
      name: payload.name,
      description: String(payload.description ?? ''),
      status: normalizeStatus(payload.status),
      startedAtMs: Date.now() - (Number(payload.elapsed) || 0) * 1000,
      elapsedSeconds: Number(payload.elapsed) || 0,
      toolUseCount: Number(payload.toolUseCount) || 0,
      outputTokens: Number(payload.outputTokens) || 0,
      model: payload.model,
      modelInherited: payload.modelInherited,
    });
    rebuildArrayCache(sessionId);
    rebuildRunningIds();
    emit();
    const finalStatus = normalizeStatus(payload.status);
    if (finalStatus !== 'running') scheduleFade(sessionId, payload.agentId);
    return;
  }

  let changed = false;
  if (typeof payload.elapsed === 'number' && payload.elapsed !== cur.elapsedSeconds) {
    cur.elapsedSeconds = payload.elapsed;
    changed = true;
  }
  if (typeof payload.toolUseCount === 'number' && payload.toolUseCount !== cur.toolUseCount) {
    cur.toolUseCount = payload.toolUseCount;
    changed = true;
  }
  if (typeof payload.outputTokens === 'number' && payload.outputTokens !== cur.outputTokens) {
    cur.outputTokens = payload.outputTokens;
    changed = true;
  }
  if (payload.name && payload.name !== cur.name) {
    cur.name = payload.name;
    changed = true;
  }
  if (payload.description && payload.description !== cur.description) {
    cur.description = payload.description;
    changed = true;
  }
  /* 模型在 started 就定了、之后不会变, 但 started 帧可能丢 (UI 后 mount / SSE 漏帧) —
   * 后续帧带到就补上, 不覆盖已有值。 */
  if (payload.model && payload.model !== cur.model) {
    cur.model = payload.model;
    cur.modelInherited = payload.modelInherited;
    changed = true;
  }
  const nextStatus = payload.action === 'done'
    ? (payload.status === 'failed' || payload.status === 'aborted' ? payload.status : 'completed')
    : payload.action === 'aborted' ? 'aborted'
    : normalizeStatus(payload.status);
  if (nextStatus !== cur.status) {
    cur.status = nextStatus;
    changed = true;
  }
  if (changed) {
    rebuildArrayCache(sessionId);
    rebuildRunningIds();
    emit();
    if (cur.status !== 'running') scheduleFade(sessionId, cur.agentId);
  }
}

export async function abortSubAgent(agentId: string): Promise<void> {
  const fn = (window as any)?.neox?.abortSubAgent;
  if (typeof fn !== 'function') {
    console.warn('[subAgentsStore] abortSubAgent IPC unavailable');
    return;
  }
  try { await fn(agentId); } catch (err) {
    console.error('[subAgentsStore] abort failed', err);
  }
}

/** 启动时 / 切 session 时拉一次, 不依赖 SSE 漏掉的事件 */
export async function refreshSubAgents(sessionId: string): Promise<void> {
  const fn = (window as any)?.neox?.listSubAgents;
  if (typeof fn !== 'function') return;
  try {
    const list = await fn(sessionId);
    if (!Array.isArray(list)) return;
    let map = agentsBySession.get(sessionId);
    if (!map) { map = new Map(); agentsBySession.set(sessionId, map); }
    const liveIds = new Set(list.map((info: any) => info?.agentId).filter(Boolean));
    for (const a of map.values()) {
      if (a.status === 'running' && !liveIds.has(a.agentId)) {
        noteStreamDrop('subagent-reconciled-away', { type: 'sub_agent', sessionId }, `${a.agentId} ${a.description.slice(0, 40)}`);
        a.status = 'aborted';
        scheduleFade(sessionId, a.agentId);
      }
    }
    for (const info of list) {
      if (!info?.agentId) continue;
      if (!map.has(info.agentId)) {
        map.set(info.agentId, {
          agentId: info.agentId,
          name: info.name,
          description: String(info.description ?? ''),
          status: normalizeStatus(info.status),
          startedAtMs: Date.now() - (Number(info.elapsed) || 0) * 1000,
          elapsedSeconds: Number(info.elapsed) || 0,
          toolUseCount: Number(info.toolUseCount) || 0,
          outputTokens: Number((info as any).outputTokens) || 0,
        });
      }
    }
    rebuildArrayCache(sessionId);
    rebuildRunningIds();
    emit();
  } catch (err) {
    console.warn('[subAgentsStore] refresh failed', err);
  }
}

/* ============================================================
 * 全局"运行中子 agent id"集合 — agentId 即子会话 id, Sidebar 用它给子会话行转圈。
 * useSyncExternalStore 契约: 快照必须稳定引用, 只有成员真变才换新 Set。
 * ============================================================ */
let runningIdsSnapshot: ReadonlySet<string> = new Set();

function rebuildRunningIds(): void {
  const next = new Set<string>();
  for (const map of agentsBySession.values()) {
    for (const a of map.values()) {
      if (a.status === 'running') next.add(a.agentId);
    }
  }
  if (next.size === runningIdsSnapshot.size && [...next].every((id) => runningIdsSnapshot.has(id))) {
    return; // 成员没变, 保持旧引用
  }
  runningIdsSnapshot = next;
}

/** 本地还挂着 running 子 agent 的会话 —— 对账轮询只查这些, 没有在跑的就一次 IPC 都不发 */
export function sessionsWithRunningSubAgents(): string[] {
  const out: string[] = [];
  for (const [sid, map] of agentsBySession) {
    for (const a of map.values()) {
      if (a.status === 'running') { out.push(sid); break; }
    }
  }
  return out;
}

export function useRunningSubAgentIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => runningIdsSnapshot, () => runningIdsSnapshot);
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

const EMPTY_ARR: SubAgent[] = [];

export function useSubAgents(sessionId: string | null | undefined): SubAgent[] {
  const sid = sessionId ?? '';
  const getSnapshot = (): SubAgent[] => {
    if (!sid) return EMPTY_ARR;
    return cachedArrayBySession.get(sid) ?? EMPTY_ARR;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ARR);
}

export function _resetSubAgentsStoreForTest(): void {
  for (const t of fadeTimers.values()) clearTimeout(t);
  fadeTimers.clear();
  agentsBySession.clear();
  cachedArrayBySession.clear();
  runningIdsSnapshot = new Set();
  listeners.clear();
}
