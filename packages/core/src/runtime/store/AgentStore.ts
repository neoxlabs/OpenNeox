/**
 * AgentStore — Agent 生命周期持久化
 *
 * 封装 agents 表的所有 CRUD。构造时绑定 workspacePath，
 * 所有查询自动加 WHERE workspace_path = ? 隔离。
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type AgentState =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'interrupted'
  | 'paused';

export type AgentType = 'worker' | 'leader' | 'main';

export interface AgentRecord {
  id: string;
  workspacePath: string;
  sessionId: string | null;
  teamId: string | null;
  parentId: string | null;
  role: string;
  type: AgentType;
  task: string;
  context: string | null;
  state: AgentState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitReason: string | null;
  output: string | null;
  error: string | null;
  toolCalls: number;
  lastTool: string | null;
  lastOutput: string | null;
  retryCount: number;
  model: string | null;
  providerId: string | null;
  resumable: boolean;
}

export interface CreateAgentOpts {
  id?: string;
  sessionId?: string;
  teamId?: string;
  parentId?: string;
  role?: string;
  type?: AgentType;
  task: string;
  context?: string;
  model?: string;
  providerId?: string;
  resumable?: boolean;
}

// ============================================================================
// Row type (SQLite snake_case)
// ============================================================================

interface AgentRow {
  id: string;
  workspace_path: string;
  session_id: string | null;
  team_id: string | null;
  parent_id: string | null;
  role: string;
  type: string;
  task: string;
  context: string | null;
  state: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  exit_reason: string | null;
  output: string | null;
  error: string | null;
  tool_calls: number;
  last_tool: string | null;
  last_output: string | null;
  retry_count: number;
  model: string | null;
  provider_id: string | null;
  resumable: number;
}

// ============================================================================
// AgentStore
// ============================================================================

export class AgentStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  // ==========================================================================
  // Agent 生命周期
  // ==========================================================================

  createAgent(opts: CreateAgentOpts): string {
    const id = opts.id || `agent-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.raw().prepare(`
      INSERT OR REPLACE INTO agents
        (id, workspace_path, session_id, team_id, parent_id, role, type,
         task, context, state, created_at, model, provider_id, resumable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)
    `).run(
      id,
      this.workspacePath,
      opts.sessionId || null,
      opts.teamId || null,
      opts.parentId || 'main',
      opts.role || 'developer',
      opts.type || 'worker',
      opts.task,
      opts.context || null,
      now,
      opts.model || null,
      opts.providerId || null,
      opts.resumable ? 1 : 0,
    );
    return id;
  }

  updateState(agentId: string, state: AgentState, extra?: Partial<{
    output: string;
    error: string;
    exitReason: string;
    startedAt: number;
    endedAt: number;
    pausedAt: number;
    resumedAt: number;
  }>): void {
    const parts = ['state = ?'];
    const values: (string | number)[] = [state];

    if (extra?.output !== undefined) { parts.push('output = ?'); values.push(extra.output); }
    if (extra?.error !== undefined) { parts.push('error = ?'); values.push(extra.error); }
    if (extra?.exitReason !== undefined) { parts.push('exit_reason = ?'); values.push(extra.exitReason); }
    if (extra?.startedAt !== undefined) { parts.push('started_at = ?'); values.push(extra.startedAt); }
    if (extra?.endedAt !== undefined) { parts.push('ended_at = ?'); values.push(extra.endedAt); }

    if (state === 'running' && !extra?.startedAt) {
      parts.push('started_at = ?'); values.push(Date.now());
    }
    if ((state === 'completed' || state === 'failed' || state === 'killed') && !extra?.endedAt) {
      parts.push('ended_at = ?'); values.push(Date.now());
    }

    values.push(agentId);
    this.raw().prepare(`UPDATE agents SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  updateActivity(agentId: string, toolCalls: number, lastTool?: string, lastOutput?: string): void {
    this.raw().prepare(`
      UPDATE agents SET tool_calls = ?, last_tool = ?, last_output = ? WHERE id = ?
    `).run(toolCalls, lastTool || null, lastOutput?.slice(0, 500) || null, agentId);
  }

  incrementRetry(agentId: string): void {
    this.raw().prepare('UPDATE agents SET retry_count = retry_count + 1 WHERE id = ?').run(agentId);
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  getAgent(agentId: string): AgentRecord | null {
    const row = this.raw().prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getAgentsBySession(sessionId: string): AgentRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agents WHERE workspace_path = ? AND session_id = ? ORDER BY created_at DESC'
    ).all(this.workspacePath, sessionId) as AgentRow[];
    return rows.map(r => this.toRecord(r));
  }

  getAgentsByTeam(teamId: string): AgentRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agents WHERE workspace_path = ? AND team_id = ? ORDER BY created_at DESC'
    ).all(this.workspacePath, teamId) as AgentRow[];
    return rows.map(r => this.toRecord(r));
  }

  getRunningAgents(): AgentRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agents WHERE workspace_path = ? AND state = ? ORDER BY created_at DESC'
    ).all(this.workspacePath, 'running') as AgentRow[];
    return rows.map(r => this.toRecord(r));
  }

  getRecentAgents(limit = 20): AgentRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agents WHERE workspace_path = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.workspacePath, limit) as AgentRow[];
    return rows.map(r => this.toRecord(r));
  }

  // ==========================================================================
  // 恢复
  // ==========================================================================

  getInterruptedAgents(sessionId?: string): AgentRecord[] {
    if (sessionId) {
      const rows = this.raw().prepare(
        'SELECT * FROM agents WHERE workspace_path = ? AND session_id = ? AND state = ? ORDER BY created_at DESC'
      ).all(this.workspacePath, sessionId, 'interrupted') as AgentRow[];
      return rows.map(r => this.toRecord(r));
    }
    const rows = this.raw().prepare(
      'SELECT * FROM agents WHERE workspace_path = ? AND state = ? ORDER BY created_at DESC'
    ).all(this.workspacePath, 'interrupted') as AgentRow[];
    return rows.map(r => this.toRecord(r));
  }

  markAllRunningAsInterrupted(): number {
    const result = this.raw().prepare(
      "UPDATE agents SET state = 'interrupted', exit_reason = 'server_restart', ended_at = ? WHERE workspace_path = ? AND state = 'running'"
    ).run(Date.now(), this.workspacePath);
    return result.changes;
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  deleteOldAgents(maxAge: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.raw().prepare(
      "DELETE FROM agents WHERE workspace_path = ? AND state IN ('completed', 'failed', 'killed') AND ended_at < ?"
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  // ==========================================================================
  // ==========================================================================

  /**
   * 保存进程快照（用于暂停后恢复 / 应用重启后恢复）
   */
  saveSnapshot(agentId: string, snapshotJson: string): void {
    this.raw().prepare(`
      INSERT OR REPLACE INTO agent_snapshots (agent_id, workspace_path, snapshot, created_at)
      VALUES (?, ?, ?, ?)
    `).run(agentId, this.workspacePath, snapshotJson, Date.now());
  }

  /**
   * 读取进程快照
   */
  getSnapshot(agentId: string): string | null {
    const row = this.raw().prepare(
      'SELECT snapshot FROM agent_snapshots WHERE agent_id = ? AND workspace_path = ?'
    ).get(agentId, this.workspacePath) as { snapshot: string } | undefined;
    return row?.snapshot ?? null;
  }

  /**
   * 删除快照（恢复后或进程完成/kill 后清理）
   */
  deleteSnapshot(agentId: string): void {
    this.raw().prepare(
      'DELETE FROM agent_snapshots WHERE agent_id = ? AND workspace_path = ?'
    ).run(agentId, this.workspacePath);
  }

  listPausedSnapshots(): Array<{ agentId: string; snapshot: string; createdAt: number }> {
    const rows = this.raw().prepare(
      'SELECT agent_id, snapshot, created_at FROM agent_snapshots WHERE workspace_path = ? ORDER BY created_at DESC'
    ).all(this.workspacePath) as Array<{ agent_id: string; snapshot: string; created_at: number }>;
    return rows.map(r => ({
      agentId: r.agent_id,
      snapshot: r.snapshot,
      createdAt: r.created_at,
    }));
  }

  // ==========================================================================
  // ==========================================================================

  /**
   * 保存看板条目到 SQLite
   */
  saveTeamBoardEntry(entry: {
    id: string;
    sessionId: string;
    pid: string;
    role: string;
    type: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    replyTo?: string;
    channel?: string;
    timestamp: number;
  }): void {
    this.raw().prepare(`
      INSERT OR REPLACE INTO team_board_entries
        (id, workspace_path, session_id, pid, role, type, title, content, metadata, reply_to, channel, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      this.workspacePath,
      entry.sessionId,
      entry.pid,
      entry.role,
      entry.type,
      entry.title,
      entry.content,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.replyTo || null,
      entry.channel || null,
      entry.timestamp,
    );
  }

  /**
   * 按 session 读取看板条目（可选按 type 过滤）
   */
  getTeamBoardEntries(sessionId: string, filterType?: string): Array<{
    id: string;
    pid: string;
    role: string;
    type: string;
    title: string;
    content: string;
    metadata: Record<string, unknown> | undefined;
    replyTo: string | null;
    channel: string | null;
    createdAt: number;
  }> {
    const sql = filterType
      ? 'SELECT * FROM team_board_entries WHERE workspace_path = ? AND session_id = ? AND type = ? ORDER BY created_at ASC'
      : 'SELECT * FROM team_board_entries WHERE workspace_path = ? AND session_id = ? ORDER BY created_at ASC';
    const params = filterType
      ? [this.workspacePath, sessionId, filterType]
      : [this.workspacePath, sessionId];
    const rows = this.raw().prepare(sql).all(...params) as Array<{
      id: string; pid: string; role: string; type: string; title: string;
      content: string; metadata: string | null; reply_to: string | null;
      channel: string | null; created_at: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      pid: r.pid,
      role: r.role,
      type: r.type,
      title: r.title,
      content: r.content,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      replyTo: r.reply_to,
      channel: r.channel,
      createdAt: r.created_at,
    }));
  }

  /**
   * 清理过期看板条目
   */
  cleanOldTeamBoardEntries(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.raw().prepare(
      'DELETE FROM team_board_entries WHERE workspace_path = ? AND created_at < ?'
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: AgentRow): AgentRecord {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      sessionId: row.session_id,
      teamId: row.team_id,
      parentId: row.parent_id,
      role: row.role,
      type: row.type as AgentType,
      task: row.task,
      context: row.context,
      state: row.state as AgentState,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitReason: row.exit_reason,
      output: row.output,
      error: row.error,
      toolCalls: row.tool_calls,
      lastTool: row.last_tool,
      lastOutput: row.last_output,
      retryCount: row.retry_count,
      model: row.model,
      providerId: row.provider_id,
      resumable: row.resumable === 1,
    };
  }
}
