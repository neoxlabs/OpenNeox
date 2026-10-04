/**
 * InterruptedRunStore — agenticRuntime 在跑 turn 时往 interrupted_runs 表留面包屑.
 *
 * server crash / hot-reload / OOM 后, bootstrap 时扫这张表, 找到 status='running'
 * 且 stale (last_heartbeat_at 超过阈值) 的 row, 调 resume engine 把 turn 自动接着跑.
 *
 * 设计依据: 内部设计文档 §4.1-4.2, Phase 1.1
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 一条 in-flight turn 的完整快照 (用于 resume) */
export interface InterruptedRunRecord {
  sessionId: string;
  workspacePath: string;
  mode: 'agentic';
  model: string;
  providerId: string | null;
  prompt: string;
  metadata: Record<string, any> | null;
  startedAt: number;
  lastHeartbeatAt: number;
  serverPid: number | null;
  serverToken: string | null;
  iteration: number;
  status: 'running' | 'completed' | 'errored' | 'cancelled' | 'resumed';
  completedAt: number | null;
  errorMessage: string | null;
}

export interface RecordStartOpts {
  sessionId: string;
  workspacePath: string;
  mode: 'agentic';
  model: string;
  providerId?: string;
  prompt: string;
  metadata?: Record<string, any>;
  serverPid?: number;
  serverToken?: string;
}

interface RawInterruptedRunRow {
  session_id: string;
  workspace_path: string;
  mode: string;
  model: string;
  provider_id: string | null;
  prompt: string;
  metadata: string | null;
  started_at: number;
  last_heartbeat_at: number;
  server_pid: number | null;
  server_token: string | null;
  iteration: number;
  status: string;
  completed_at: number | null;
  error_message: string | null;
}

export class InterruptedRunStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  /**
   * 一个 turn 开始时调用. 同 session 已有 running record 时直接覆盖 (一个 session
   * 同时只能有一个 in-flight turn — 这是 agenticRuntime 的不变量, 不允许并发 chat()).
   */
  recordStart(opts: RecordStartOpts): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        INSERT OR REPLACE INTO interrupted_runs (
          session_id, workspace_path, mode, model, provider_id, prompt,
          metadata, started_at, last_heartbeat_at, server_pid, server_token,
          iteration, status, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', NULL, NULL)
      `).run(
        opts.sessionId,
        opts.workspacePath,
        opts.mode,
        opts.model,
        opts.providerId ?? null,
        opts.prompt,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
        now,
        now,
        opts.serverPid ?? null,
        opts.serverToken ?? null,
      );
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `recordStart failed for session=${opts.sessionId}: ${err?.message}`);
    }
  }

  /** 5s 一次 heartbeat — 失败不阻塞主流程, agent loop 不被 IO 影响 */
  heartbeat(sessionId: string, iteration?: number): void {
    const now = Date.now();
    try {
      if (typeof iteration === 'number') {
        this.raw().prepare(`
          UPDATE interrupted_runs SET last_heartbeat_at = ?, iteration = ?
            WHERE session_id = ? AND status = 'running'
        `).run(now, iteration, sessionId);
      } else {
        this.raw().prepare(`
          UPDATE interrupted_runs SET last_heartbeat_at = ?
            WHERE session_id = ? AND status = 'running'
        `).run(now, sessionId);
      }
    } catch (err: any) {
      cliLogger.debug('INTERRUPTED_RUN', `heartbeat failed for session=${sessionId}: ${err?.message}`);
    }
  }

  markCompleted(sessionId: string): void {
    this.markTerminal(sessionId, 'completed');
  }

  markErrored(sessionId: string, errorMessage: string): void {
    this.markTerminal(sessionId, 'errored', errorMessage);
  }

  markCancelled(sessionId: string): void {
    this.markTerminal(sessionId, 'cancelled');
  }

  /** resume engine 拿走一条 run 之后, 标 resumed 防止再次被扫到. */
  markResumed(sessionId: string, newServerToken: string): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        UPDATE interrupted_runs
          SET last_heartbeat_at = ?, server_token = ?, status = 'running'
          WHERE session_id = ?
      `).run(now, newServerToken, sessionId);
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `markResumed failed for session=${sessionId}: ${err?.message}`);
    }
  }

  private markTerminal(sessionId: string, status: InterruptedRunRecord['status'], errorMessage?: string): void {
    const now = Date.now();
    try {
      this.raw().prepare(`
        UPDATE interrupted_runs
          SET status = ?, completed_at = ?, error_message = ?
          WHERE session_id = ?
      `).run(status, now, errorMessage ?? null, sessionId);
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `markTerminal(${status}) failed for session=${sessionId}: ${err?.message}`);
    }
  }

  /**
   * 扫所有 stale (status='running' + last_heartbeat_at 早于 cutoff) 的 row.
   * 调用方拿到列表后, 比对 server_token 跟当前 server token, 不同 = 真重启 → resume.
   */
  findStaleRunning(opts?: { staleAfterMs?: number; workspacePath?: string }): InterruptedRunRecord[] {
    const staleCutoff = Date.now() - (opts?.staleAfterMs ?? 30_000);
    const ws = opts?.workspacePath ?? this.workspacePath;
    try {
      const rows = this.raw().prepare(`
        SELECT * FROM interrupted_runs
          WHERE status = 'running'
            AND last_heartbeat_at < ?
            AND workspace_path = ?
          ORDER BY started_at ASC
      `).all(staleCutoff, ws) as RawInterruptedRunRow[];
      return rows.map(r => this.toRecord(r));
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `findStaleRunning failed: ${err?.message}`);
      return [];
    }
  }

  /** 取单条 — resume 流程要细看 metadata 等字段 */
  get(sessionId: string): InterruptedRunRecord | null {
    try {
      const row = this.raw().prepare(`
        SELECT * FROM interrupted_runs WHERE session_id = ?
      `).get(sessionId) as RawInterruptedRunRow | undefined;
      return row ? this.toRecord(row) : null;
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `get failed for session=${sessionId}: ${err?.message}`);
      return null;
    }
  }

  /** 删除老的 completed/errored/cancelled record — 防止表无限增长.
   *  默认保留 7 天, 用 cron 类机制定期跑 (现阶段不强求, 表小不影响性能). */
  purgeOlderThan(cutoffMs: number): number {
    try {
      const result = this.raw().prepare(`
        DELETE FROM interrupted_runs
          WHERE status != 'running' AND completed_at < ?
      `).run(cutoffMs);
      return result.changes;
    } catch (err: any) {
      cliLogger.warn('INTERRUPTED_RUN', `purgeOlderThan failed: ${err?.message}`);
      return 0;
    }
  }

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: RawInterruptedRunRow): InterruptedRunRecord {
    return {
      sessionId: row.session_id,
      workspacePath: row.workspace_path,
      mode: (row.mode === 'assistant' ? 'agentic' : row.mode) as 'agentic',
      model: row.model,
      providerId: row.provider_id,
      prompt: row.prompt,
      metadata: row.metadata ? safeJsonParse(row.metadata) : null,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      serverPid: row.server_pid,
      serverToken: row.server_token,
      iteration: row.iteration,
      status: row.status as InterruptedRunRecord['status'],
      completedAt: row.completed_at,
      errorMessage: row.error_message,
    };
  }
}

function safeJsonParse(s: string): Record<string, any> | null {
  try { return JSON.parse(s); } catch { return null; }
}
