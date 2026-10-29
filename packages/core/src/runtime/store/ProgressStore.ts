/**
 * ProgressStore — Agent 进度上报持久化
 *
 * 存储 Worker 通过 report_progress 工具上报的中间进度。
 * 支持按 agent、session、workspace 查询。
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';

// ============================================================================
// Types
// ============================================================================

export interface ProgressRecord {
  id: number;
  agentId: string;
  workspacePath: string;
  sessionId: string | null;
  phase: string | null;
  progressPct: number | null;
  message: string;
  details: any | null;
  createdAt: number;
}

export interface ProgressInput {
  phase?: string;
  progressPct?: number;
  message: string;
  details?: any;
  sessionId?: string;
}

interface ProgressRow {
  id: number;
  agent_id: string;
  workspace_path: string;
  session_id: string | null;
  phase: string | null;
  progress_pct: number | null;
  message: string;
  details: string | null;
  created_at: number;
}

// ============================================================================
// ProgressStore
// ============================================================================

export class ProgressStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  report(agentId: string, input: ProgressInput): number {
    const result = this.raw().prepare(`
      INSERT INTO agent_progress
        (agent_id, workspace_path, session_id, phase, progress_pct, message, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      this.workspacePath,
      input.sessionId || null,
      input.phase || null,
      input.progressPct ?? null,
      input.message,
      input.details ? JSON.stringify(input.details) : null,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  getByAgent(agentId: string, limit = 50): ProgressRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_progress WHERE agent_id = ? AND workspace_path = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, this.workspacePath, limit) as ProgressRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  getLatest(agentId: string): ProgressRecord | null {
    const row = this.raw().prepare(
      'SELECT * FROM agent_progress WHERE agent_id = ? AND workspace_path = ? ORDER BY created_at DESC LIMIT 1'
    ).get(agentId, this.workspacePath) as ProgressRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getBySession(sessionId: string, limit = 100): ProgressRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_progress WHERE workspace_path = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.workspacePath, sessionId, limit) as ProgressRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  getRecent(limit = 50): ProgressRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_progress WHERE workspace_path = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.workspacePath, limit) as ProgressRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  deleteByAgent(agentId: string): number {
    const result = this.raw().prepare(
      'DELETE FROM agent_progress WHERE agent_id = ? AND workspace_path = ?'
    ).run(agentId, this.workspacePath);
    return result.changes;
  }

  deleteOld(maxAge: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.raw().prepare(
      'DELETE FROM agent_progress WHERE workspace_path = ? AND created_at < ?'
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: ProgressRow): ProgressRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      workspacePath: row.workspace_path,
      sessionId: row.session_id,
      phase: row.phase,
      progressPct: row.progress_pct,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: row.created_at,
    };
  }
}
