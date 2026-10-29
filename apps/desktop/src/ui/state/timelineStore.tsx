import { useCallback, useRef, useState, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { TimelineEntry } from '../renderer/utils/workspaceUtils';
import { compareTimelineEntries } from '../renderer/utils/workspaceUtils';
import * as timelineDB from '../renderer/services/timelineDB';
import { refreshTargetIndicatorFromEntries } from '../renderer/modules/agent-timeline/targetIndicatorStore';
import { registerTimelineTestHooks } from '../renderer/modules/agent-timeline/devTimelineTestHooks';
import { isAnomalyEntry } from '../renderer/modules/agent-timeline/turnAnomaly';
import { placeBackfilledEntries } from './placeBackfilledEntries';

export const MAX_INMEMORY_ENTRIES = 20000;

export const INITIAL_LOAD_LIMIT = 400;
/* 用户滚顶回捞历史后, 该 session 的内存上限抬到这个硬顶 (仍兜 OOM/掉帧);
 * 未展开的 session 仍用 MAX_INMEMORY_ENTRIES, 保持长跑流式的每帧 map 成本有界. */
export const HISTORY_EXPANDED_CEILING = MAX_INMEMORY_ENTRIES * 2;

// 标记哪些 session 已经从真源加载过
const loadedSessions = new Set<string>();

const externallyDirtySessions = new Set<string>();

// 待持久化的条目队列（批量写入优化）
const pendingWrites = new Map<string, TimelineEntry[]>();
let flushScheduled = false;
const deletedTombstones = new Map<string, Set<string>>();
const TOMBSTONE_CAP = 512;

function tombstone(sessionId: string, entryId: string): void {
  let set = deletedTombstones.get(sessionId);
  if (!set) { set = new Set(); deletedTombstones.set(sessionId, set); }
  set.add(entryId);
  if (set.size > TOMBSTONE_CAP) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

function dropTombstoned(sessionId: string, items: TimelineEntry[]): TimelineEntry[] {
  const set = deletedTombstones.get(sessionId);
  if (!set || set.size === 0) return items;
  return items.filter((e) => !set.has(e.id));
}

const clearGenerations = new Map<string, number>();
function clearGenerationOf(sessionId: string): number {
  return clearGenerations.get(sessionId) ?? 0;
}
function bumpClearGeneration(sessionId: string): void {
  clearGenerations.set(sessionId, clearGenerationOf(sessionId) + 1);
}

/** 撤掉待写队列里的同 id 条目并立墓碑 —— 每条删除路径都必须先走这里再动真源。 */
function dequeueWrite(sessionId: string, entryId: string): void {
  const existing = pendingWrites.get(sessionId);
  if (existing) {
    const next = existing.filter((e) => e.id !== entryId);
    if (next.length === 0) pendingWrites.delete(sessionId);
    else pendingWrites.set(sessionId, next);
  }
  tombstone(sessionId, entryId);
}
/* upsert 批失败的 per-session 连续失败计数 — 有界重试用 (见 doFlush) */
const flushRetryCounts = new Map<string, number>();
const FLUSH_RETRY_MAX = 5;
const FLUSH_RETRY_DELAY_MS = 2000;

/* ── SQLite 单真源接入层 ─────────────────────────────────────────── */

type TimelineIpc = {
  timelineUpsertBatch: (sessionId: string, entries: TimelineEntry[]) => Promise<{ ok: boolean; error?: string }>;
  timelinePage: (sessionId: string, opts?: { limit?: number; beforeRowId?: number }) => Promise<{
    ok: boolean; entries: TimelineEntry[]; oldestRowId: number | null; total: number; error?: string;
  }>;
  timelineDeleteEntry: (sessionId: string, entryId: string) => Promise<{ ok: boolean }>;
  timelineClear: (sessionId: string) => Promise<{ ok: boolean }>;
  timelineMigrationState: (op: 'get' | 'set', key: string) => Promise<{ ok: boolean; value?: string | null }>;
  onTimelineChanged?: (cb: (p: { sessionId: string }) => void) => () => void;
};

/** SQLite timeline IPC 可用性探测 — vitest / 老 preload 环境回落 IndexedDB。 */
function sqliteTimeline(): TimelineIpc | null {
  try {
    const api = typeof window !== 'undefined' ? (window as any).neox : null;
    if (api?.timelineUpsertBatch && api?.timelinePage) return api as TimelineIpc;
  } catch { /* noop */ }
  return null;
}

/** 滚顶回捞的 rowid 锚点 (per-session, 首页加载时记录) */
const oldestRowIdBySession = new Map<string, number | null>();

/** IDB → SQLite 的 per-session 懒迁移 (幂等: 水位标记 + upsert 冲突覆盖)。
 *  中断安全: 没写水位就会整段重跑, upsert 幂等不产生重复行。 */
const migrationInFlight = new Map<string, Promise<void>>();
async function ensureSessionMigrated(sessionId: string): Promise<void> {
  const ipc = sqliteTimeline();
  if (!ipc) return;
  const existing = migrationInFlight.get(sessionId);
  if (existing) return existing;
  const task = (async () => {
    try {
      const key = `timeline_migrated:${sessionId}`;
      const state = await ipc.timelineMigrationState('get', key);
      if (state.ok && state.value) return; /* 已迁移 */
      /* 读 IDB 全量 (老会话可能几千条) → 分批 upsert。IDB 里没有该会话 = 新会话, 直接标记。 */
      const rows = await timelineDB.getEntriesBySession(sessionId).catch(() => [] as TimelineEntry[]);
      for (let i = 0; i < rows.length; i += 400) {
        const chunk = rows.slice(i, i + 400);
        const res = await ipc.timelineUpsertBatch(sessionId, chunk);
        if (!res.ok) throw new Error(res.error || 'upsert-batch failed');
      }
      await ipc.timelineMigrationState('set', key);
      if (rows.length > 0) {
        console.log(`[TimelineStore] migrated ${rows.length} entries → SQLite for session ${sessionId}`);
        try {
          const back = await ipc.timelinePage(sessionId, { limit: 1 });
          if (back?.ok && (back.entries?.length ?? 0) > 0) {
            await timelineDB.deleteSessionEntries(sessionId);
          } else {
            console.warn(`[TimelineStore] 回读校验没通过, 保留 IDB 原件 (session ${sessionId})`);
          }
        } catch (verifyErr) {
          console.warn('[TimelineStore] 迁移回读校验失败, 保留 IDB 原件:', verifyErr);
        }
      }
    } catch (err) {
      console.warn(`[TimelineStore] IDB→SQLite migration failed for ${sessionId} (will retry next open):`, err);
    } finally {
      migrationInFlight.delete(sessionId);
    }
  })();
  migrationInFlight.set(sessionId, task);
  return task;
}

/* 多窗口缓存一致性: 其它窗口写入同 session → 失效本地"已加载"标记, 下次打开重拉。
 * 活跃会话收不到广播 (主进程排除发起窗), 不会打断正在流式的会话。 */
let changedHooked = false;
function hookTimelineChanged(): void {
  if (changedHooked) return;
  const ipc = sqliteTimeline();
  if (!ipc?.onTimelineChanged) return;
  changedHooked = true;
  ipc.onTimelineChanged(({ sessionId }) => markTimelineExternallyDirty(sessionId));
}

/** 主进程替这个会话往真源里写了东西 (例: 云端 Pilot 补账本对话) —— 下次 initialize 重读真源, 不走缓存 */
export function markTimelineExternallyDirty(sessionId: string): void {
  loadedSessions.delete(sessionId);
  oldestRowIdBySession.delete(sessionId);
  externallyDirtySessions.add(sessionId);
}

const memorySequenceCounters = new Map<string, number>();
// 缓存每个 session 已扫描出的最大 sequence，避免 cache 命中时反复同步遍历整条 timeline。
const memorySequenceMaxCache = new Map<string, number>();

/**
 * 获取下一个内存序列号
 */
function maxSequenceOf(entries: readonly { sequence?: number }[]): number {
  let max = 0;
  for (const e of entries) {
    const v = e.sequence ?? 0;
    if (v > max) max = v;
  }
  return max;
}

function getNextMemorySequence(sessionId: string, existingEntries?: TimelineEntry[]): number {
  let counter = memorySequenceCounters.get(sessionId);

  /* Phase C · 抖动根治 — 长跑期间这个函数每 stream event 一调,
   *   高频 console.log 每秒几百次淹 DevTools console 导致 render 卡顿 (renderer 线程).
   *   改成 gate 在 window.__neoxDebugTimeline=true 才打, 默认 no-op. */
  const shouldLog = typeof window !== 'undefined' && (window as any).__neoxDebugTimeline === true;

  if (counter === undefined) {
    // 初始化：从现有条目中找到最大的 sequence
    if (existingEntries && existingEntries.length > 0) {
      const maxSeq = maxSequenceOf(existingEntries);
      counter = maxSeq;
      if (shouldLog) console.log(`[TimelineStore] Initialized sequence counter for session ${sessionId} from entries: ${counter}`);
    } else {
      counter = 0;
      if (shouldLog) console.log(`[TimelineStore] Initialized sequence counter for session ${sessionId} to 0 (no entries)`);
    }
  }

  counter++;
  memorySequenceCounters.set(sessionId, counter);
  if (shouldLog) console.log(`[TimelineStore] Next sequence for session ${sessionId}: ${counter}`);
  return counter;
}

/**
 * 重置内存序列号（当从 IndexedDB 加载时调用）
 */
function resetMemorySequence(sessionId: string, maxSequence: number): void {
  memorySequenceCounters.set(sessionId, maxSequence);
  memorySequenceMaxCache.set(sessionId, maxSequence);
}

function ensureMemorySequenceFromEntries(sessionId: string, entries: TimelineEntry[]): void {
  if (memorySequenceMaxCache.has(sessionId)) return;
  const maxSeq = maxSequenceOf(entries);
  resetMemorySequence(sessionId, maxSeq);
}

function requeueFailedWrites(sessionId: string, failedItems: TimelineEntry[]): void {
  const attempts = (flushRetryCounts.get(sessionId) ?? 0) + 1;
  flushRetryCounts.set(sessionId, attempts);
  if (attempts > FLUSH_RETRY_MAX) {
    console.error(`[TimelineStore] dropping ${failedItems.length} entries for ${sessionId} after ${FLUSH_RETRY_MAX} failed flushes`);
    return;
  }
  const current = pendingWrites.get(sessionId) || [];
  const currentIds = new Set(current.map((e) => e.id));
  const stale = dropTombstoned(sessionId, failedItems).filter((e) => !currentIds.has(e.id));
  if (stale.length > 0 || current.length > 0) {
    pendingWrites.set(sessionId, [...stale, ...current]);
  }
  setTimeout(() => scheduleFlush(), FLUSH_RETRY_DELAY_MS * attempts);
}

/**
 * 调度批量写入 IndexedDB
 * 使用 requestIdleCallback 或 setTimeout 延迟写入，避免阻塞 UI
 */
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  const doFlush = async () => {
    flushScheduled = false;
    const entries = new Map(pendingWrites);
    pendingWrites.clear();

    const ipc = sqliteTimeline();
    for (const [sessionId, items] of entries) {
      /* 拍下这个会话当前的"代"。下面每批发送前都要比一次 —— 中途被清空的话,
       * 手里这批描述的是一个已经不存在的过去, 写回去就是让旧记录复活。 */
      const gen = clearGenerationOf(sessionId);
      try {
        if (ipc) {
          /* SQLite 真源: 整批一次 IPC (队列已按 id coalesce, 批量 ≤ 内存上限;
           * IPC 到达主进程即事务落盘 — 这是"退出丢写窗口≈0"的关键)。 */
          let failed = false;
          for (let i = 0; i < items.length; i += 400) {
            if (clearGenerationOf(sessionId) !== gen) { failed = true; break; }
            /* 每批发送前按墓碑筛: 上一批 await 期间发生的删除, 这里才追得上。 */
            const chunk = dropTombstoned(sessionId, items.slice(i, i + 400));
            if (chunk.length === 0) continue;
            const res = await ipc.timelineUpsertBatch(sessionId, chunk);
            if (!res.ok) {
              console.error('[TimelineStore] upsert-batch failed:', res.error);
              /* 被清空了就别重排队 —— 重排等于换个时机再复活一次 */
              if (clearGenerationOf(sessionId) === gen) requeueFailedWrites(sessionId, items.slice(i));
              failed = true;
              break;
            }
          }
          if (!failed) flushRetryCounts.delete(sessionId);
        } else {
          /* 回落 IndexedDB (vitest / 老 preload) — addEntry 按 (sessionId,id) 幂等 upsert */
          for (const entry of items) {
            if (clearGenerationOf(sessionId) !== gen) break;
            if (deletedTombstones.get(sessionId)?.has(entry.id)) continue;
            await timelineDB.addEntry(sessionId, entry);
          }
        }
      } catch (error) {
        console.error('[TimelineStore] Failed to persist entries:', error);
        if (clearGenerationOf(sessionId) === gen) requeueFailedWrites(sessionId, items);
      }
    }
  };

  // 优先使用 requestIdleCallback，否则使用 setTimeout
  // timeout: 1000 同时是硬上限 — 长期不 idle (持续流式渲染) 时 1s 内也会强制落盘,
  // 配合下方 pagehide/visibilitychange 兜底, 把退出丢数据的窗口压到最小。
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(doFlush, { timeout: 1000 });
  } else {
    setTimeout(doFlush, 100);
  }
}

