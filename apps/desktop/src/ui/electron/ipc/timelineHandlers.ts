
import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron, electronOrNull } from '../lazyElectron.js';
import type { IpcMainInvokeEvent } from 'electron';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败,
 * 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { glanceSession, outputsOf, type SessionGlance } from './sessionGlance.js';
import { statSync } from 'node:fs';

const glanceCache = new Map<string, { at: number; glance: SessionGlance }>();

/* 单次 batch 上限 — renderer 队列本身有 coalesce, 正常不会超; 防御异常调用打爆事务 */
const UPSERT_BATCH_MAX = 500;
/* 单条 entry JSON 防爆上限 — 超大 output/diff 字段截断打标, 防 WAL 膨胀与 IPC 克隆成本 */
const ENTRY_JSON_SOFT_MAX = 256 * 1024;
/* 迁移水位 key 前缀 — 只允许这个命名空间, 防 IPC 被当通用 app_state 读写口 */
const MIGRATION_KEY_PREFIX = 'timeline_migrated';

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw new Error('invalid sessionId');
  }
}

/** 超大 entry 的 output 类字段截断 (保留头部) — 设计文档 "字段膨胀" 风险对策 */
function clampOversizedEntry(entry: Record<string, unknown>): Record<string, unknown> {
  try {
    const raw = JSON.stringify(entry);
    if (raw.length <= ENTRY_JSON_SOFT_MAX) return entry;
    const clamped: Record<string, unknown> = { ...entry, __clamped: true };
    for (const key of ['output', 'commandRawOutput', 'commandResult', 'detail', 'content']) {
      const v = clamped[key];
      if (typeof v === 'string' && v.length > 32 * 1024) {
        clamped[key] = v.slice(0, 32 * 1024) + `\n… [truncated ${v.length - 32 * 1024} chars on persist]`;
      }
    }
    if (JSON.stringify(clamped).length > ENTRY_JSON_SOFT_MAX) {
      for (const key of Object.keys(clamped)) {
        const v = clamped[key];
        if (typeof v === 'string' && v.length > 32 * 1024) {
          clamped[key] = v.slice(0, 32 * 1024) + `\n… [truncated ${v.length - 32 * 1024} chars on persist]`;
        }
      }
    }
    return clamped;
  } catch {
    return entry;
  }
}

function broadcastChanged(event: IpcMainInvokeEvent, sessionId: string): void {
  /* 极简版没有窗口 —— 这个循环在那边是空转, 表现是 timeline 推不到渲染层。
   * (BrowserWindow 本身也拿不到, 见 lazyElectron.ts。) */
  for (const win of (electronOrNull()?.BrowserWindow?.getAllWindows?.() ?? [])) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (win.webContents.id === event?.sender.id) continue; /* 发起窗自己是写入方, 不用通知 */
      win.webContents.send('timeline:changed', { sessionId });
    } catch { /* 单窗失败不影响其它 */ }
  }
}

