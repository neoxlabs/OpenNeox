/**
 * BackgroundProcessStore — 后台进程跨 server 持久化.
 *
 * ProcessManager 内存 Map 在 server crash 后会丢, 但 detached 子进程
 * (e.g. spawn 的 dev server) 可能跨 server 还活着. 这张表持久化进程元数据,
 * bootstrap 时 reconcile: PID 还活 → 重新接管; PID 已死 → 标 interrupted.
 *
 * 设计依据: 内部设计文档 §4.6, Phase 1.4
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type BackgroundProcessState = 'running' | 'completed' | 'failed' | 'interrupted';

export interface BackgroundProcessRecord {
  pid: number;
  task: string;
  sessionId: string | null;
  command: string | null;
  workspacePath: string;
  startedAt: number;
  state: BackgroundProcessState;
  exitCode: number | null;
  detached: boolean;
  lastSeenAt: number;
  updatedAt: number;
}

export interface UpsertBackgroundProcessOpts {
  pid: number;
  task: string;
  sessionId?: string;
  command?: string;
  workspacePath: string;
  startedAt?: number;
  state?: BackgroundProcessState;
  exitCode?: number;
  detached?: boolean;
}

interface RawRow {
  pid: number;
  task: string;
  session_id: string | null;
  command: string | null;
  workspace_path: string;
  started_at: number;
  state: string;
  exit_code: number | null;
  detached: number;
  last_seen_at: number;
  updated_at: number;
}

export class BackgroundProcessStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  upsert(opts: UpsertBackgroundProcessOpts): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        INSERT INTO background_processes (
          pid, task, session_id, command, workspace_path, started_at,
          state, exit_code, detached, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pid) DO UPDATE SET
          task = excluded.task,
          session_id = COALESCE(excluded.session_id, background_processes.session_id),
          command = COALESCE(excluded.command, background_processes.command),
          state = excluded.state,
          exit_code = COALESCE(excluded.exit_code, background_processes.exit_code),
          detached = excluded.detached,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run(
        opts.pid,
        opts.task,
        opts.sessionId ?? null,
        opts.command ?? null,
        opts.workspacePath,
        opts.startedAt ?? now,
        opts.state ?? 'running',
        opts.exitCode ?? null,
        opts.detached ? 1 : 0,
        now,
        now,
      );
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `upsert failed for pid=${opts.pid}: ${err?.message}`);
    }
  }

  setState(pid: number, state: BackgroundProcessState, exitCode?: number): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        UPDATE background_processes
          SET state = ?, exit_code = COALESCE(?, exit_code), last_seen_at = ?, updated_at = ?
          WHERE pid = ?
      `).run(state, exitCode ?? null, now, now, pid);
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `setState failed for pid=${pid}: ${err?.message}`);
    }
  }

  heartbeat(pid: number): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        UPDATE background_processes SET last_seen_at = ? WHERE pid = ?
      `).run(now, pid);
    } catch (err: any) {
      cliLogger.debug('BG_PROC_STORE', `heartbeat failed for pid=${pid}: ${err?.message}`);
    }
  }

  /** bootstrap 时:把 state='running' 的拿出来, ProcessManager 自己负责 ping pid 决定怎么处理. */
  findRunning(): BackgroundProcessRecord[] {
    try {
      const rows = this.raw().prepare(`
        SELECT * FROM background_processes
          WHERE state = 'running' AND workspace_path = ?
          ORDER BY started_at ASC
      `).all(this.workspacePath) as RawRow[];
      return rows.map(r => this.toRecord(r));
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `findRunning failed: ${err?.message}`);
      return [];
    }
  }

  findBySession(sessionId: string): BackgroundProcessRecord[] {
    try {
      const rows = this.raw().prepare(`
        SELECT * FROM background_processes
          WHERE session_id = ? AND workspace_path = ?
          ORDER BY started_at ASC
      `).all(sessionId, this.workspacePath) as RawRow[];
      return rows.map(r => this.toRecord(r));
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `findBySession failed: ${err?.message}`);
      return [];
    }
  }

  remove(pid: number): void {
    try {
      this.raw().prepare(`DELETE FROM background_processes WHERE pid = ?`).run(pid);
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `remove failed for pid=${pid}: ${err?.message}`);
    }
  }

  /** 老 terminal-state record 清理 */
  purgeOlderThan(cutoffMs: number): number {
    try {
      const r = this.raw().prepare(`
        DELETE FROM background_processes
          WHERE state IN ('completed', 'failed', 'interrupted') AND updated_at < ?
      `).run(cutoffMs);
      return r.changes;
    } catch (err: any) {
      cliLogger.warn('BG_PROC_STORE', `purgeOlderThan failed: ${err?.message}`);
      return 0;
    }
  }

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: RawRow): BackgroundProcessRecord {
    return {
      pid: row.pid,
      task: row.task,
      sessionId: row.session_id,
      command: row.command,
      workspacePath: row.workspace_path,
      startedAt: row.started_at,
      state: row.state as BackgroundProcessState,
      exitCode: row.exit_code,
      detached: row.detached === 1,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
    };
  }
}