/**
 * 将条目加入待写入队列
 */
function queueWrite(sessionId: string, entry: TimelineEntry) {
  if (isAnomalyEntry(entry)) return;
  /* 同 id 重新写入 = 拔碑: 错误卡 id 按轮稳定, 重试再失败会合法地复活同一个 id。 */
  deletedTombstones.get(sessionId)?.delete(entry.id);
  const existing = pendingWrites.get(sessionId) || [];
  // 检查是否已有相同 id 的条目在队列中，如有则替换
  const idx = existing.findIndex(e => e.id === entry.id);
  if (idx !== -1) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }
  pendingWrites.set(sessionId, existing);
  scheduleFlush();
}

/**
 * 从 IndexedDB 加载 session 的 timeline
 * @param forceReload 是否强制重新加载（忽略缓存标记）
 */
export async function loadTimelineFromDB(sessionId: string, forceReload = false): Promise<TimelineEntry[]> {
  if (!forceReload && loadedSessions.has(sessionId)) {
    // 已加载过，返回空（调用者应从内存缓存获取）
    return [];
  }

  const ipc = sqliteTimeline();
  if (ipc) {
    try {
      hookTimelineChanged();
      const t0 = performance.now();
      /* 懒迁移: 该会话的 IDB 存量先搬进 SQLite (幂等, 有水位秒过), 再从 SQLite 读 */
      await ensureSessionMigrated(sessionId);
      const tMigrate = performance.now();
      const page = await ipc.timelinePage(sessionId, { limit: INITIAL_LOAD_LIMIT });
      const tPage = performance.now();
      if (page.ok) {
        loadedSessions.add(sessionId);
        oldestRowIdBySession.set(sessionId, page.oldestRowId);
        const cost = `migrate ${Math.round(tMigrate - t0)}ms · page ${Math.round(tPage - tMigrate)}ms`;
        if (page.total > page.entries.length) {
          console.log(`[TimelineStore] Loaded ${page.entries.length}/${page.total} entries from SQLite for session ${sessionId} (older lazy-loaded) · ${cost}`);
        } else {
          console.log(`[TimelineStore] Loaded ${page.entries.length} entries from SQLite for session ${sessionId} · ${cost}`);
        }
        return placeBackfilledEntries(page.entries);
      }
      console.error('[TimelineStore] timelinePage failed, falling back to IndexedDB:', page.error);
    } catch (error) {
      console.error('[TimelineStore] SQLite load failed, falling back to IndexedDB:', error);
    }
  }

  try {
    /* 回落路径 (vitest / 老 preload / SQLite 读失败): 旧 IndexedDB 分页语义 */
    const { entries, total } = await timelineDB.getEntriesPaginated(sessionId, INITIAL_LOAD_LIMIT, 0);
    loadedSessions.add(sessionId);
    if (total > entries.length) {
      console.log(`[TimelineStore] Loaded ${entries.length}/${total} entries from IndexedDB for session ${sessionId} (older entries lazy-loaded)`);
    } else {
      console.log(`[TimelineStore] Loaded ${entries.length} entries from IndexedDB for session ${sessionId}`);
    }
    return entries;
  } catch (error) {
    console.error('[TimelineStore] Failed to load from IndexedDB:', error);
    return [];
  }
}

