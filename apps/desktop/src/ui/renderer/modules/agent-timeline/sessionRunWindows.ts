/**
 * sessionRunWindows — 各会话「在跑」的时间段, 给 shell_proc 回收判断「同文件夹里有没有别的会话也在写」.
 *
 * fs 事件不带来源进程, 同一个文件夹里两个会话一起跑时, A 的 shell 时间窗会收到 B 写出的文件,
 * 「本轮改动」和图片墙就混进别的会话的产物。这里记下每个会话的运行区间 + 所在文件夹,
 * 回收时有重叠就收紧 (见 shellProcRecovery)。
 *
 * 写入点只有一个: NeoxRuntimeBridge 的 syncRunningSessionIds (侧栏转圈的同一个真相源)。
 */

interface RunWindow {
  start: number;
  end?: number;
  /** 未知 (会话列表里还没有) 时按「可能同文件夹」处理 */
  workspacePath?: string;
}

const windows = new Map<string, RunWindow[]>();
const KEEP_MS = 6 * 60 * 60 * 1000;
const MAX_PER_SESSION = 50;

function normRoot(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

export function noteSessionRunState(
  sessionId: string,
  running: boolean,
  workspacePath?: string,
  ts: number = Date.now(),
): void {
  if (!sessionId) return;
  const list = windows.get(sessionId) ?? [];
  const open = list.length > 0 && list[list.length - 1].end === undefined ? list[list.length - 1] : null;
  if (running) {
    if (open) {
      if (!open.workspacePath && workspacePath) open.workspacePath = workspacePath;
      return;
    }
    list.push({ start: ts, workspacePath });
  } else {
    if (!open) return;
    open.end = ts;
  }
  const cutoff = ts - KEEP_MS;
  while (list.length > 0 && list[0].end !== undefined && (list[0].end as number) < cutoff) list.shift();
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  windows.set(sessionId, list);
}

/** [startTs, endTs] 内, 同文件夹 (或文件夹未知) 里有没有别的会话在跑 */
export function hasConcurrentSessionInWorkspace(
  sessionId: string,
  workspacePath: string | undefined,
  startTs: number,
  endTs: number,
): boolean {
  const root = workspacePath ? normRoot(workspacePath) : '';
  for (const [sid, list] of windows) {
    if (sid === sessionId) continue;
    for (const w of list) {
      const wEnd = w.end ?? Number.POSITIVE_INFINITY;
      if (w.start > endTs || wEnd < startTs) continue;
      if (!root || !w.workspacePath || normRoot(w.workspacePath) === root) return true;
    }
  }
  return false;
}

/** 会话自己所在的文件夹 (最近一次运行记下的)。流处理钩子拿到的 workspacePath 是**界面当前**
 *  的工作区 —— 后台会话跑完时用户可能已切到别的项目, 拿它去筛 fs 事件就会把别的项目的产物收进来。 */
export function getSessionRunWorkspace(sessionId: string): string | undefined {
  const list = windows.get(sessionId);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].workspacePath) return list[i].workspacePath;
  }
  return undefined;
}

/** 测试用 */
export function resetSessionRunWindows(): void {
  windows.clear();
}