export function registerTimelineIpcHandlers(): void {
  ipcMain.handle('timeline:upsert-batch', (event, sessionId: unknown, entries: unknown) => {
    try {
      assertSessionId(sessionId);
      if (!Array.isArray(entries)) throw new Error('entries must be an array');
      if (entries.length === 0) return { ok: true };
      if (entries.length > UPSERT_BATCH_MAX) throw new Error(`batch too large (${entries.length} > ${UPSERT_BATCH_MAX})`);
      const sanitized = entries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as any).id === 'string')
        .map(clampOversizedEntry);
      getDatabase().upsertTimelineEntries(sessionId, sanitized);
      broadcastChanged(event, sessionId);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('timeline:page', (_event, sessionId: unknown, opts?: { limit?: number; beforeRowId?: number }) => {
    try {
      assertSessionId(sessionId);
      /* NaN/Infinity 一律回落默认值 — DB 层 getTimelinePage 会再 clamp 到 [1,5000],
       * 这里挡掉非有限数, 避免 NaN 直传 SQLite bind 抛错 (虽被 catch, 但报错不可读). */
      const limit = typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? opts.limit : 1000;
      const beforeRowId = typeof opts?.beforeRowId === 'number' && Number.isFinite(opts.beforeRowId) ? opts.beforeRowId : undefined;
      const page = getDatabase().getTimelinePage(sessionId, limit, beforeRowId);
      return { ok: true, ...page };
    } catch (e: any) {
      return { ok: false, entries: [], oldestRowId: null, total: 0, error: e?.message ?? String(e) };
    }
  });

  /* 侧栏工作台卡片 / 全景墙: 一批会话各自「现在什么样」(等你? 在干嘛? 最后一句)。
   * 只看每个会话最近 60 条。ask_user / 审批是原地改状态的 (条目数不变), 所以不按条目数缓存,
   * 只按时间缓存 15 秒 —— 侧栏每次刷新几十个会话, 不至于每次都全量重读。 */
  /** 出图会话的摘要: 成品 = 最近几张图, 一句话 = 「出了 N 张 · 第 M 版」 */
  const glanceImageTurns = (id: string): SessionGlance | null => {
    const turns = getDatabase().listImageTurns(id) as Array<{ payload: string; createdAt: number }>;
    if (!turns.length) return null;
    const outputs: Array<{ path: string; ext: string }> = [];
    let images = 0; let rounds = 0; let lastTs = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      let p: any;
      try { p = JSON.parse(turns[i]!.payload); } catch { continue; }
      const paths: string[] = Array.isArray(p?.result?.paths) ? p.result.paths : [];
      if (!paths.length) continue;
      rounds++; images += paths.length;
      lastTs = Math.max(lastTs, Number(p.createdAt) || turns[i]!.createdAt || 0);
      for (const pth of paths) if (outputs.length < 3) outputs.push({ path: pth, ext: (pth.split('.').pop() || 'png').toLowerCase() });
    }
    if (!images) return null;
    return { waiting: null, activity: '', lastLine: rounds > 1 ? `出了 ${images} 张 · 第 ${rounds} 版` : `出了 ${images} 张`, lastTs, outputs };
  };

  ipcMain.handle('session:glance', (_event, sessionIds: unknown) => {
    const ids = Array.isArray(sessionIds) ? sessionIds.filter((s): s is string => typeof s === 'string' && !!s && s.length <= 256).slice(0, 400) : [];
    const result: Record<string, SessionGlance> = {};
    const now = Date.now();
    for (const id of ids) {
      try {
        const cached = glanceCache.get(id);
        if (cached && now - cached.at < 15_000) { result[id] = cached.glance; continue; }
        const page = getDatabase().getTimelinePage(id, 60, undefined);
        let glance = glanceSession(page.entries as Array<Record<string, any>>);
        if (!glance.lastLine && glance.outputs.length === 0) glance = glanceImageTurns(id) ?? glance;
        glanceCache.set(id, { at: now, glance });
        result[id] = glance;
      } catch { /* 单个会话读失败: 不给摘要, 其它照常 */ }
    }
    return result;
  });

  let outputsCache: { at: number; items: unknown[] } | null = null;
  const perSessionOutputs = new Map<string, { updatedAt: number; version: number; outputs: ReturnType<typeof outputsOf> }>();
  /* 冷缓存时仍要读一批会话 —— 每 4 个 (~30ms) 让出一次事件循环, 别让启动时这一下把主进程整段冻住;
   * 同时来的请求合并到同一次计算上。 */
  let outputsInflight: Promise<{ items: unknown[] }> | null = null;
  ipcMain.handle('library:session-outputs', () => {
    const now = Date.now();
    if (outputsCache && now - outputsCache.at < 30_000) return { items: outputsCache.items };
    if (!outputsInflight) {
      outputsInflight = computeSessionOutputs(now).finally(() => { outputsInflight = null; });
    }
    return outputsInflight;
  });
  async function computeSessionOutputs(now: number): Promise<{ items: unknown[] }> {
    const db = getDatabase();
    const byPath = new Map<string, { path: string; ext: string; name: string; size: number; mtime: number; ts: number; sessionId: string; sessionTitle: string }>();
    try {
      const sessions = (db.listSessions() as Array<{ id: string; name?: string; kind?: string; updatedAt?: number }>).slice(0, 200);
      const alive = new Set<string>();
      let reads = 0;
      for (const s of sessions) {
        try {
          if (reads >= 4) { reads = 0; await new Promise<void>((r) => setImmediate(r)); }
          alive.add(s.id);
          const updatedAt = Number(s.updatedAt) || 0;
          const version = db.getTimelineVersion(s.id);
          let cached = perSessionOutputs.get(s.id);
          if (!cached || cached.updatedAt !== updatedAt || cached.version !== version) {
            reads++;
            const page = db.getTimelinePage(s.id, 300, undefined);
            cached = { updatedAt, version, outputs: outputsOf(page.entries as Array<Record<string, any>>, 40) };
            perSessionOutputs.set(s.id, cached);
          }
          for (const o of cached.outputs) {
            const prev = byPath.get(o.path);
            if (prev && prev.ts >= o.ts) continue;
            let st: { size: number; mtimeMs: number } | null = null;
            try { st = statSync(o.path); } catch { /* 文件已删 / 挪走 */ }
            if (!st) continue;
            byPath.set(o.path, {
              path: o.path, ext: o.ext, name: o.path.split(/[\\/]/).pop() || o.path,
              size: st.size, mtime: st.mtimeMs, ts: o.ts || st.mtimeMs,
              sessionId: s.id, sessionTitle: s.name || '',
            });
          }
        } catch { /* 单个会话读失败跳过 */ }
      }
      for (const id of perSessionOutputs.keys()) if (!alive.has(id)) perSessionOutputs.delete(id);
    } catch { /* 库不可用: 空 */ }
    const items = [...byPath.values()].sort((a, b) => b.ts - a.ts);
    outputsCache = { at: now, items };
    return { items };
  }

  ipcMain.handle('timeline:delete-entry', (event, sessionId: unknown, entryId: unknown) => {
    try {
      assertSessionId(sessionId);
      if (typeof entryId !== 'string' || !entryId) throw new Error('invalid entryId');
      getDatabase().deleteTimelineEntryById(sessionId, entryId);
      broadcastChanged(event, sessionId);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('timeline:count', (_event, sessionId: unknown) => {
    try {
      assertSessionId(sessionId);
      return { ok: true, count: getDatabase().countTimeline(sessionId) };
    } catch (e: any) {
      return { ok: false, count: 0, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('timeline:clear', (event, sessionId: unknown) => {
    try {
      assertSessionId(sessionId);
      getDatabase().clearTimeline(sessionId);
      broadcastChanged(event, sessionId);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('timeline:migration-state', (_event, op: unknown, key: unknown, value?: unknown) => {
    try {
      if (typeof key !== 'string' || !key.startsWith(MIGRATION_KEY_PREFIX) || key.length > 512) {
        throw new Error('invalid migration key');
      }
      const db = getDatabase();
      if (op === 'get') {
        return { ok: true, value: db.getAppState<string>(key) ?? null };
      }
      if (op === 'set') {
        if (typeof value === 'string' && value.length > 4096) {
          throw new Error('migration value too large');
        }
        db.setAppState(key, typeof value === 'string' ? value : '1');
        return { ok: true };
      }
      throw new Error('invalid op');
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
