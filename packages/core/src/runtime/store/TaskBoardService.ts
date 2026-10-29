/**
 * TaskBoardService — 统一任务看板服务层
 *
 * 本质：任务池/缓冲区。
 * - Assistant 写入粗略任务 → 通知 Leader
 * - Leader 常驻监听，认领 → 拆分 → 分配 Worker
 * - Worker 执行、更新进度、ask_leader 时标记阻塞
 * - UI 查询看板渲染 Kanban 视图
 *
 * 包装 TaskStore + AgentStore + ProgressStore，提供统一 API。
 * 所有数据写入 SQLite，跨会话、跨重启持久化。
 */

import type { TaskStore, TaskRecord, TaskState, CreateTaskOpts, TaskKind, TaskPhase } from './TaskStore.js';
import type { AgentStore } from './AgentStore.js';
import type { ProgressStore } from './ProgressStore.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 看板项 — UI 用的富化数据结构（合并 task + agent + progress）
// ============================================================================

export interface TaskBoardItem {
  // === 任务核心 ===
  id: string;
  title: string;
  description: string | null;
  state: TaskState;
  priority: number;           // 0=低 1=中 2=高
  source: string;             // 'user' | 'leader' | 'system'

  // === 归属 ===
  agentId: string | null;
  agentRole: string | null;
  teamId: string | null;
  sessionId: string | null;
  parentTaskId: string | null;

  // === 时间线 ===
  createdAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;

  // === 实时进度 ===
  toolCalls: number;
  lastTool: string | null;
  progressPct: number | null;
  progressMsg: string | null;

  // === 升级/阻塞 ===
  blockedReason: string | null;
  escalationId: string | null;

  // === 结果 ===
  result: string | null;
  error: string | null;
  reviewScore: number | null;

  // === 子任务统计 ===
  subtaskCount: number;
  subtaskCompleted: number;

  // === 元数据 ===
  metadata: any | null;

  kind: TaskKind;
  leaderPid: string | null;
  phase: TaskPhase | null;
  children?: TaskBoardItem[];
}

// ============================================================================
// TaskBoardService
// ============================================================================

export class TaskBoardService {
  constructor(
    private taskStore: TaskStore,
    private agentStore: AgentStore,
    private progressStore: ProgressStore,
  ) {}

  // ==========================================================================
  // Assistant 用 — 写入粗略任务
  // ==========================================================================

  /**
   * 创建任务（用户需求经 Assistant 理解后写入看板）
   * 返回 taskId
   */
  createTask(title: string, opts?: {
    description?: string;
    priority?: number;
    sessionId?: string;
    teamId?: string;
    source?: 'user' | 'leader' | 'system';
    metadata?: any;
    kind?: TaskKind;
    leaderPid?: string;
    phase?: TaskPhase;
    parentTaskId?: string;
  }): string {
    const taskId = this.taskStore.createTask({
      title,
      description: opts?.description,
      priority: opts?.priority ?? 1,
      sessionId: opts?.sessionId,
      teamId: opts?.teamId,
      parentTaskId: opts?.parentTaskId,
      kind: opts?.kind || 'worker_task',
      leaderPid: opts?.leaderPid,
      phase: opts?.phase,
      metadata: {
        ...(opts?.metadata || {}),
        source: opts?.source || 'user',
      },
    });

    cliLogger.info('TASKBOARD', `任务创建: [${taskId}] "${title}" kind=${opts?.kind || 'worker_task'} (P:${opts?.priority ?? 1})`);
    return taskId;
  }

  // ==========================================================================
  // ==========================================================================

  /** 层1: 用户请求 → 根任务 */
  createRootTask(userMessage: string, sessionId: string): string {
    return this.createTask(userMessage.slice(0, 200), {
      kind: 'user_request',
      source: 'user',
      sessionId,
      priority: 1,
    });
  }