/**
 * Phase D · 滚到顶部时按需 load 更早的 entries. 从当前内存里最老的一条往前拉一批,
 *   拿到后 caller (timelineStore.applyTimelineUpdate) 负责 prepend 到内存 & 保持 MAX 上限.
 *   返回空数组表示已经到最早了.
 */
export async function loadOlderTimelineEntries(
  sessionId: string,
  currentOldestSequence: number | null,
  batchSize: number = INITIAL_LOAD_LIMIT,
): Promise<TimelineEntry[]> {
  const ipc = sqliteTimeline();
  if (ipc) {
    try {
      /* SQLite 路径: 锚点用首页加载时记录的 rowid (不依赖 entry.sequence —
       * 老数据 sequence 语义混杂, rowid 才是表内稳定序)。锚点缺失 = 首页没
       * 加载过, 取最新一页。 */
      const anchor = oldestRowIdBySession.get(sessionId);
      const page = await ipc.timelinePage(sessionId, {
        limit: batchSize,
        beforeRowId: typeof anchor === 'number' ? anchor : undefined,
      });
      if (page.ok) {
        if (page.entries.length > 0) {
          oldestRowIdBySession.set(sessionId, page.oldestRowId);
        }
        return page.entries;
      }
      console.error('[TimelineStore] older page failed:', page.error);
      return [];
    } catch (error) {
      console.error('[TimelineStore] Failed to load older entries from SQLite:', error);
      return [];
    }
  }
  try {
    if (currentOldestSequence == null) {
      const { entries } = await timelineDB.getEntriesPaginated(sessionId, batchSize, 0);
      return entries;
    }
    return timelineDB.getEntriesBeforeSequence(sessionId, currentOldestSequence, batchSize);
  } catch (error) {
    console.error('[TimelineStore] Failed to load older entries:', error);
    return [];
  }
}

function timelineEntryLooksLive(entry: TimelineEntry): boolean {
  const e = entry as any;
  return (
    entry.pending === true || e.editStreaming === true || e.streaming === true ||
    e.commandStatus === 'running' ||
    e.exploreStatus === 'running' || e.delegationStatus === 'running' ||
    e.askUserStatus === 'waiting' ||
    e.compactionStatus === 'started' || e.compactionStatus === 'compressing' ||
    e.awaitingApproval === true
  );
}

