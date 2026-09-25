/**
 * LifeEventsStore — Life 事件持久化 + 状态机
 *
 * 设计:
 *   - 独立 sqlite (~/.neox/life_events.db), 与主库零耦合
 *   - kind (outcome/reminder/brief_hint) × status 显式状态机 (见 lifeEventsTypes.ts)
 *   - 状态迁移强制走 transition(id, toStatus), 非法迁移抛错并写审计
 *   - Prepared statement 缓存, 单例 (getStore) 保证跨进程内 IPC 共享一个连接
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openAuxiliaryDatabase } from '@neoxlabs/platform/platform/database.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import {
  ALLOWED_TRANSITIONS,
  INITIAL_STATUS,
  isAllowedTransition,
  isValidKindStatus,
  type LifeEvent,
  type LifeEventCreate,
  type LifeEventKind,
  type LifeEventStatus,
  type LifeEventTransition,
  type RelatedCard,
} from './lifeEventsTypes.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS life_events (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('outcome','reminder','brief_hint')),
  status             TEXT NOT NULL,
  session_id         TEXT,
  title              TEXT NOT NULL,
  summary            TEXT,
  payload_json       TEXT,
  related_cards_json TEXT NOT NULL DEFAULT '[]',
  tags_json          TEXT NOT NULL DEFAULT '[]',
  scheduled_at       INTEGER,
  fired_at           INTEGER,
  done_at            INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_life_kind_status ON life_events(kind, status);
CREATE INDEX IF NOT EXISTS idx_life_session ON life_events(session_id);
CREATE INDEX IF NOT EXISTS idx_life_scheduled ON life_events(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_life_created ON life_events(created_at DESC);

CREATE TABLE IF NOT EXISTS life_event_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_life_trans_event ON life_event_transitions(event_id);

CREATE TABLE IF NOT EXISTS _life_schema_version (
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO _life_schema_version (version) VALUES (2);
`;

/* Schema v1 → v2 迁移: 补 tags_json 列. 幂等 (老版建的表没这列, ALTER 加; 已有则跳过) */
const MIGRATE_TO_V2_SQL = `
ALTER TABLE life_events ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
UPDATE _life_schema_version SET version = 2;
`;