  /** 层2: Assistant 决策 → Mission 任务（挂在根任务下） */
  createMissionTask(goal: string, opts: {
    rootTaskId?: string;
    teamId?: string;
    sessionId?: string;
  }): string {
    const taskId = this.createTask(goal.slice(0, 200), {
      kind: 'mission',
      source: 'system',
      parentTaskId: opts.rootTaskId,
      teamId: opts.teamId,
      sessionId: opts.sessionId,
      priority: 1,
    });
    // 标记为 running
    this.taskStore.updateState(taskId, 'running');
    return taskId;
  }

  /** 层3: Leader 任务（挂在 Mission 下） */
  createLeaderTask(task: string, opts: {
    missionTaskId?: string;
    teamId?: string;
    sessionId?: string;
    leaderPid?: string;
  }): string {
    const taskId = this.createTask(task.slice(0, 200), {
      kind: 'leader_phase',
      source: 'leader',
      parentTaskId: opts.missionTaskId,
      teamId: opts.teamId,
      sessionId: opts.sessionId,
      leaderPid: opts.leaderPid,
      phase: 'analyzing',
      priority: 1,
    });
    // 标记为 running
    this.taskStore.updateState(taskId, 'running');
    return taskId;
  }

  /** 更新 Leader 阶段 */
  updateLeaderPhase(taskId: string, phase: TaskPhase): void {
    this.taskStore.updatePhase(taskId, phase);
    cliLogger.info('TASKBOARD', `Leader 阶段更新: [${taskId}] → ${phase}`);
  }

  /** 级联更新父任务进度 */
  cascadeProgress(taskId: string): void {
    this.taskStore.cascadeProgress(taskId);
  }

  // ==========================================================================
  // Leader 用 — 认领、拆分、分配
  // ==========================================================================

  /** 认领任务 */
  claimTask(taskId: string, leaderId: string): boolean {
    const task = this.taskStore.getTask(taskId);
    if (!task || task.state !== 'pending') {
      cliLogger.warn('TASKBOARD', `无法认领 ${taskId}: 状态=${task?.state || '不存在'}`);
      return false;
    }
    this.taskStore.claimTask(taskId, leaderId);
    cliLogger.info('TASKBOARD', `Leader ${leaderId} 认领任务: [${taskId}] "${task.title}"`);
    return true;
  }

  /** 拆分任务为子任务 */
  decomposeTask(taskId: string, subtasks: Array<{
    title: string;
    description?: string;
    priority?: number;
  }>): string[] {
    const task = this.taskStore.getTask(taskId);
    if (!task) {
      cliLogger.warn('TASKBOARD', `拆分失败: ${taskId} 不存在`);
      return [];
    }

    const ids = this.taskStore.decomposeTask(taskId, subtasks.map(s => ({
      ...s,
      sessionId: task.sessionId || undefined,
      teamId: task.teamId || undefined,
    })));

    cliLogger.info('TASKBOARD', `任务 [${taskId}] 拆分为 ${ids.length} 个子任务: ${ids.join(', ')}`);
    return ids;
  }

  /** 分配子任务给 Worker */
  assignTask(taskId: string, agentId: string, agentRole?: string): void {
    this.taskStore.assignTask(taskId, agentId);
    // 更新 agent_role
    if (agentRole) {
      this.taskStore['raw']().prepare(
        'UPDATE tasks SET agent_role = ?, updated_at = ? WHERE id = ?'
      ).run(agentRole, Date.now(), taskId);
    }
    cliLogger.info('TASKBOARD', `分配: [${taskId}] → ${agentId} (${agentRole || 'worker'})`);
  }

  // ==========================================================================
  // Worker 用 — 开始、进度、阻塞
  // ==========================================================================

  /** 标记任务开始执行 */
  startTask(taskId: string): void {
    this.taskStore.updateState(taskId, 'running');
    cliLogger.info('TASKBOARD', `开始执行: [${taskId}]`);
  }

  /** 更新任务进度 */
  updateProgress(taskId: string, updates: {
    toolCalls?: number;
    lastTool?: string;
    progressPct?: number;
    progressMsg?: string;
  }): void {
    this.taskStore.updateProgress(taskId, updates);
  }