function timelineSessionLooksLive(sid: string, entries: TimelineEntry[] | undefined): boolean {
  if ((pendingWrites.get(sid)?.length ?? 0) > 0) return true;
  if (!entries || entries.length === 0) return false;
  const start = Math.max(0, entries.length - 80);
  for (let i = entries.length - 1; i >= start; i--) {
    if (timelineEntryLooksLive(entries[i]!)) return true;
  }
  return false;
}

function settleLoadedEntry(entry: TimelineEntry): TimelineEntry | null {
  const e = entry as any;
  const runningCommand = e.commandStatus === 'running';
  const runningExplore = e.exploreStatus === 'running' || e.delegationStatus === 'running';
  const waitingAsk = e.askUserStatus === 'waiting';
  const compacting = e.compactionStatus === 'started' || e.compactionStatus === 'compressing';
  if (!timelineEntryLooksLive(entry)) return null;

  const next: any = { ...entry, pending: false };
  if (e.editStreaming === true) next.editStreaming = false;
  if (e.streaming === true) next.streaming = undefined; /* tool_call_delta 占位卡的流式标 */
  if (entry.type === 'edit_file') next.editIsComplete = true;
  if (e.awaitingApproval === true) next.awaitingApproval = false;
  if (runningCommand) next.commandStatus = 'completed';
  if (e.exploreStatus === 'running') next.exploreStatus = 'completed';
  if (e.delegationStatus === 'running') next.delegationStatus = 'completed';
  if (waitingAsk) next.askUserStatus = 'timeout';
  /* compactionStatus started/compressing 是 TimelineComposer 判"压缩中"的独立信号
   * (不看 pending), 残留会让 composer 一直显示"压缩上下文中" — 一并收敛。 */
  if (e.compactionStatus === 'started' || e.compactionStatus === 'compressing') {
    next.compactionStatus = 'skipped';
  }
  if (entry.type === 'tool_call') {
    /* 孤儿 write_file 空壳 (无 filePath/内容) 不能伪装成功 — 会渲染成 "Untitled file"
     * WRITE 卡 (run_result janitor 同款守卫), 降级 tool_error。 */
    const isOrphanWriteShell =
      e.toolName === 'write_file' && !e.filePath && !e.targetPath && !e.codeContent &&
      !(Array.isArray(e.codeLines) && e.codeLines.length > 0);
    if (isOrphanWriteShell) {
      next.type = 'tool_error';
      next.success = false;
      next.level = 'error';
    } else {
      /* 对齐 run_result janitor: 孤儿 tool_call 收敛成 tool_result, 不再画转圈 */
      next.type = 'tool_result';
      next.success = entry.success ?? true;
    }
  }
  if (entry.type === 'edit_file' || entry.type === 'file_stream') {
    next.success = entry.success ?? true;
  }
  return next as TimelineEntry;
}

/** 对一页真源数据做加载期收敛; 收敛过的行回写真源, 让状态跨重启收口。 */
function settleLoadedEntries(sessionId: string, entries: TimelineEntry[]): TimelineEntry[] {
  /* 老会话里可能还躺着以前落盘的异常态 —— 读回来时一并丢掉, 别让历史留着旧红卡
   * (新写入那侧已经在 queueWrite 里挡住了)。 */
  const kept = entries.some(isAnomalyEntry) ? entries.filter((e) => !isAnomalyEntry(e)) : entries;
  let changed = kept !== entries;
  const result = kept.map((entry) => {
    const settled = settleLoadedEntry(entry);
    if (!settled) return entry;
    changed = true;
    queueWrite(sessionId, settled);
    return settled;
  });
  return changed ? result : kept;
}

function summarizeTimelineEntry(entry: TimelineEntry) {
  const detail =
    typeof entry.detail === 'string'
      ? entry.detail
      : typeof (entry as any).content === 'string'
        ? (entry as any).content
        : typeof entry.errorMessage === 'string'
          ? entry.errorMessage
          : '';
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    pending: entry.pending,
    level: entry.level,
    toolName: entry.toolName,
    toolCallId: (entry as any).toolCallId,
    targetPath: entry.targetPath || entry.editFilePath || (entry as any).filePath,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    detail: detail.length > 240 ? `${detail.slice(0, 240)}...` : detail,
  };
}

/**
 * 迁移旧数据到 IndexedDB
 */
export async function migrateOldTimeline(
  sessionId: string,
  oldTimeline: TimelineEntry[] | undefined
): Promise<boolean> {
  if (!oldTimeline || oldTimeline.length === 0) {
    return false;
  }

  try {
    const migrated = await timelineDB.migrateFromSessionTimeline(sessionId, oldTimeline);
    if (migrated) {
      loadedSessions.add(sessionId);
    }
    return migrated;
  } catch (error) {
    console.error('[TimelineStore] Migration failed:', error);
    return false;
  }
}

/**
 * 清除 session 的 timeline 数据
 */
export async function clearSessionTimeline(sessionId: string): Promise<void> {
  bumpClearGeneration(sessionId);
  try {
    /* 真源 (SQLite) 直清 + 旧 IDB 残留一并清 (防迁移期"复活") */
    const ipc = sqliteTimeline();
    if (ipc) {
      await ipc.timelineClear(sessionId).catch(() => { /* 回落下方 IDB 清理 */ });
    }
    await timelineDB.deleteSessionEntries(sessionId);
    loadedSessions.delete(sessionId);
    oldestRowIdBySession.delete(sessionId);
    externallyDirtySessions.delete(sessionId);
    flushRetryCounts.delete(sessionId);
    // 清除待写入队列
    pendingWrites.delete(sessionId);
    deletedTombstones.delete(sessionId);
    memorySequenceMaxCache.delete(sessionId);
  } catch (error) {
    console.error('[TimelineStore] Failed to clear session timeline:', error);
  }
}

/**
 * 强制刷新待写入队列（用于 session 结束时确保数据持久化）
 */
