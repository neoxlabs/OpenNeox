/**
 * MessageStore — Agent 间通信消息持久化
 *
 * 记录 Hub 发送的所有消息（直发、广播、黑板通知、Leader 指令）。
 * 支持未投递消息查询（用于重启后重发）。
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';

// ============================================================================
// Types
// ============================================================================

export type AgentMsgType =
  | 'direct'
  | 'broadcast'
  | 'progress'
  | 'blackboard'
  | 'directive'
  | 'completion';

export interface AgentMessageRecord {
  id: number;
  workspacePath: string;
  fromAgentId: string;
  toAgentId: string | null;
  teamId: string | null;
  sessionId: string | null;
  msgType: AgentMsgType;
  content: string;
  priority: string;
  delivered: boolean;
  createdAt: number;
}

export interface SendMessageInput {
  fromAgentId: string;
  toAgentId?: string;
  teamId?: string;
  sessionId?: string;
  msgType: AgentMsgType;
  content: string;
  priority?: string;
}

interface MessageRow {
  id: number;
  workspace_path: string;
  from_agent_id: string;
  to_agent_id: string | null;
  team_id: string | null;
  session_id: string | null;
  msg_type: string;
  content: string;
  priority: string;
  delivered: number;
  created_at: number;
}

// ============================================================================
// MessageStore
// ============================================================================

export class MessageStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  send(input: SendMessageInput): number {
    const result = this.raw().prepare(`
      INSERT INTO agent_messages
        (workspace_path, from_agent_id, to_agent_id, team_id, session_id,
         msg_type, content, priority, delivered, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      this.workspacePath,
      input.fromAgentId,
      input.toAgentId || null,
      input.teamId || null,
      input.sessionId || null,
      input.msgType,
      input.content,
      input.priority || 'normal',
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  markDelivered(msgId: number): void {
    this.raw().prepare('UPDATE agent_messages SET delivered = 1 WHERE id = ?').run(msgId);
  }

  markAllDelivered(agentId: string): void {
    this.raw().prepare(
      'UPDATE agent_messages SET delivered = 1 WHERE workspace_path = ? AND to_agent_id = ? AND delivered = 0'
    ).run(this.workspacePath, agentId);
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  getUndelivered(agentId: string): AgentMessageRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_messages WHERE workspace_path = ? AND to_agent_id = ? AND delivered = 0 ORDER BY created_at'
    ).all(this.workspacePath, agentId) as MessageRow[];
    return rows.map(r => this.toRecord(r));
  }

  getByTeam(teamId: string, limit = 100): AgentMessageRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_messages WHERE workspace_path = ? AND team_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.workspacePath, teamId, limit) as MessageRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  getByAgent(agentId: string, limit = 50): AgentMessageRecord[] {
    const rows = this.raw().prepare(
      `SELECT * FROM agent_messages WHERE workspace_path = ?
       AND (from_agent_id = ? OR to_agent_id = ?)
       ORDER BY created_at DESC LIMIT ?`
    ).all(this.workspacePath, agentId, agentId, limit) as MessageRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  getRecent(limit = 50): AgentMessageRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_messages WHERE workspace_path = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.workspacePath, limit) as MessageRow[];
    rows.reverse();
    return rows.map(r => this.toRecord(r));
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  deleteOld(maxAge: number = 3 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.raw().prepare(
      'DELETE FROM agent_messages WHERE workspace_path = ? AND created_at < ?'
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  private toRecord(row: MessageRow): AgentMessageRecord {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      teamId: row.team_id,
      sessionId: row.session_id,
      msgType: row.msg_type as AgentMsgType,
      content: row.content,
      priority: row.priority,
      delivered: row.delivered === 1,
      createdAt: row.created_at,
    };
  }
}