  /** 标记任务阻塞（ask_leader 时调用） */
  blockTask(taskId: string, reason: string, escalationId?: string): void {
    this.taskStore.blockTask(taskId, reason, escalationId);
    cliLogger.info('TASKBOARD', `阻塞: [${taskId}] 原因="${reason.slice(0, 60)}"`);
  }

  /** 解除阻塞（reply_to_worker 后调用） */
  unblockTask(taskId: string): void {
    this.taskStore.unblockTask(taskId);
    cliLogger.info('TASKBOARD', `解除阻塞: [${taskId}]`);
  }

  // ==========================================================================
  // Leader 审查
  // ==========================================================================

  /** Worker 提交审查 */
  submitForReview(taskId: string, result: string): void {
    this.taskStore.submitForReview(taskId, result);
    cliLogger.info('TASKBOARD', `提交审查: [${taskId}]`);
  }

  /** 通过审查 */
  approveTask(taskId: string, score: number): void {
    this.taskStore.approveTask(taskId, score);
    cliLogger.info('TASKBOARD', `审查通过: [${taskId}] 评分=${score}`);
  }

  /** 要求返工 */
  requestRevision(taskId: string, feedback: string): void {
    this.taskStore.requestRevision(taskId);
    cliLogger.info('TASKBOARD', `要求返工: [${taskId}] "${feedback.slice(0, 60)}"`);
  }

  /** 标记任务完成 */
  completeTask(taskId: string, result?: string): void {
    this.taskStore.updateState(taskId, 'completed', result);
    cliLogger.info('TASKBOARD', `完成: [${taskId}]`);
  }

  /** 标记任务失败 */
  failTask(taskId: string, error: string): void {
    this.taskStore.updateState(taskId, 'failed', error);
    cliLogger.info('TASKBOARD', `失败: [${taskId}] "${error.slice(0, 60)}"`);
  }

  reopenTask(taskId: string, reason?: string): void {
    this.taskStore.updateState(taskId, 'running', reason);
    cliLogger.info('TASKBOARD', `重新打开: [${taskId}] 原因: ${reason?.slice(0, 60) || '无'}`);
  }

  cleanupOrphaned(): number {
    const count = this.taskStore.markAllRunningAsCancelled();
    if (count > 0) {
      cliLogger.info('TASKBOARD', `清理了 ${count} 个残留任务（running → cancelled）`);
    }
    return count;
  }

  cancelByAgent(agentId: string): number {
    return this.taskStore.cancelByAgentId(agentId);
  }

  // ==========================================================================
  // 查询 — UI + Agent 消费
  // ==========================================================================

  /** 获取单个任务 */
  getTask(taskId: string): TaskBoardItem | null {
    const task = this.taskStore.getTask(taskId);
    if (!task) return null;
    return this.enrichTask(task);
  }

  /** 全量看板（可按 session 过滤） */
  getBoard(sessionId?: string): TaskBoardItem[] {
    // 导致 UI 看板的 "完成" 列永远为空
    const grouped = this.taskStore.getByStatus(sessionId);
    const tasks: TaskBoardItem[] = [];
    for (const stateTasks of Object.values(grouped)) {
      for (const t of stateTasks) {
        tasks.push(this.enrichTask(t));
      }
    }
    return tasks;
  }

  /** 按状态分组（UI Kanban 列用） */
  getBoardByStatus(sessionId?: string): Record<string, TaskBoardItem[]> {
    const grouped = this.taskStore.getByStatus(sessionId);
    const result: Record<string, TaskBoardItem[]> = {};
    for (const [state, tasks] of Object.entries(grouped)) {
      result[state] = tasks.map(t => this.enrichTask(t));
    }
    return result;
  }

  /** 待认领任务（Leader 用） */
  getPendingTasks(): TaskBoardItem[] {
    return this.taskStore.getPendingForClaim().map(t => this.enrichTask(t));
  }

  /** 某 Agent 的任务列表 */
  getAgentTasks(agentId: string): TaskBoardItem[] {
    return this.taskStore.getTasksByAgent(agentId).map(t => this.enrichTask(t));
  }

  /** 某团队的任务列表 */
  getTeamTasks(teamId: string): TaskBoardItem[] {
    return this.taskStore.getTasksByTeam(teamId).map(t => this.enrichTask(t));
  }