export async function flushPendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;

  const entries = new Map(pendingWrites);
  pendingWrites.clear();
  flushScheduled = false;

  const ipc = sqliteTimeline();
  for (const [sessionId, items] of entries) {
    /* 同 doFlush: 飞行途中被清空就整段丢弃, 见 clearGenerations */
    const gen = clearGenerationOf(sessionId);
    try {
      if (ipc) {
        for (let i = 0; i < items.length; i += 400) {
          if (clearGenerationOf(sessionId) !== gen) break;
          const chunk = dropTombstoned(sessionId, items.slice(i, i + 400));
          if (chunk.length === 0) continue;
          const res = await ipc.timelineUpsertBatch(sessionId, chunk);
          if (!res.ok) {
            /* 切后台触发的 flush 失败也走重试队列 — 窗口没关的话还有机会补写 */
            console.error('[TimelineStore] flush upsert-batch failed:', res.error);
            if (clearGenerationOf(sessionId) === gen) requeueFailedWrites(sessionId, items.slice(i));
            break;
          }
        }
      } else {
        for (const entry of items) {
          if (clearGenerationOf(sessionId) !== gen) break;
          if (deletedTombstones.get(sessionId)?.has(entry.id)) continue;
          await timelineDB.addEntry(sessionId, entry);
        }
      }
    } catch (error) {
      console.error('[TimelineStore] Flush write failed:', error);
      if (clearGenerationOf(sessionId) === gen) requeueFailedWrites(sessionId, items);
    }
  }
}

