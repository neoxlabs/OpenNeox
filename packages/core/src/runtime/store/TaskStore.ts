/**
 * TaskStore — 可恢复任务持久化
 *
 * 存储任务定义及其生命周期，支持：
 * - 任务拆分（parent_task_id）
 * - 断点续做（state = interrupted → resume）
 * - 按 session/workspace 查询
 */

import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type TaskState =
  | 'pending'      // 待认领（在任务池中）
  | 'claimed'      // Leader 已认领，正在分析
  | 'decomposed'   // 已拆分为子任务
  | 'assigned'     // 已分配给 Worker
  | 'running'      // 执行中
  | 'blocked'      // 等待 Leader 判定（ask_leader）
  | 'review'       // 待审查
  | 'completed'    // 完成
  | 'failed'       // 失败
  | 'cancelled';   // 取消

export type TaskKind =
  | 'user_request'   // 层1: 用户原始请求
  | 'mission'        // 层2: Assistant 分析后的执行目标
  | 'leader_phase'   // 层3: Leader 阶段（分析/规划/执行/审查）
  | 'worker_task';   // 层4: Worker 子任务

export type TaskPhase =
  | 'analyzing'      // 分析代码/需求
  | 'planning'       // 拆分子任务
  | 'executing'      // 子任务执行中
  | 'reviewing'      // 审查产出
  | 'delivering';    // 汇总交付

export interface TaskRecord {
  id: string;
  workspacePath: string;
  sessionId: string | null;
  agentId: string | null;
  agentRole: string | null;
  teamId: string | null;
  title: string;
  description: string | null;
  state: TaskState;
  priority: number;
  createdAt: number;
  updatedAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  parentTaskId: string | null;
  metadata: any | null;
  blockedReason: string | null;
  escalationId: string | null;
  reviewScore: number | null;
  progressPct: number | null;
  progressMsg: string | null;
  toolCalls: number;
  lastTool: string | null;
  source: string;
  kind: TaskKind;
  leaderPid: string | null;
  phase: TaskPhase | null;
}

export interface CreateTaskOpts {
  id?: string;
  sessionId?: string;
  agentId?: string;
  teamId?: string;
  title: string;
  description?: string;
  priority?: number;
  parentTaskId?: string;
  metadata?: any;
  kind?: TaskKind;
  leaderPid?: string;
  phase?: TaskPhase;
}

interface TaskRow {
  id: string;
  workspace_path: string;
  session_id: string | null;
  agent_id: string | null;
  agent_role: string | null;
  team_id: string | null;
  title: string;
  description: string | null;
  state: string;
  priority: number;
  created_at: number;
  updated_at: number;
  assigned_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  parent_task_id: string | null;
  metadata: string | null;
  blocked_reason: string | null;
  escalation_id: string | null;
  review_score: number | null;
  progress_pct: number | null;
  progress_msg: string | null;
  tool_calls: number | null;
  last_tool: string | null;
  source: string | null;
  kind: string | null;
  leader_pid: string | null;
  phase: string | null;
}

// ============================================================================
// TaskStore
// ============================================================================

export class TaskStore {
  private db: NeoxDatabase;
  private workspacePath: string;

