/**
 * AgentRegistryStore — 持久化 Agent 身份注册表
 *
 * 支持两种组织模式：
 * 1. **持久化组织** (persistent) — 固定角色，跨 session 记忆，读取 .neox/organization.yaml
 * 2. **临时组织** (temporary) — 当前 spawn 模式，per-task 创建销毁
 *
 * 持久化 Agent 有：
 * - 唯一稳定 ID（不是 proc-N）
 * - 角色 + 部门归属
 * - 跨 session 的记忆摘要
 * - 模型偏好
 * - 特长标签（用于自动匹配任务）
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { randomUUID } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// Types
// ============================================================================

export type AgentRegistryStatus = 'idle' | 'busy' | 'offline';
export type ConfigSource = 'yaml' | 'auto' | 'manual';

export interface RegisteredAgent {
  id: string;
  workspacePath: string;
  role: string;
  department: string | null;
  model: string | null;
  specialties: string[];
  status: AgentRegistryStatus;
  memorySummary: string | null;
  lastTask: string | null;
  totalTasks: number;
  totalToolCalls: number;
  lastActiveAt: number | null;
  createdAt: number;
  updatedAt: number;
  configSource: ConfigSource;
}

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  workspacePath: string;
  sessionId: string | null;
  taskSummary: string;
  keyFindings: string[] | null;
  filesTouched: string[] | null;
  lessonsLearned: string | null;
  createdAt: number;
}

export interface RegisterAgentOpts {
  id: string;
  role: string;
  department?: string;
  model?: string;
  specialties?: string[];
  configSource?: ConfigSource;
}

// ============================================================================
// Schema SQL
// ============================================================================

export const AGENT_REGISTRY_SCHEMA_SQL = `
-- 持久化 Agent 身份注册表
CREATE TABLE IF NOT EXISTS agent_registry (
  id              TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  role            TEXT NOT NULL,
  department      TEXT,
  model           TEXT,
  specialties     TEXT,
  status          TEXT DEFAULT 'idle',
  memory_summary  TEXT,
  last_task       TEXT,
  total_tasks     INTEGER DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  last_active_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  config_source   TEXT DEFAULT 'yaml',
  PRIMARY KEY (workspace_path, id)
);

CREATE INDEX IF NOT EXISTS idx_registry_ws ON agent_registry(workspace_path);
CREATE INDEX IF NOT EXISTS idx_registry_ws_dept ON agent_registry(workspace_path, department);
CREATE INDEX IF NOT EXISTS idx_registry_ws_status ON agent_registry(workspace_path, status);

-- Agent 历史任务记忆
CREATE TABLE IF NOT EXISTS agent_memory (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  session_id      TEXT,
  task_summary    TEXT NOT NULL,
  key_findings    TEXT,
  files_touched   TEXT,
  lessons_learned TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, workspace_path);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(created_at);
`;

// ============================================================================
// AgentRegistryStore
// ============================================================================

export class AgentRegistryStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
    this.ensureTables();
  }

  private ensureTables(): void {
    try {
      this.raw().exec(AGENT_REGISTRY_SCHEMA_SQL);
    } catch (err: any) {
      cliLogger.warn('AGENT_REGISTRY', `Schema init failed (non-fatal): ${err.message}`);
    }
  }

  // ==========================================================================
  // 注册 / 更新
  // ==========================================================================

  /** 注册或更新一个持久化 Agent */
  register(opts: RegisterAgentOpts): void {
    const now = Date.now();
    this.raw().prepare(`
      INSERT INTO agent_registry
        (id, workspace_path, role, department, model, specialties, status,
         created_at, updated_at, config_source)
      VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
      ON CONFLICT(workspace_path, id) DO UPDATE SET
        role = excluded.role,
        department = excluded.department,
        model = COALESCE(excluded.model, model),
        specialties = COALESCE(excluded.specialties, specialties),
        config_source = excluded.config_source,
        updated_at = excluded.updated_at
    `).run(
      opts.id,
      this.workspacePath,
      opts.role,
      opts.department || null,
      opts.model || null,
      opts.specialties ? JSON.stringify(opts.specialties) : null,
      now, now,
      opts.configSource || 'yaml',
    );
  }

  /** 批量注册（从 YAML 同步时用） */
  registerBatch(agents: RegisterAgentOpts[]): void {
    this.raw().transaction(() => {
      for (const a of agents) {
        this.register(a);
      }
    })();
  }

  /** 更新状态 */
  updateStatus(agentId: string, status: AgentRegistryStatus): void {
    this.raw().prepare(
      'UPDATE agent_registry SET status = ?, updated_at = ? WHERE workspace_path = ? AND id = ?'
    ).run(status, Date.now(), this.workspacePath, agentId);
  }

  /** 标记为忙碌 + 更新当前任务 */
  markBusy(agentId: string, task: string): void {
    this.raw().prepare(
      "UPDATE agent_registry SET status = 'busy', last_task = ?, last_active_at = ?, updated_at = ? WHERE workspace_path = ? AND id = ?"
    ).run(task, Date.now(), Date.now(), this.workspacePath, agentId);
  }

  /** 标记完成（恢复 idle + 累计统计） */
  markCompleted(agentId: string, stats: { toolCalls?: number } = {}): void {
    const now = Date.now();
    this.raw().prepare(`
      UPDATE agent_registry SET 
        status = 'idle',
        total_tasks = total_tasks + 1,
        total_tool_calls = total_tool_calls + ?,
        last_active_at = ?,
        updated_at = ?
      WHERE workspace_path = ? AND id = ?
    `).run(stats.toolCalls || 0, now, now, this.workspacePath, agentId);
  }

  /** 更新记忆摘要 */
  updateMemorySummary(agentId: string, summary: string): void {
    this.raw().prepare(
      'UPDATE agent_registry SET memory_summary = ?, updated_at = ? WHERE workspace_path = ? AND id = ?'
    ).run(summary, Date.now(), this.workspacePath, agentId);
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  /** 获取单个 Agent */
  getAgent(agentId: string): RegisteredAgent | null {
    const row = this.raw().prepare(
      'SELECT * FROM agent_registry WHERE workspace_path = ? AND id = ?'
    ).get(this.workspacePath, agentId) as any;
    return row ? this.toRecord(row) : null;
  }

  /** 获取所有注册 Agent */
  listAll(): RegisteredAgent[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_registry WHERE workspace_path = ? ORDER BY department, role'
    ).all(this.workspacePath) as any[];
    return rows.map(r => this.toRecord(r));
  }

  /** 按部门查询 */
  listByDepartment(department: string): RegisteredAgent[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_registry WHERE workspace_path = ? AND department = ? ORDER BY role'
    ).all(this.workspacePath, department) as any[];
    return rows.map(r => this.toRecord(r));
  }

  /** 查找空闲 Agent（按 specialty 模糊匹配） */
  findAvailable(query?: { specialty?: string; department?: string }): RegisteredAgent[] {
    let sql = "SELECT * FROM agent_registry WHERE workspace_path = ? AND status = 'idle'";
    const params: any[] = [this.workspacePath];

    if (query?.department) {
      sql += ' AND department = ?';
      params.push(query.department);
    }

    if (query?.specialty) {
      // 模糊匹配 specialties JSON 数组
      sql += ' AND specialties LIKE ?';
      params.push(`%${query.specialty}%`);
    }

    sql += ' ORDER BY total_tasks ASC, last_active_at ASC';

    const rows = this.raw().prepare(sql).all(...params) as any[];
    return rows.map(r => this.toRecord(r));
  }

  // ==========================================================================
  // 记忆
  // ==========================================================================

  /** 保存任务记忆 */
  saveMemory(entry: {
    agentId: string;
    sessionId?: string;
    taskSummary: string;
    keyFindings?: string[];
    filesTouched?: string[];
    lessonsLearned?: string;
  }): string {
    const id = `mem-${randomUUID().slice(0, 8)}`;
    this.raw().prepare(`
      INSERT INTO agent_memory
        (id, agent_id, workspace_path, session_id, task_summary,
         key_findings, files_touched, lessons_learned, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.agentId,
      this.workspacePath,
      entry.sessionId || null,
      entry.taskSummary,
      entry.keyFindings ? JSON.stringify(entry.keyFindings) : null,
      entry.filesTouched ? JSON.stringify(entry.filesTouched) : null,
      entry.lessonsLearned || null,
      Date.now(),
    );
    return id;
  }

  /** 获取 Agent 的历史记忆（最近 N 条） */
  getMemories(agentId: string, limit = 10): AgentMemoryEntry[] {
    const rows = this.raw().prepare(
      'SELECT * FROM agent_memory WHERE agent_id = ? AND workspace_path = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, this.workspacePath, limit) as any[];
    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      workspacePath: r.workspace_path,
      sessionId: r.session_id,
      taskSummary: r.task_summary,
      keyFindings: r.key_findings ? JSON.parse(r.key_findings) : null,
      filesTouched: r.files_touched ? JSON.parse(r.files_touched) : null,
      lessonsLearned: r.lessons_learned,
      createdAt: r.created_at,
    }));
  }

  /** 生成记忆摘要（用于注入 system prompt） */
  buildMemoryPrompt(agentId: string, maxEntries = 5): string {
    const memories = this.getMemories(agentId, maxEntries);
    if (memories.length === 0) return '';

    const agent = this.getAgent(agentId);
    const lines: string[] = [
      `## 历史任务记忆（${agent?.role || agentId}）`,
      `你已完成 ${agent?.totalTasks || 0} 个任务。以下是你最近的任务经验：`,
      '',
    ];

    for (const m of memories) {
      lines.push(`### ${m.taskSummary}`);
      if (m.keyFindings && m.keyFindings.length > 0) {
        lines.push(`关键发现: ${m.keyFindings.join(', ')}`);
      }
      if (m.filesTouched && m.filesTouched.length > 0) {
        lines.push(`涉及文件: ${m.filesTouched.slice(0, 10).join(', ')}`);
      }
      if (m.lessonsLearned) {
        lines.push(`经验: ${m.lessonsLearned}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  /** 清理旧记忆 */
  pruneMemories(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.raw().prepare(
      'DELETE FROM agent_memory WHERE workspace_path = ? AND created_at < ?'
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  /** 删除某个 Agent 的所有数据 */
  deleteAgent(agentId: string): void {
    this.raw().prepare(
      'DELETE FROM agent_memory WHERE agent_id = ? AND workspace_path = ?'
    ).run(agentId, this.workspacePath);
    this.raw().prepare(
      'DELETE FROM agent_registry WHERE id = ? AND workspace_path = ?'
    ).run(agentId, this.workspacePath);
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private raw() {
    return this.db.getRawDb();
  }

  private toRecord(row: any): RegisteredAgent {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      role: row.role,
      department: row.department,
      model: row.model,
      specialties: row.specialties ? JSON.parse(row.specialties) : [],
      status: row.status || 'idle',
      memorySummary: row.memory_summary,
      lastTask: row.last_task,
      totalTasks: row.total_tasks || 0,
      totalToolCalls: row.total_tool_calls || 0,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      configSource: row.config_source || 'yaml',
    };
  }
}
