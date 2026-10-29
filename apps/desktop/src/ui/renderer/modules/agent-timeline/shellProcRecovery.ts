/**
 * shellProcRecovery — Shell 进程树写回收（第三路声明）.
 *
 * 不是整仓时间窗 membership：只在「本条 shell 的 [start,end]」内收 add/unlink,
 * 且仓储/安装类命令关闭回收。结果写成 WriteDeclaration(evidence=shell_proc),
 * 由调用方写入 ledger + timeline entry.declaredPaths.
 */

import {
  getAllWriteDeclarations,
  isBulkWorkspaceMutationCommand,
  type WriteDeclaration,
} from '@neoxlabs/kernel/core/writeLedger.js';
import { getFsEventsBetween, type WorkspaceFsEvent } from '../../state/workspaceFsEventLog';
import { isPseudoEllipsisPath, resolveWorkspacePath } from '../../utils/pathUtils';
import { hasConcurrentSessionInWorkspace } from './sessionRunWindows';

const RUNTIME_ARTIFACT_RE =
  /(^|\/)(\.git|node_modules|\.next|\.turbo|coverage|dist|build)\//i;
const RUNTIME_ARTIFACT_FILE_RE =
  /(\.db|\.db-wal|\.db-shm|\.sqlite3?|\.sqlite-wal|\.sqlite-shm|\.log|\.pid|\.swp|\.tmp)$|(^|\/)\.DS_Store$|(^|\/)(\.neox-tmp[^/]*|\.goutputstream-[^/]*|~\$[^/]*)$/i;

function isRuntimeArtifact(p: string): boolean {
  return RUNTIME_ARTIFACT_RE.test(p) || RUNTIME_ARTIFACT_FILE_RE.test(p);
}

function underWorkspace(absPath: string, workspacePath?: string): boolean {
  if (!workspacePath) return true;
  const root = workspacePath.replace(/\/+$/, '');
  const p = absPath.replace(/\/+$/, '');
  return p === root || p.startsWith(root + '/') || p.startsWith(root + '\\');
}

function canonicalPath(rawPath: string, workspacePath?: string): string {
  if (!rawPath) return rawPath;
  if (isPseudoEllipsisPath(rawPath)) return rawPath.replace(/^\.\.\.\//, '…/');
  return resolveWorkspacePath(rawPath, workspacePath);
}

function commandMentionsPath(command: string, absPath: string, workspacePath?: string): boolean {
  const root = workspacePath ? workspacePath.replace(/[\\/]+$/, '') : '';
  const rel = root && absPath.startsWith(root) ? absPath.slice(root.length).replace(/^[\\/]+/, '') : '';
  const base = absPath.split(/[\\/]/).pop() || '';
  if (rel && command.includes(rel)) return true;
  return !!base && command.includes(base);
}

export function recoverShellProcDeclarations(opts: {
  sessionId: string;
  toolCallId: string;
  toolName?: string;
  command: string;
  startTs: number;
  endTs: number;
  workspacePath?: string;
  /** 测试注入; 默认读 workspaceFsEventLog */
  fsEvents?: WorkspaceFsEvent[];
  /** 单次 shell 回收硬顶 — 防异常刷盘, 不是 membership 主闸 */
  maxPaths?: number;
  /** 测试注入; 默认查 sessionRunWindows */
  concurrent?: boolean;
}): WriteDeclaration[] {
  const {
    sessionId,
    toolCallId,
    toolName = 'execute_shell',
    command,
    startTs,
    endTs,
    workspacePath,
    maxPaths = 40,
  } = opts;

  if (!sessionId || !toolCallId) return [];
  if (isBulkWorkspaceMutationCommand(command)) return [];

  const slack = 300;
  const events = opts.fsEvents
    ?? getFsEventsBetween(startTs, endTs + slack);

  const byPath = new Map<string, 'add' | 'change' | 'unlink'>();
  for (const ev of events) {
    if (ev.kind === 'addDir' || ev.kind === 'unlinkDir') continue;
    if (ev.kind !== 'add' && ev.kind !== 'unlink') continue; /* 只收新建/删除, 不收无关 change */
    if (isRuntimeArtifact(ev.path)) continue;
    const p = canonicalPath(ev.path, workspacePath);
    if (!underWorkspace(p, workspacePath)) continue;
    byPath.set(p, ev.kind);
  }

  /* 别的会话已声明过的路径 —— 那是它的作品, 不归这条 shell */
  if (byPath.size > 0) {
    for (const d of getAllWriteDeclarations()) {
      if (d.sessionId === sessionId) continue;
      for (const raw of d.paths) byPath.delete(canonicalPath(raw, workspacePath));
    }
  }

  /* 同文件夹里另有会话在跑: 时间窗里的新文件分不清是谁写的,
   * 只留命令里点了名的 (完整相对路径或文件名出现在命令文本里) */
  const concurrent = opts.concurrent
    ?? hasConcurrentSessionInWorkspace(sessionId, workspacePath, startTs, endTs + slack);
  if (concurrent && byPath.size > 0) {
    for (const p of Array.from(byPath.keys())) {
      if (!commandMentionsPath(command, p, workspacePath)) byPath.delete(p);
    }
  }

  const writes: string[] = [];
  const deletes: string[] = [];
  for (const [p, kind] of byPath) {
    if (kind === 'unlink') deletes.push(p);
    else writes.push(p);
  }

  const decls: WriteDeclaration[] = [];
  const ts = endTs || Date.now();

  if (writes.length > 0) {
    const paths = writes.slice(0, maxPaths);
    decls.push({
      sessionId,
      toolCallId,
      toolName,
      op: 'write',
      paths,
      ts,
      evidence: 'shell_proc',
    });
  }
  if (deletes.length > 0) {
    const paths = deletes.slice(0, maxPaths);
    decls.push({
      sessionId,
      toolCallId,
      toolName,
      op: 'delete',
      paths,
      ts,
      evidence: 'shell_proc',
    });
  }
  return decls;
}
