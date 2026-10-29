/**
 * work:Q-12 任务文件夹名由模型生成, 异步回填
 * ══════════════════════════════════════════════════════════════════════════
 *   首条消息发出时文件夹必须马上有 (agent 这一轮就往里写), 所以先用启发式名字
 *   (`taskFolderTitle`: 首句截 20 字) 建好, 发送不等模型。
 *
 *   同时会话标题 side-agent 会用模型生成一个更准的名字 —— 标题到了就排进队列,
 *   但**不在跑任务的中途改名**: runtime 这一轮持有的工作目录是旧绝对路径, 中途改名
 *   会让后面所有相对路径解析失败。所以只在两个安全时刻落盘:
 *     · 这一轮跑完 (run_result)
 *     · 下一轮发送前 (ensureWorkTaskDir 之前)
 *
 *   改名只做一次 (app_state 标记), 后面标题再变也不动 —— 用户已经认下这个名字了。
 *   任何一步失败 (文件夹被删 / 目标已存在 / rename 报错) 都静默保持原名。
 */
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { pickFreeDir, taskFolderTitle } from './workTaskDir.js';

export interface TaskDirRenameDeps {
  exists(p: string): boolean;
  rename(from: string, to: string): void;
  getTaskDir(sessionId: string): string | null;
  setTaskDir(sessionId: string, dir: string | null): void;
  isNamed(sessionId: string): boolean;
  markNamed(sessionId: string): void;
  now(): Date;
  notify(): void;
}

export type RenameSkipReason =
  | 'no-task-dir'      // 不是 Work 任务 (没建文件夹 / 只在项目里没建)
  | 'already-named'    // 已经回填过, 不再改
  | 'empty-title'      // 模型给的名字清洗后为空
  | 'missing'          // 文件夹被用户删了 —— 不复活
  | 'failed';          // rename 出错

export interface RenameOutcome {
  renamed: boolean;
  dir?: string;
  reason?: RenameSkipReason;
}

const NAMED_KEY = (sessionId: string) => `task_dir_named:${sessionId}`;

const defaultDeps: TaskDirRenameDeps = {
  exists: existsSync,
  rename: (from, to) => renameSync(from, to),
  getTaskDir: (sessionId) => {
    try { return getDatabase().getSessionTaskDir(sessionId); } catch { return null; }
  },
  setTaskDir: (sessionId, dir) => {
    try { getDatabase().setSessionTaskDir(sessionId, dir); } catch { /* 静默: 下次刷新重拉 */ }
  },
  isNamed: (sessionId) => {
    try { return getDatabase().getAppState<boolean>(NAMED_KEY(sessionId)) === true; } catch { return false; }
  },
  markNamed: (sessionId) => {
    try { getDatabase().setAppState(NAMED_KEY(sessionId), true); } catch { /* 静默 */ }
  },
  now: () => new Date(),
  notify: () => {
    void import('../mobile-bridge/index.js')
      .then((m) => m.notifyDesktopSessionsChanged())
      .catch(() => { /* 侧栏下次刷新也会到 */ });
  },
};

/** 标题到了先排队; 真正改名等 run_result / 下次发送 */
const pending = new Map<string, string>();

export function queueTaskDirRename(sessionId: string, title: string): void {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!sessionId || !t) return;
  pending.set(sessionId, t);
}

export function hasPendingTaskDirRename(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** 只用于测试 */
export function resetTaskDirRenameQueue(): void {
  pending.clear();
}

/**
 * 名字: 保留原文件夹的日期前缀 (排序不乱), 换上模型给的名字。
 * 名字清洗后为空 (纯标点 / 全是不认的字符) → null, 保持原名。
 */
export function nextTaskDirName(currentDir: string, title: string, now: Date): string | null {
  const clean = taskFolderTitle(title);
  if (!clean || clean === '任务') return null;
  const base = path.basename(currentDir);
  const datePrefix = /^\d{4}-\d{2}-\d{2}\s/.exec(base)?.[0]
    ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `;
  return `${datePrefix}${clean}`;
}

/** 立即按标题改名 (调用方负责挑安全时刻) */
export function applyTaskDirTitle(
  sessionId: string,
  title: string,
  deps: TaskDirRenameDeps = defaultDeps,
): RenameOutcome {
  try {
    const current = deps.getTaskDir(sessionId);
    if (!current || /[\\/]$/.test(current)) return { renamed: false, reason: 'no-task-dir' };
    if (deps.isNamed(sessionId)) return { renamed: false, reason: 'already-named' };
    if (!deps.exists(current)) return { renamed: false, reason: 'missing' };

    const name = nextTaskDirName(current, title, deps.now());
    if (!name) return { renamed: false, reason: 'empty-title' };

    const parent = path.dirname(current);
    if (path.basename(current) === name) {
      deps.markNamed(sessionId);
      return { renamed: false, dir: current, reason: 'already-named' };
    }
    const target = pickFreeDir(parent, name, deps.exists);
    deps.rename(current, target);
    deps.setTaskDir(sessionId, target);
    deps.markNamed(sessionId);
    deps.notify();
    return { renamed: true, dir: target };
  } catch (err) {
    console.warn('[taskDirNaming] 回填文件夹名失败, 保持原名:', err);
    return { renamed: false, reason: 'failed' };
  }
}

/** 把排队的名字落盘 (有才做); 返回是否改了名 */
export function flushTaskDirRenames(
  sessionId: string,
  deps: TaskDirRenameDeps = defaultDeps,
): RenameOutcome {
  const title = pending.get(sessionId);
  if (!title) return { renamed: false, reason: 'empty-title' };
  pending.delete(sessionId);
  return applyTaskDirTitle(sessionId, title, deps);
}