interface LifeEventRow {
  id: string;
  kind: string;
  status: string;
  session_id: string | null;
  title: string;
  summary: string | null;
  payload_json: string | null;
  related_cards_json: string;
  tags_json?: string;
  scheduled_at: number | null;
  fired_at: number | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToEvent(row: LifeEventRow): LifeEvent {
  let payload: LifeEvent['payload'] = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch { payload = null; }
  let relatedCards: RelatedCard[] = [];
  try {
    const parsed = JSON.parse(row.related_cards_json || '[]');
    if (Array.isArray(parsed)) relatedCards = parsed as RelatedCard[];
  } catch { relatedCards = []; }
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json ?? '[]');
    if (Array.isArray(parsed)) tags = parsed.filter(t => typeof t === 'string');
  } catch { tags = []; }
  return {
    id: row.id,
    kind: row.kind as LifeEventKind,
    status: row.status as LifeEventStatus,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    payload,
    relatedCards,
    tags,
    scheduledAt: row.scheduled_at,
    firedAt: row.fired_at,
    doneAt: row.done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LifeEventsStore {
  private db: Database.Database;
  /** 变更监听 (renderer store 通过 IPC push 拉最新 — 这里只在同进程用) */
  private listeners = new Set<() => void>();

  constructor(dbPath: string) {
    this.db = openAuxiliaryDatabase(dbPath);
    this.db.exec(SCHEMA_SQL);
    /* v1 → v2 迁移: tags_json 列. 幂等 (已存在则 ALTER 报错 catch). */
    try {
      const row = this.db.prepare('SELECT version FROM _life_schema_version LIMIT 1').get() as { version?: number } | undefined;
      const cur = row?.version ?? 1;
      if (cur < 2) {
        try { this.db.exec(MIGRATE_TO_V2_SQL); }
        catch { /* 老 SCHEMA_SQL 已有该列 (新装用户), no-op */ }
      }
    } catch { /* ignore */ }
  }

  // ---------- 生命周期 ----------

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  // ---------- 订阅 (进程内通知) ----------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* listener 异常不影响其它 */ }
    }
  }

  // ---------- 写路径 ----------

  /** 创建事件. status 由 kind 决定初始态, 不允许调用方指定 (走状态机). */
  create(input: LifeEventCreate): LifeEvent {
    const now = Date.now();
    const status = INITIAL_STATUS[input.kind];
    if (!isValidKindStatus(input.kind, status)) {
      throw new Error(`invalid initial status for kind ${input.kind}: ${status}`);
    }
    const id = `le_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const tagsClean = (input.tags ?? [])
      .filter(t => typeof t === 'string' && t.trim().length > 0)
      .map(t => t.trim().slice(0, 40));
    const row: LifeEventRow = {
      id,
      kind: input.kind,
      status,
      session_id: input.sessionId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      payload_json: input.payload ? JSON.stringify(input.payload) : null,
      related_cards_json: JSON.stringify(input.relatedCards ?? []),
      tags_json: JSON.stringify(tagsClean),
      scheduled_at: input.scheduledAt ?? null,
      fired_at: null,
      done_at: null,
      created_at: now,
      updated_at: now,
    };
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO life_events
          (id, kind, status, session_id, title, summary, payload_json,
           related_cards_json, tags_json, scheduled_at, fired_at, done_at, created_at, updated_at)
        VALUES
          (@id, @kind, @status, @session_id, @title, @summary, @payload_json,
           @related_cards_json, @tags_json, @scheduled_at, @fired_at, @done_at, @created_at, @updated_at)
      `).run(row);
      this.db.prepare(`
        INSERT INTO life_event_transitions (event_id, from_status, to_status, timestamp, reason)
        VALUES (?, NULL, ?, ?, ?)
      `).run(id, status, now, 'created');
    });
    tx();
    this.notify();
    return rowToEvent(row);
  }

  /**
   * 状态迁移 — 唯一入口, 校验 kind + from + to 合法性, 写审计.
   * 非法迁移抛错. 幂等设计: 目标 status = 当前 status 直接返回, 不写审计.
   */
  transition(id: string, toStatus: LifeEventStatus, reason?: string): LifeEvent {
    const now = Date.now();
    const cur = this.get(id);
    if (!cur) throw new Error(`life event not found: ${id}`);
    if (cur.status === toStatus) return cur;
    if (!isAllowedTransition(cur.kind, cur.status, toStatus)) {
      throw new Error(
        `illegal transition: ${cur.kind} ${cur.status} → ${toStatus} ` +
        `(allowed: ${(ALLOWED_TRANSITIONS[cur.kind]?.[cur.status] ?? []).join(',') || 'none'})`,
      );
    }

    /* 迁移副作用: 特定状态自动打时间戳 */
    const patch: Record<string, unknown> = { status: toStatus, updated_at: now };
    if (toStatus === 'fired' && cur.kind === 'reminder') patch.fired_at = now;
    if (toStatus === 'done') patch.done_at = now;

    const tx = this.db.transaction(() => {
      const sets = Object.keys(patch).map(k => `${k} = @${k}`).join(', ');
      this.db.prepare(`UPDATE life_events SET ${sets} WHERE id = @id`)
        .run({ ...patch, id });
      this.db.prepare(`
        INSERT INTO life_event_transitions (event_id, from_status, to_status, timestamp, reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, cur.status, toStatus, now, reason ?? null);
    });
    tx();
    this.notify();
    return this.get(id)!;
  }

  /** 更新非状态字段 (title/summary/payload/relatedCards/tags/scheduledAt). 不能改 status/kind. */
  update(id: string, patch: Partial<Omit<LifeEventCreate, 'kind'>>): LifeEvent {
    const cur = this.get(id);
    if (!cur) throw new Error(`life event not found: ${id}`);
    const row: Record<string, unknown> = { id, updated_at: Date.now() };
    if (patch.sessionId !== undefined) row.session_id = patch.sessionId;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.summary !== undefined) row.summary = patch.summary;
    if (patch.payload !== undefined) row.payload_json = patch.payload ? JSON.stringify(patch.payload) : null;
    if (patch.relatedCards !== undefined) row.related_cards_json = JSON.stringify(patch.relatedCards);
    if (patch.tags !== undefined) {
      const tagsClean = patch.tags
        .filter(t => typeof t === 'string' && t.trim().length > 0)
        .map(t => t.trim().slice(0, 40));
      row.tags_json = JSON.stringify(tagsClean);
    }
    if (patch.scheduledAt !== undefined) row.scheduled_at = patch.scheduledAt;
    const cols = Object.keys(row).filter(k => k !== 'id');
    if (cols.length === 1) return cur;   // 只有 updated_at, no-op
    const sets = cols.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE life_events SET ${sets} WHERE id = @id`).run(row);
    this.notify();
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM life_events WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM life_event_transitions WHERE event_id = ?').run(id);
    if (info.changes > 0) { this.notify(); return true; }
    return false;
  }

  // ---------- 读路径 ----------

  get(id: string): LifeEvent | null {
    const row = this.db.prepare('SELECT * FROM life_events WHERE id = ?').get(id) as LifeEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  listByKind(kind: LifeEventKind, opts?: { status?: LifeEventStatus; limit?: number }): LifeEvent[] {
    const parts: string[] = ['SELECT * FROM life_events WHERE kind = ?'];
    const args: unknown[] = [kind];
    if (opts?.status) { parts.push('AND status = ?'); args.push(opts.status); }
    parts.push('ORDER BY updated_at DESC');
    if (opts?.limit) parts.push(`LIMIT ${Math.max(1, Math.min(500, opts.limit))}`);
    const rows = this.db.prepare(parts.join(' ')).all(...args) as LifeEventRow[];
    return rows.map(rowToEvent);
  }

  /** 到期未发的 reminder — job runner 每分钟拉一次. */
  listDueReminders(before: number = Date.now()): LifeEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM life_events
       WHERE kind = 'reminder'
         AND status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
    `).all(before) as LifeEventRow[];
    return rows.map(rowToEvent);
  }

  /** Daily Brief 组合查询: 未办 outcomes + 未来 24h reminders + 有效 brief_hints */
  listForDailyBrief(now: number = Date.now()): {
    outcomes: LifeEvent[];
    reminders: LifeEvent[];
    hints: LifeEvent[];
  } {
    const outcomes = this.db.prepare(`
      SELECT * FROM life_events
       WHERE kind='outcome' AND status='pending'
       ORDER BY updated_at DESC LIMIT 20
    `).all() as LifeEventRow[];
    const reminders = this.db.prepare(`
      SELECT * FROM life_events
       WHERE kind='reminder' AND status='scheduled'
         AND scheduled_at IS NOT NULL AND scheduled_at BETWEEN ? AND ?
       ORDER BY scheduled_at ASC LIMIT 20
    `).all(now - 3600_000, now + 86400_000) as LifeEventRow[];
    const hints = this.db.prepare(`
      SELECT * FROM life_events
       WHERE kind='brief_hint' AND status IN ('candidate','surfaced')
       ORDER BY updated_at DESC LIMIT 10
    `).all() as LifeEventRow[];
    return {
      outcomes: outcomes.map(rowToEvent),
      reminders: reminders.map(rowToEvent),
      hints: hints.map(rowToEvent),
    };
  }

  /** 会话结束后拿该 session 已 emit 的富卡, 供 finalize_task 关联 */
  listRelatedForSession(sessionId: string): LifeEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM life_events WHERE session_id = ? ORDER BY created_at DESC
    `).all(sessionId) as LifeEventRow[];
    return rows.map(rowToEvent);
  }

  /** 审计 — 状态迁移历史, 排查用 */
  transitions(eventId: string): LifeEventTransition[] {
    const rows = this.db.prepare(`
      SELECT id, event_id, from_status, to_status, timestamp, reason
        FROM life_event_transitions WHERE event_id = ? ORDER BY id ASC
    `).all(eventId) as Array<{
      id: number; event_id: string; from_status: string | null;
      to_status: string; timestamp: number; reason: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      eventId: r.event_id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      timestamp: r.timestamp,
      reason: r.reason,
    }));
  }
}

// ---------- 单例 ----------

let _instance: LifeEventsStore | null = null;

/** 主进程/agent 共享同一个 store 实例. */
export function getLifeEventsStore(): LifeEventsStore {
  if (_instance) return _instance;
  const dir = join(homedir(), NEOX_HOME_DIRNAME);
  const file = join(dir, 'life_events.db');
  _instance = new LifeEventsStore(file);
  return _instance;
}

/** 测试用: 关掉单例 (release 里不该调) */
export function _resetLifeEventsStore(): void {
  if (_instance) { try { _instance.close(); } catch { /* ignore */ } }
  _instance = null;
}