let exitFlushHooked = false;
function hookExitFlush(): void {
  if (exitFlushHooked || typeof window === 'undefined') return;
  exitFlushHooked = true;
  window.addEventListener('pagehide', () => { void flushPendingWrites(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPendingWrites();
  });
}
hookExitFlush();

export const useTimelineStore = (activeSessionIdRef: MutableRefObject<string | null>) => {
  const [timelineEvents, setTimelineEvents] = useState<TimelineEntry[]>([]);
  const timelineEventsRef = useRef<TimelineEntry[]>(timelineEvents);
  const timelineMapRef = useRef<Map<string, TimelineEntry[]>>(new Map());
  /* 记录哪些 session 用户已滚顶回捞过历史 — 决定 applyTimelineUpdate 用哪档内存上限. */
  const historyExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => { timelineEventsRef.current = timelineEvents; }, [timelineEvents]);

  const sessionLruRef = useRef<string[]>([]);
  const evictColdTimelineCaches = useCallback((activeSid: string) => {
    const KEEP_WARM = 6;
    const lru = sessionLruRef.current;
    const i = lru.indexOf(activeSid);
    if (i >= 0) lru.splice(i, 1);
    lru.push(activeSid);
    if (lru.length > 64) lru.splice(0, lru.length - 64); /* LRU 本身也别无限长 */
    if (timelineMapRef.current.size <= KEEP_WARM) return;
    const keep = new Set(lru.slice(-KEEP_WARM));
    for (const sid of Array.from(timelineMapRef.current.keys())) {
      if (keep.has(sid)) continue;
      if (timelineSessionLooksLive(sid, timelineMapRef.current.get(sid))) continue;
      timelineMapRef.current.delete(sid);
      loadedSessions.delete(sid);
      oldestRowIdBySession.delete(sid);
      historyExpandedRef.current.delete(sid);
      externallyDirtySessions.add(sid);
    }
  }, []);

  /* DevTools 诊断 helper — DevTools Console 跑:
   *   window.__neoxDump()                                 // 当前 active session 的所有 entries
   *   window.__neoxDump().filter(e => e.type === 'edit_file')  // 只看 edit_file
   *   window.__neoxDump().filter(e => e.type === 'edit_file').map(e => ({
   *     id: e.id, success: e.success, level: e.level, pending: e.pending,
   *     editIsComplete: e.editIsComplete, errorMessage: e.errorMessage,
   *     errorCode: e.errorCode, toolCallIdSet: e.toolCallIdSet
   *   }))                                                 // 关键状态字段
   * 用户报 "edit 工具成功但 UI 显失败" 时一眼看清是哪个字段被错标. */
  if (typeof window !== 'undefined') {
    (window as any).__neoxDump = (sessionId?: string): TimelineEntry[] => {
      const sid = sessionId || activeSessionIdRef.current;
      if (!sid) return [];
      return timelineMapRef.current.get(sid) ?? [];
    };
    (window as any).__neoxTimelineSnapshot = async (sessionId?: string, tail = 40) => {
      const sid = sessionId || activeSessionIdRef.current;
      if (!sid) return { error: 'no active session' };
      const safeTail = Math.max(1, Math.min(200, Math.floor(Number(tail) || 40)));
      await flushPendingWrites();
      const inMemory = timelineMapRef.current.get(sid) ?? [];
      const dbPage = await timelineDB.getEntriesPaginated(sid, safeTail, 0);
      return {
        activeSessionId: activeSessionIdRef.current,
        sessionId: sid,
        inMemoryCount: inMemory.length,
        dbCount: dbPage.total,
        pendingWriteCount: pendingWrites.get(sid)?.length ?? 0,
        inMemoryTail: inMemory.slice(-safeTail).map(summarizeTimelineEntry),
        dbTail: dbPage.entries.map(summarizeTimelineEntry),
      };
    };
    (window as any).__neoxFindTimelineText = async (text: string, limit = 50) => {
      await flushPendingWrites();
      const hits = await timelineDB.findEntriesContainingText(String(text || ''), limit);
      return hits.map((hit) => ({
        sessionId: hit.sessionId,
        entry: summarizeTimelineEntry(hit.entry),
      }));
    };
  }

  const applyTimelineUpdate = useCallback(
    (sessionId: string, updater: (prev: TimelineEntry[]) => TimelineEntry[], forceSync = false) => {
      const prev = timelineMapRef.current.get(sessionId) || [];
      let updated = updater(prev);
      if (updated === prev) return prev;
      /* Phase D · 长跑内存上限 — 超过上限时切掉最老的 head, 只保留 tail.
       *   被切掉的 entries 仍在 IndexedDB, 用户滚到顶时 prependOlderTimelineEntries 按需回捞.
       *   目的: 防长跑 (6h+) 内存里 timeline entries 累积到几千条卡帧甚至 OOM.
       *
       *   若用户已滚顶展开过历史 (historyExpandedRef), 抬高到 EXPANDED_CEILING, 否则刚回捞
       *   到内存头部的老历史会被这刀立刻切走 (回捞白做). 展开后仍有硬顶兜 OOM/掉帧. */
      const limit = historyExpandedRef.current.has(sessionId)
        ? HISTORY_EXPANDED_CEILING
        : MAX_INMEMORY_ENTRIES;
      if (updated.length > limit) {
        updated = updated.slice(updated.length - limit);
      }
      timelineMapRef.current.set(sessionId, updated);
      if (activeSessionIdRef.current === sessionId && timelineEventsRef.current !== updated) {
        timelineEventsRef.current = updated;
        void forceSync;
        setTimelineEvents(updated);
        /* Phase A 后 target 状态来自后端 IPC push, refreshTargetIndicatorFromEntries 已 no-op,
         *   保留调用只是为了万一某些老代码路径依赖 (Phase C 后可彻底删本行). */
        refreshTargetIndicatorFromEntries(updated);
      }
      return updated;
    },
    [activeSessionIdRef],
  );

  const appendTimelineEntry = useCallback(
    (sessionId: string | null | undefined, entry: TimelineEntry, forceSync = false) => {
      if (!sessionId) return entry;

      const prev = timelineMapRef.current.get(sessionId) || [];

      // 这样即使 IndexedDB 写入是异步的，内存中的顺序也是正确的
      const entryWithSequence: TimelineEntry = {
        ...entry,
        timestamp: entry.timestamp || Date.now(),
        sequence: entry.sequence ?? getNextMemorySequence(sessionId, prev),
      };

      let resultEntry = entryWithSequence;

      applyTimelineUpdate(sessionId, (prevEntries) => {
        // 检查是否已存在相同 id 的条目（避免重复）
        const existingIndex = prevEntries.findIndex(e => e.id === entryWithSequence.id);
        if (existingIndex !== -1) {
          // 更新已存在的条目，保留原有的 sequence
          const updated = {
            ...prevEntries[existingIndex],
            ...entryWithSequence,
            sequence: prevEntries[existingIndex].sequence, // 保留原 sequence
          };
          resultEntry = updated;
          const next = [...prevEntries];
          next[existingIndex] = updated;
          return next;
        }

        // 添加新条目到末尾
        resultEntry = entryWithSequence;
        return [...prevEntries, entryWithSequence];
      }, forceSync);

      // 异步写入 IndexedDB
      queueWrite(sessionId, resultEntry);

      return resultEntry;
    },
    [applyTimelineUpdate],
  );

  const updateTimelineEntry = useCallback(
    (
      sessionId: string | null | undefined,
      matcher: (entry: TimelineEntry, index: number, arr: TimelineEntry[]) => boolean,
      updater: ((entry: TimelineEntry) => TimelineEntry) | Partial<TimelineEntry>,
      forceSync = false,
    ) => {
      if (!sessionId) return;
      const entries = timelineMapRef.current.get(sessionId);
      if (!entries) return;
      const index = entries.findIndex((entry, idx, arr) => matcher(entry, idx, arr));
      if (index === -1) return;

      let updatedEntry: TimelineEntry;

      applyTimelineUpdate(
        sessionId,
        (prev) => {
          const next = [...prev];
          if (typeof updater === 'function') {
            updatedEntry = updater(next[index]);
          } else {
            updatedEntry = { ...next[index], ...updater };
          }
          next[index] = updatedEntry;
          return next;
        },
        forceSync,
      );

      // 异步更新 IndexedDB
      if (updatedEntry!) {
        queueWrite(sessionId, updatedEntry);
      }
    },
    [applyTimelineUpdate],
  );

  // 更新所有匹配的条目（用于批量更新多个 edit_file 等）
  const updateAllMatchingTimelineEntries = useCallback(
    (
      sessionId: string | null | undefined,
      matcher: (entry: TimelineEntry, index: number, arr: TimelineEntry[]) => boolean,
      updater: ((entry: TimelineEntry) => TimelineEntry) | Partial<TimelineEntry>,
      forceSync = false,
    ) => {
      if (!sessionId) return;
      const entries = timelineMapRef.current.get(sessionId);
      if (!entries) return;

      // 找到所有匹配的索引
      const matchingIndices: number[] = [];
      entries.forEach((entry, idx, arr) => {
        if (matcher(entry, idx, arr)) {
          matchingIndices.push(idx);
        }
      });

      if (matchingIndices.length === 0) return;

      const updatedEntries: TimelineEntry[] = [];

      applyTimelineUpdate(
        sessionId,
        (prev) => {
          const next = [...prev];
          for (const index of matchingIndices) {
            if (typeof updater === 'function') {
              next[index] = updater(next[index]);
            } else {
              next[index] = { ...next[index], ...updater };
            }
            updatedEntries.push(next[index]);
          }
          return next;
        },
        forceSync,
      );

      // 异步更新 IndexedDB
      for (const entry of updatedEntries) {
        queueWrite(sessionId, entry);
      }
    },
    [applyTimelineUpdate],
  );

  const updateTimelineEntryById = useCallback(
    (
      sessionId: string | null | undefined,
      entryId: string | undefined,
      updater: ((entry: TimelineEntry) => TimelineEntry) | Partial<TimelineEntry>,
      forceSync = false
    ) => {
      if (!entryId) return;
      updateTimelineEntry(sessionId, (entry) => entry.id === entryId, updater, forceSync);
    },
    [updateTimelineEntry],
  );

  /**
   * 从 IndexedDB 加载并初始化 session 的 timeline
   * 支持从旧的 session.timeline 迁移
   */
  const initializeSessionTimeline = useCallback(
    async (
      sessionId: string,
      oldTimeline?: TimelineEntry[],
      opts?: { settlePending?: boolean },
    ): Promise<TimelineEntry[]> => {
      /* 多窗口失效标记要在缓存短路之前生效 (见 externallyDirtySessions 注释) */
      hookTimelineChanged();
      evictColdTimelineCaches(sessionId);
      const externallyDirty = externallyDirtySessions.has(sessionId);
      const cachedEntries = timelineMapRef.current.get(sessionId);
      const hasSubRows = !!cachedEntries?.some((e) => String(e.id || '').startsWith('sub-'))
        || !!oldTimeline?.some((e) => String(e.id || '').startsWith('sub-'));
      const hasLiveStreamEntries = hasSubRows && !!cachedEntries?.some(
        (e) => e.id && !String(e.id).startsWith('sub-'),
      );
      if (cachedEntries && cachedEntries.length > 0 && hasLiveStreamEntries) {
        ensureMemorySequenceFromEntries(sessionId, cachedEntries);
        if (activeSessionIdRef.current === sessionId && timelineEventsRef.current !== cachedEntries) {
          timelineEventsRef.current = cachedEntries;
          setTimelineEvents(cachedEntries);
        }
        return cachedEntries;
      }
      const hasFreshSubEntries = !!oldTimeline?.some(
        (e) => String(e.id || '').startsWith('sub-') && !cachedEntries?.some((c) => c.id === e.id),
      );
      if (cachedEntries && cachedEntries.length > 0 && !hasFreshSubEntries && !externallyDirty) {
        // Phase C · 抖动根治 — 每次 timelineStore 更新触发 initialize 时都刷这行,
        //   长跑期间 stream event 打得快就 spam DevTools console → 主线程卡.
        if (typeof window !== 'undefined' && (window as any).__neoxDebugTimeline === true) {
          console.log(`[TimelineStore] Using cached timeline for session ${sessionId}: ${cachedEntries.length} entries`);
        }
        // cache 命中是热路径：不要每次都扫描 400+/1000+ 条 sequence，也不要重复 setState。
        ensureMemorySequenceFromEntries(sessionId, cachedEntries);
        if (activeSessionIdRef.current === sessionId && timelineEventsRef.current !== cachedEntries) {
          timelineEventsRef.current = cachedEntries;
          setTimelineEvents(cachedEntries);
        }
        return cachedEntries;
      }

      if (activeSessionIdRef.current === sessionId) {
        const placeholder = cachedEntries && cachedEntries.length === 0
          ? cachedEntries
          : (timelineMapRef.current.get(sessionId) ?? []);
        if (!timelineMapRef.current.has(sessionId)) {
          timelineMapRef.current.set(sessionId, placeholder);
        }
        if (timelineEventsRef.current !== placeholder) {
          timelineEventsRef.current = placeholder;
          setTimelineEvents(placeholder);
        }
      }

      const ipc = sqliteTimeline();
      if (ipc) {
        if (oldTimeline && oldTimeline.length > 0) {
          const gen = clearGenerationOf(sessionId);
          const seed = dropTombstoned(sessionId, oldTimeline);
          let seededAll = true;
          try {
            for (let i = 0; i < seed.length; i += 400) {
              if (clearGenerationOf(sessionId) !== gen) { seededAll = false; break; }
              await ipc.timelineUpsertBatch(sessionId, seed.slice(i, i + 400));
            }
          } catch (err) {
            seededAll = false;
            console.warn('[TimelineStore] seeding oldTimeline into SQLite failed:', err);
          }
          const isSubAgentTimeline = oldTimeline.some((e) => String(e.id || '').startsWith('sub-'));
          if (seededAll
            && !isSubAgentTimeline
            && clearGenerationOf(sessionId) === gen
            && window.neox?.clearSessionTimeline) {
            window.neox.clearSessionTimeline(sessionId).catch((error: Error) => {
              console.warn('[TimelineStore] Failed to clear legacy session.timeline:', error);
            });
          }
        }
      } else if (oldTimeline && oldTimeline.length > 0) {
        const migrated = await migrateOldTimeline(sessionId, oldTimeline);
        /* IDB 回落路径维持旧语义: 主会话迁移成功后清 server 侧旧 session.timeline 字段 */
        const isSubAgentTimeline = oldTimeline.some((e) => String(e.id || '').startsWith('sub-'));
        if (migrated && !isSubAgentTimeline && window.neox?.clearSessionTimeline) {
          window.neox.clearSessionTimeline(sessionId).catch((error: Error) => {
            console.warn('[TimelineStore] Failed to clear old session.timeline:', error);
          });
        }
      }

      // 从真源加载（强制重新加载以获取最新数据）
      let entries = await loadTimelineFromDB(sessionId, true);
      externallyDirtySessions.delete(sessionId);

      /* await 期间 stream handler 可能已往内存 append/update 了 entry (后台会话持续
       * 流式 / 首帧 user_message), 对应 upsert 可能还没 flush → 真源页读不到或读到旧版。
       * 直接 set(entries) 会把它们覆盖丢掉 (UI 少条目/状态回跳, 重启才回来)。
       * 合并规则: 真源页做底; 同 id 双源时仅当本窗还有该 id 的未落盘写 (pendingWrites)
       * 才用内存版覆盖 — 已落盘的以真源为准, 多窗口下才不会用本窗旧缓存盖掉他窗新写;
       * 内存里真源没有的 entry 按原顺序补到尾部。 */
      const concurrent = timelineMapRef.current.get(sessionId) || [];
      if (concurrent.length > 0) {
        const memoryById = new Map(concurrent.map((e) => [e.id, e]));
        const pendingIds = new Set((pendingWrites.get(sessionId) || []).map((e) => e.id));
        const loadedIds = new Set(entries.map((e) => e.id));
        if (pendingIds.size > 0) {
          entries = entries.map((e) => (pendingIds.has(e.id) ? memoryById.get(e.id) ?? e : e));
        }
        const extras = concurrent.filter((e) => !loadedIds.has(e.id));
        if (extras.length > 0) {
          /* 按 sequence/timestamp 归位, 禁止一律 append 到尾部 —
           * 否则未落盘的 user_message 会掉到已落盘的 runner_error 后面 (暂停/reload 乱序). */
          entries = [...entries, ...extras].sort(compareTimelineEntries);
        }
      }

      /* 加载期 pending 收敛 — 只在调用方确认该会话当前没有在跑时做 (在跑的会话
       * pending 是活状态, 不能收)。放在合并后: 会话已死时内存残留的 pending 同样要收。 */
      if (opts?.settlePending && entries.length > 0) {
        entries = settleLoadedEntries(sessionId, entries);
      }

      if (entries.length > 0) {
        const maxSeq = maxSequenceOf(entries);
        resetMemorySequence(sessionId, maxSeq);
        console.log(`[TimelineStore] Reset sequence counter for session ${sessionId} to ${maxSeq}`);
      }

      // 更新内存缓存
      timelineMapRef.current.set(sessionId, entries);

      // 如果是当前活动 session，更新 UI。相同引用不重复 setState，避免 React Scheduler message task 空转。
      if (activeSessionIdRef.current === sessionId && timelineEventsRef.current !== entries) {
        timelineEventsRef.current = entries;
        setTimelineEvents(entries);
      }

      return entries;
    },
    [activeSessionIdRef, evictColdTimelineCaches],
  );

  /**
   * 删除单个条目
   */
  const deleteTimelineEntry = useCallback(
    async (sessionId: string | null | undefined, entryId: string) => {
      if (!sessionId) return;

      // 从内存中删除
      applyTimelineUpdate(sessionId, (prev) => prev.filter(e => e.id !== entryId));
      /* 先撤待写队列 + 立墓碑, 再动真源 —— 否则 idle flush 会把这条又写回去 (见 deletedTombstones)。 */
      dequeueWrite(sessionId, entryId);

      // 从真源删除 (SQLite 优先, IDB 残留一并清)
      try {
        const ipc = sqliteTimeline();
        if (ipc) await ipc.timelineDeleteEntry(sessionId, entryId);
        await timelineDB.deleteEntry(sessionId, entryId);
      } catch (error) {
        console.error('[TimelineStore] Failed to delete entry:', error);
      }
    },
    [applyTimelineUpdate],
  );

  const truncateTimelineFrom = useCallback(
    async (sessionId: string | null | undefined, anchorEntryId: string): Promise<number> => {
      if (!sessionId) return -1;
      const prev = timelineMapRef.current.get(sessionId) || [];
      const idx = prev.findIndex(e => e?.id === anchorEntryId);
      if (idx < 0) return -1;
      const doomed = prev.slice(idx);

      applyTimelineUpdate(sessionId, (cur) => {
        const i = cur.findIndex(e => e?.id === anchorEntryId);
        return i < 0 ? cur : cur.slice(0, i);
      }, true);
      for (const e of doomed) {
        if (e?.id) dequeueWrite(sessionId, e.id);
      }

      try {
        const ipc = sqliteTimeline();
        if (ipc) {
          for (const e of doomed) {
            if (e?.id) await ipc.timelineDeleteEntry(sessionId, e.id);
          }
        }
        await timelineDB.deleteEntriesFrom(sessionId, anchorEntryId);
      } catch (error) {
        console.error('[TimelineStore] Failed to truncate timeline:', error);
      }
      return doomed.length;
    },
    [applyTimelineUpdate],
  );

  /**
   * 清空 session 的所有 timeline
   */
  const clearTimeline = useCallback(
    async (sessionId: string | null | undefined) => {
      if (!sessionId) return;

      // 清空内存
      timelineMapRef.current.set(sessionId, []);
      memorySequenceMaxCache.delete(sessionId);
      historyExpandedRef.current.delete(sessionId);
      if (activeSessionIdRef.current === sessionId && timelineEventsRef.current.length > 0) {
        timelineEventsRef.current = [];
        setTimelineEvents([]);
      }

      // 清空 IndexedDB
      await clearSessionTimeline(sessionId);
    },
    [activeSessionIdRef],
  );

  /**
   * 滚到顶时按需回捞更早的历史 — 从当前内存里最老一条的 sequence 往前拉一批, prepend 到内存头部.
   *   - 绕开 applyTimelineUpdate 的 tail-cap (那把刀保留最新, 会把刚 prepend 的老历史立刻切走);
   *   - 标记该 session 为 expanded, 让后续 applyTimelineUpdate 抬到 EXPANDED_CEILING, 老历史不被 live append 切掉;
   *   - 按 id 去重, 只 prepend 内存里还没有的;
   *   - reachedStart=true 表示 DB 里没有更早的了, UI 可停止继续拉.
   * 完整历史始终在 IndexedDB, 这里只是把可视窗口往前扩. 返回 loaded 供 UI 判断是否要保持滚动锚点.
   */
  const prependOlderTimelineEntries = useCallback(
    async (
      sessionId: string | null | undefined,
    ): Promise<{ loaded: number; reachedStart: boolean }> => {
      if (!sessionId) return { loaded: 0, reachedStart: true };
      const cur = timelineMapRef.current.get(sessionId) || [];
      if (cur.length >= HISTORY_EXPANDED_CEILING) {
        return { loaded: 0, reachedStart: true };
      }
      const oldestSeq = cur.length > 0 ? cur[0].sequence ?? null : null;
      // 没有 sequence 锚点无法按序回捞 (老迁移数据可能缺 sequence) — 视为已到最早.
      if (oldestSeq == null || oldestSeq <= 0) {
        return { loaded: 0, reachedStart: true };
      }
      const older = await loadOlderTimelineEntries(
        sessionId,
        oldestSeq,
        INITIAL_LOAD_LIMIT,
      );
      if (older.length === 0) return { loaded: 0, reachedStart: true };
      /* await 期间 streaming 可能又 append 了新 entry — 用最新的 tail 合并, 别拿 await 前的
       * 旧快照当 tail, 否则会把并发写进来的新 entry 覆盖丢掉. */
      const latest = timelineMapRef.current.get(sessionId) || cur;
      const latestIds = new Set(latest.map((e) => e.id));
      /* 回捞的是内存窗口之前的老历史, 不可能是在跑的活 entry (活的必在内存 tail 里被
       * latestIds 去重掉) — 残留 pending 无条件收敛, 老历史不再画"运行中"转圈。 */
      const fresh = settleLoadedEntries(
        sessionId,
        older.filter((e) => !latestIds.has(e.id)),
      );
      const reachedStart = older.length < INITIAL_LOAD_LIMIT;
      if (fresh.length === 0) return { loaded: 0, reachedStart };
      const merged = [...fresh, ...latest];
      historyExpandedRef.current.add(sessionId);
      timelineMapRef.current.set(sessionId, merged);
      if (
        activeSessionIdRef.current === sessionId &&
        timelineEventsRef.current !== merged
      ) {
        timelineEventsRef.current = merged;
        setTimelineEvents(merged);
      }
      return { loaded: fresh.length, reachedStart };
    },
    [activeSessionIdRef],
  );

  /* dev-only 抖动 harness 注入口 (scripts/timeline-jitter, npm run jitter)。
   * 生产构建里 registerTimelineTestHooks 整体被 vite 死代码消除。 */
  registerTimelineTestHooks({
    appendEntry: (sid, entry) => appendTimelineEntry(sid, entry),
    updateEntry: (sid, id, patch) =>
      updateTimelineEntryById(sid, id, (prev) => ({ ...prev, ...patch }) as TimelineEntry),
    getActiveSessionId: () => activeSessionIdRef.current,
  });

  return {
    timelineEvents,
    setTimelineEvents,
    timelineMapRef,
    appendTimelineEntry,
    updateTimelineEntry,
    updateAllMatchingTimelineEntries,
    updateTimelineEntryById,
    applyTimelineUpdate,
    // 新增的 IndexedDB 相关方法
    initializeSessionTimeline,
    deleteTimelineEntry,
    truncateTimelineFrom,
    clearTimeline,
    prependOlderTimelineEntries,
  };
};

/** 仅供 timelineStore.persist.test.ts —— 写队列/墓碑是模块私有状态, 测试环境没有 DOM
 *  渲染不了 hook, 只能从这里直接驱动。生产代码不许 import。 */
export const __persistTestSurface = {
  queueWrite, dequeueWrite, pendingWrites, deletedTombstones,
  clearGenerations, bumpClearGeneration,
};