  constructor(db: NeoxDatabase, workspacePath: string) {
    this.db = db;
    this.workspacePath = workspacePath;
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  createTask(opts: CreateTaskOpts): string {
    const id = opts.id || `task-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.raw().prepare(`
      INSERT OR REPLACE INTO tasks
        (id, workspace_path, session_id, agent_id, team_id, title, description,
         state, priority, created_at, updated_at, parent_task_id, metadata,
         kind, leader_pid, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.workspacePath,
      opts.sessionId || null,
      opts.agentId || null,
      opts.teamId || null,
      opts.title,
      opts.description || null,
      opts.priority ?? 0,
      now,
      now,
      opts.parentTaskId || null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.kind || 'worker_task',
      opts.leaderPid || null,
      opts.phase || null,
    );
    return id;
  }

  assignTask(taskId: string, agentId: string): void {
    this.raw().prepare(
      "UPDATE tasks SET agent_id = ?, state = 'assigned', updated_at = ? WHERE id = ?"
    ).run(agentId, Date.now(), taskId);
  }

  updateState(taskId: string, state: TaskState, result?: string): void {
    const now = Date.now();
    const parts = ['state = ?', 'updated_at = ?'];
    const values: any[] = [state, now];

    if (result !== undefined) { parts.push('result = ?'); values.push(result); }
    if (state === 'running') { parts.push('started_at = COALESCE(started_at, ?)'); values.push(now); }
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      parts.push('completed_at = ?'); values.push(now);
    }

    values.push(taskId);
    this.raw().prepare(`UPDATE tasks SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  // ==========================================================================
  // ==========================================================================

  /** Leader 认领任务 */
  claimTask(taskId: string, leaderId: string): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'claimed', agent_id = ?, assigned_at = ?, updated_at = ? WHERE id = ?"
    ).run(leaderId, Date.now(), Date.now(), taskId);
  }

  /** 标记任务为阻塞（ask_leader 时） */
  blockTask(taskId: string, reason: string, escalationId?: string): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'blocked', blocked_reason = ?, escalation_id = ?, updated_at = ? WHERE id = ?"
    ).run(reason, escalationId || null, Date.now(), taskId);
  }

  /** 解除阻塞（reply_to_worker 后） */
  unblockTask(taskId: string): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'running', blocked_reason = NULL, escalation_id = NULL, updated_at = ? WHERE id = ?"
    ).run(Date.now(), taskId);
  }

  /** 提交审查 */
  submitForReview(taskId: string, result: string): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'review', result = ?, updated_at = ? WHERE id = ?"
    ).run(result, Date.now(), taskId);
  }

  /** 通过审查 */
  approveTask(taskId: string, score: number): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'completed', review_score = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(score, Date.now(), Date.now(), taskId);
  }

  /** 要求返工 */
  requestRevision(taskId: string): void {
    this.raw().prepare(
      "UPDATE tasks SET state = 'running', updated_at = ? WHERE id = ?"
    ).run(Date.now(), taskId);
  }

  /** 更新进度 */
  updateProgress(taskId: string, updates: {
    toolCalls?: number;
    lastTool?: string;
    progressPct?: number;
    progressMsg?: string;
  }): void {
    const parts = ['updated_at = ?'];
    const values: any[] = [Date.now()];
    if (updates.toolCalls !== undefined) { parts.push('tool_calls = ?'); values.push(updates.toolCalls); }
    if (updates.lastTool !== undefined) { parts.push('last_tool = ?'); values.push(updates.lastTool); }
    if (updates.progressPct !== undefined) { parts.push('progress_pct = ?'); values.push(updates.progressPct); }
    if (updates.progressMsg !== undefined) { parts.push('progress_msg = ?'); values.push(updates.progressMsg); }
    values.push(taskId);
    this.raw().prepare(`UPDATE tasks SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  /** 拆分任务为子任务（返回子任务 ID 列表） */
  decomposeTask(parentTaskId: string, subtasks: Array<{
    title: string;
    description?: string;
    priority?: number;
    sessionId?: string;
    teamId?: string;
  }>): string[] {
    const now = Date.now();
    // 标记父任务为 decomposed
    this.raw().prepare(
      "UPDATE tasks SET state = 'decomposed', updated_at = ? WHERE id = ?"
    ).run(now, parentTaskId);

    // 创建子任务
    const ids: string[] = [];
    for (const sub of subtasks) {
      const id = this.createTask({
        title: sub.title,
        description: sub.description,
        priority: sub.priority,
        sessionId: sub.sessionId,
        teamId: sub.teamId,
        parentTaskId,
        metadata: { source: 'leader_decompose' },
      });
      ids.push(id);
    }
    return ids;
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  getTask(taskId: string): TaskRecord | null {
    const row = this.raw().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getTasksBySession(sessionId: string): TaskRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM tasks WHERE workspace_path = ? AND session_id = ? ORDER BY priority DESC, created_at'
    ).all(this.workspacePath, sessionId) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getTasksByAgent(agentId: string): TaskRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM tasks WHERE workspace_path = ? AND agent_id = ? ORDER BY created_at'
    ).all(this.workspacePath, agentId) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getTasksByTeam(teamId: string): TaskRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM tasks WHERE workspace_path = ? AND team_id = ? ORDER BY priority DESC, created_at'
    ).all(this.workspacePath, teamId) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getSubtasks(parentTaskId: string): TaskRecord[] {
    const rows = this.raw().prepare(
      'SELECT * FROM tasks WHERE workspace_path = ? AND parent_task_id = ? ORDER BY priority DESC, created_at'
    ).all(this.workspacePath, parentTaskId) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getResumableTasks(sessionId?: string): TaskRecord[] {
    if (sessionId) {
      const rows = this.raw().prepare(
        "SELECT * FROM tasks WHERE workspace_path = ? AND session_id = ? AND state IN ('pending', 'claimed', 'assigned', 'running', 'blocked') ORDER BY priority DESC, created_at"
      ).all(this.workspacePath, sessionId) as TaskRow[];
      return rows.map(r => this.toRecord(r));
    }
    const rows = this.raw().prepare(
      "SELECT * FROM tasks WHERE workspace_path = ? AND state IN ('pending', 'claimed', 'assigned', 'running', 'blocked') ORDER BY priority DESC, created_at"
    ).all(this.workspacePath) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getPendingTasks(limit = 20): TaskRecord[] {
    const rows = this.raw().prepare(
      "SELECT * FROM tasks WHERE workspace_path = ? AND state = 'pending' ORDER BY priority DESC, created_at LIMIT ?"
    ).all(this.workspacePath, limit) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getPendingForClaim(limit = 20): TaskRecord[] {
    const rows = this.raw().prepare(
      "SELECT * FROM tasks WHERE workspace_path = ? AND state = 'pending' AND parent_task_id IS NULL ORDER BY priority DESC, created_at LIMIT ?"
    ).all(this.workspacePath, limit) as TaskRow[];
    return rows.map(r => this.toRecord(r));
  }

  getByStatus(sessionId?: string): Record<string, TaskRecord[]> {
    const all = sessionId
      ? this.getTasksBySession(sessionId)
      : this.raw().prepare(
          "SELECT * FROM tasks WHERE workspace_path = ? AND state NOT IN ('cancelled') ORDER BY priority DESC, created_at"
        ).all(this.workspacePath) as TaskRow[];
    const records = sessionId ? all : (all as any[]).map((r: TaskRow) => this.toRecord(r));

    const grouped: Record<string, TaskRecord[]> = {};
    for (const r of records as TaskRecord[]) {
      if (!grouped[r.state]) grouped[r.state] = [];
      grouped[r.state].push(r);
    }
    return grouped;
  }

  getStats(): {
    pending: number;
    claimed: number;
    running: number;
    blocked: number;
    review: number;
    completed: number;
    failed: number;
  } {
    const rows = this.raw().prepare(
      "SELECT state, COUNT(*) as cnt FROM tasks WHERE workspace_path = ? AND state NOT IN ('cancelled') GROUP BY state"
    ).all(this.workspacePath) as Array<{ state: string; cnt: number }>;
    const stats = { pending: 0, claimed: 0, running: 0, blocked: 0, review: 0, completed: 0, failed: 0 };
    for (const r of rows) {
      if (r.state in stats) (stats as any)[r.state] = r.cnt;
    }
    return stats;
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  deleteOld(maxAge: number = 14 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const result = this.raw().prepare(
      "DELETE FROM tasks WHERE workspace_path = ? AND state IN ('completed', 'failed', 'cancelled') AND completed_at < ?"
    ).run(this.workspacePath, cutoff);
    return result.changes;
  }

  markAllRunningAsCancelled(): number {
    const now = Date.now();
    const result = this.raw().prepare(
      "UPDATE tasks SET state = 'cancelled', completed_at = ?, updated_at = ?, result = '进程中断，任务已取消' WHERE state IN ('running', 'blocked', 'assigned', 'claimed', 'pending') AND workspace_path = ?"
    ).run(now, now, this.workspacePath);
    return result.changes;
  }

  cancelByAgentId(agentId: string): number {
    const now = Date.now();
    const result = this.raw().prepare(
      "UPDATE tasks SET state = 'cancelled', completed_at = ?, updated_at = ?, result = '进程被终止' WHERE agent_id = ? AND state IN ('running', 'blocked', 'assigned')"
    ).run(now, now, agentId);
    return result.changes;
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private raw(): NeoxDatabase['db'] {
    return this.db.getRawDb();
  }

  updatePhase(taskId: string, phase: TaskPhase): void {
    this.raw().prepare(
      'UPDATE tasks SET phase = ?, updated_at = ? WHERE id = ?'
    ).run(phase, Date.now(), taskId);
  }

  getTaskTree(rootTaskId: string): TaskRecord & { children: any[] } {
    const root = this.getTask(rootTaskId);
    if (!root) throw new Error(`Task not found: ${rootTaskId}`);
    const children = this.getSubtasks(rootTaskId).map(child => {
      const grandChildren = this.getSubtasks(child.id).map(gc => ({
        ...gc,
        children: this.getSubtasks(gc.id),
      }));
      return { ...child, children: grandChildren };
    });
    return { ...root, children };
  }

  cascadeProgress(taskId: string): void {
    const subtasks = this.getSubtasks(taskId);
    if (subtasks.length === 0) return;
    const completed = subtasks.filter(s => s.state === 'completed').length;
    const running = subtasks.filter(s => s.state === 'running').length;
    const pct = Math.round((completed / subtasks.length) * 100);
    const msg = `${completed}/${subtasks.length} 完成${running > 0 ? `, ${running} 进行中` : ''}`;
    this.updateProgress(taskId, { progressPct: pct, progressMsg: msg });
    // 如果所有子任务都完成了，标记父任务也完成
    if (completed === subtasks.length) {
      this.updateState(taskId, 'completed', `所有 ${subtasks.length} 个子任务已完成`);
      const task = this.getTask(taskId);
      if (task?.parentTaskId) {
        this.cascadeProgress(task.parentTaskId);
      }
    }
  }

  getActiveRootTasks(sessionId?: string): TaskRecord[] {
    const sql = sessionId
      ? "SELECT * FROM tasks WHERE workspace_path = ? AND session_id = ? AND kind IN ('user_request', 'mission') AND state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC"
      : "SELECT * FROM tasks WHERE workspace_path = ? AND kind IN ('user_request', 'mission') AND state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC";
    const params = sessionId ? [this.workspacePath, sessionId] : [this.workspacePath];
    return (this.raw().prepare(sql).all(...params) as TaskRow[]).map(r => this.toRecord(r));
  }

  getTaskTrees(limit = 20): Array<TaskRecord & { children: any[] }> {
    // 查找所有无父任务的根任务
    const roots = this.raw().prepare(
      "SELECT * FROM tasks WHERE workspace_path = ? AND parent_task_id IS NULL AND state NOT IN ('cancelled') ORDER BY created_at DESC LIMIT ?"
    ).all(this.workspacePath, limit) as TaskRow[];
    return roots.map(r => this.buildTreeNode(this.toRecord(r)));
  }

  /** 递归构建任务树节点 */
  private buildTreeNode(task: TaskRecord): TaskRecord & { children: any[] } {
    const children = this.getSubtasks(task.id);
    return {
      ...task,
      children: children.map(c => this.buildTreeNode(c)),
    };
  }

  private toRecord(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentRole: row.agent_role || null,
      teamId: row.team_id,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignedAt: row.assigned_at || null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      result: row.result,
      parentTaskId: row.parent_task_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      blockedReason: row.blocked_reason || null,
      escalationId: row.escalation_id || null,
      reviewScore: row.review_score || null,
      progressPct: row.progress_pct || null,
      progressMsg: row.progress_msg || null,
      toolCalls: row.tool_calls || 0,
      lastTool: row.last_tool || null,
      source: row.source || 'user',
      kind: (row.kind || 'worker_task') as TaskKind,
      leaderPid: row.leader_pid || null,
      phase: (row.phase || null) as TaskPhase | null,
    };
  }
}