  /** 子任务列表 */
  getSubtasks(parentTaskId: string): TaskBoardItem[] {
    return this.taskStore.getSubtasks(parentTaskId).map(t => this.enrichTask(t));
  }

  /** 统计数据 */
  getStats() {
    return this.taskStore.getStats();
  }

  getTaskTrees(limit = 20): TaskBoardItem[] {
    const trees = this.taskStore.getTaskTrees(limit);
    return trees.map(t => this.enrichTreeNode(t));
  }

  /** 递归富化树节点 */
  private enrichTreeNode(node: any): TaskBoardItem {
    const item = this.enrichTask(node);
    if (node.children && node.children.length > 0) {
      item.children = node.children.map((c: any) => this.enrichTreeNode(c));
    }
    return item;
  }

  /**
   * 看板摘要（注入 Agent system prompt）
   * Leader 看到待认领的任务，Worker 看到自己的任务
   */
  getBoardSummary(opts?: {
    sessionId?: string;
    agentId?: string;
    role?: 'leader' | 'worker';
  }): string {
    const stats = this.taskStore.getStats();
    const totalActive = stats.pending + stats.claimed + stats.running + stats.blocked + stats.review;

    if (totalActive === 0) {
      return '📋 任务看板: 当前无活跃任务。';
    }

    const lines: string[] = [
      `📋 任务看板概况: 待办${stats.pending} 进行${stats.running} 阻塞${stats.blocked} 待审${stats.review} 完成${stats.completed}`,
    ];

    // Leader 看待认领的任务
    if (opts?.role === 'leader') {
      const pending = this.taskStore.getPendingForClaim(5);
      if (pending.length > 0) {
        lines.push('⏳ 待认领任务:');
        for (const t of pending) {
          lines.push(`  - [${t.id}] "${t.title}" P:${t.priority}`);
        }
      }

      // 被阻塞的任务
      const blocked = this.taskStore.getResumableTasks(opts.sessionId)
        .filter(t => t.state === 'blocked');
      if (blocked.length > 0) {
        lines.push('🔴 阻塞中:');
        for (const t of blocked) {
          lines.push(`  - [${t.id}] "${t.title}" 原因: ${t.blockedReason?.slice(0, 50)}`);
        }
      }
    }

    // Worker 看自己的任务
    if (opts?.role === 'worker' && opts.agentId) {
      const myTasks = this.taskStore.getTasksByAgent(opts.agentId);
      if (myTasks.length > 0) {
        lines.push('📌 你的任务:');
        for (const t of myTasks) {
          lines.push(`  - [${t.id}] "${t.title}" 状态: ${t.state}`);
        }
      }
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // Internal — 富化 TaskRecord 为 TaskBoardItem
  // ==========================================================================

  private enrichTask(task: TaskRecord): TaskBoardItem {
    // 获取子任务统计
    const subtasks = this.taskStore.getSubtasks(task.id);
    const subtaskCompleted = subtasks.filter(s => s.state === 'completed').length;

    // 获取 Agent 错误信息
    let error: string | null = null;
    if (task.state === 'failed' && task.agentId) {
      const agent = this.agentStore.getAgent(task.agentId);
      error = agent?.error || task.result;
    }

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      state: task.state,
      priority: task.priority,
      source: task.source,
      agentId: task.agentId,
      agentRole: task.agentRole,
      teamId: task.teamId,
      sessionId: task.sessionId,
      parentTaskId: task.parentTaskId,
      createdAt: task.createdAt,
      assignedAt: task.assignedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      toolCalls: task.toolCalls,
      lastTool: task.lastTool,
      progressPct: task.progressPct,
      progressMsg: task.progressMsg,
      blockedReason: task.blockedReason,
      escalationId: task.escalationId,
      result: task.result,
      error,
      reviewScore: task.reviewScore,
      subtaskCount: subtasks.length,
      subtaskCompleted,
      metadata: task.metadata,
      kind: task.kind,
      leaderPid: task.leaderPid,
      phase: task.phase,
    };
  }
}
