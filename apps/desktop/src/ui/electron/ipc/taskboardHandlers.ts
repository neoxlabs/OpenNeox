
import { ipcMain } from './ipcMainBridged.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';

interface TaskBoardLike {
  getBoard(sessionId?: string): any[];
  getTaskTrees(limit: number): any[];
  getStats(): Record<string, number>;
}

/**
 * 获取 TaskBoard 实例 — assistant 删除后无 AssistantSession 进程管理器,
 * 直接返 null, 走下面 getTasksDirectFromDB() 的 SQLite fallback。
 */
function getTaskBoardFromPM(): TaskBoardLike | null {
  return null;
}

function getTasksDirectFromDB(): any[] {
  try {
    const db = new NeoxDatabase();
    const rawDb = db.getRawDb();
    
    // 检查 tasks 表是否存在
    const tableExists = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get();
    if (!tableExists) return [];

    const rows = rawDb.prepare(
      "SELECT * FROM tasks WHERE state NOT IN ('cancelled') ORDER BY priority DESC, created_at DESC LIMIT 100"
    ).all() as any[];

    return rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      priority: row.priority || 1,
      source: row.source || 'user',
      agentId: row.agent_id,
      agentRole: row.agent_role,
      teamId: row.team_id,
      sessionId: row.session_id,
      parentTaskId: row.parent_task_id,
      createdAt: row.created_at,
      assignedAt: row.assigned_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
      toolCalls: row.tool_calls || 0,
      lastTool: row.last_tool,
      progressPct: row.progress_pct,
      progressMsg: row.progress_msg,
      blockedReason: row.blocked_reason,
      escalationId: row.escalation_id,
      result: row.result,
      error: row.state === 'failed' ? (row.result || 'Unknown error') : null,
      reviewScore: row.review_score,
      subtaskCount: 0,
      subtaskCompleted: 0,
      metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : null,
      kind: row.kind || 'worker_task',
      leaderPid: row.leader_pid || null,
      phase: row.phase || null,
    }));
  } catch (err: any) {
    cliLogger.warn('TASKBOARD_IPC', `Direct DB fallback failed: ${err.message}`);
    return [];
  }
}

function getTaskTreesDirectFromDB(): any[] {
  try {
    const allTasks = getTasksDirectFromDB();
    if (allTasks.length === 0) return [];

    // 构建 id → task 映射
    const taskMap = new Map<string, any>();
    for (const t of allTasks) {
      taskMap.set(t.id, { ...t, children: [] });
    }

    // 构建树
    const roots: any[] = [];
    for (const t of allTasks) {
      const node = taskMap.get(t.id)!;
      if (t.parentTaskId && taskMap.has(t.parentTaskId)) {
        taskMap.get(t.parentTaskId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  } catch (err: any) {
    cliLogger.warn('TASKBOARD_IPC', `getTaskTreesDirectFromDB failed: ${err.message}`);
    return [];
  }
}

function getStatsDirectFromDB(): any {
  try {
    const db = new NeoxDatabase();
    const rawDb = db.getRawDb();
    
    const tableExists = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get();
    if (!tableExists) return null;

    const rows = rawDb.prepare(
      "SELECT state, COUNT(*) as cnt FROM tasks WHERE state NOT IN ('cancelled') GROUP BY state"
    ).all() as any[];
    
    const stats = { pending: 0, claimed: 0, running: 0, blocked: 0, review: 0, completed: 0, failed: 0 };
    for (const r of rows) {
      if (r.state in stats) (stats as any)[r.state] = r.cnt;
    }
    return stats;
  } catch {
    return null;
  }
}

export function registerTaskBoardIpcHandlers(): void {
  /**
   * 获取任务看板数据（完整列表）
   */
  ipcMain.handle('taskboard:get-board', async (_event, sessionId?: string) => {
    try {
      // 1. 优先：ProcessManager 的 TaskBoard（runtime 已初始化）
      const taskBoard = getTaskBoardFromPM();
      cliLogger.info('TASKBOARD_IPC', `getBoard: PM taskBoard=${!!taskBoard}, sessionId=${sessionId || 'none'}`);
      if (taskBoard) {
        const data = taskBoard.getBoard(sessionId);
        cliLogger.info('TASKBOARD_IPC', `getBoard: PM returned ${data.length} tasks`);
        if (data.length > 0) return data;
        // 如果 getBoard 返回空结果，可能是 workspacePath 不一致 → 用 fallback
      }

      // 2. Fallback: 直接从 SQLite 读取（不过滤 workspacePath）
      const dbTasks = getTasksDirectFromDB();
      cliLogger.info('TASKBOARD_IPC', `getBoard: DB fallback returned ${dbTasks.length} tasks`);
      return dbTasks;
    } catch (err: any) {
      cliLogger.warn('TASKBOARD_IPC', `getBoard failed: ${err.message}`);
      return [];
    }
  });

  ipcMain.handle('taskboard:get-trees', async () => {
    try {
      const taskBoard = getTaskBoardFromPM();
      if (taskBoard) {
        const trees = taskBoard.getTaskTrees(20);
        if (trees.length > 0) return trees;
      }
      // DB fallback（不过滤 workspacePath）
      const dbTrees = getTaskTreesDirectFromDB();
      cliLogger.info('TASKBOARD_IPC', `getTaskTrees: PM empty, DB fallback returned ${dbTrees.length} trees`);
      return dbTrees;
    } catch (err: any) {
      cliLogger.warn('TASKBOARD_IPC', `getTaskTrees failed: ${err.message}`);
      return [];
    }
  });

  /**
   * 获取任务统计数据
   */
  ipcMain.handle('taskboard:get-stats', async () => {
    try {
      const taskBoard = getTaskBoardFromPM();
      if (taskBoard) {
        const stats = taskBoard.getStats();
        const total = Object.values(stats).reduce((a, b) => a + b, 0);
        if (total > 0) return stats;
      }

      return getStatsDirectFromDB();
    } catch {
      return null;
    }
  });

  ipcMain.handle('taskboard:clear-all', async () => {
    try {
      // 1. 清空 ProcessManager 的 TaskBoard 内存
      const taskBoard = getTaskBoardFromPM();
      
      // 2. 直接清空 SQLite tasks 表
      const db = new NeoxDatabase();
      const rawDb = db.getRawDb();
      const tableExists = rawDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
      ).get();
      if (tableExists) {
        const result = rawDb.prepare("DELETE FROM tasks").run();
        cliLogger.info('TASKBOARD_IPC', `clearAll: Deleted ${result.changes} tasks from SQLite`);
        return { success: true, deleted: result.changes };
      }
      return { success: true, deleted: 0 };
    } catch (err: any) {
      cliLogger.warn('TASKBOARD_IPC', `clearAll failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  });
}
