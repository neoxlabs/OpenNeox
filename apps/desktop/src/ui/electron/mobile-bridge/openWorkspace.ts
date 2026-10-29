
import { RpcError, RpcErrorCode } from './jsonRpc.js';
import { sameWorkspace } from '../../shared/workspacePath.node.js';

export interface WorkspaceOpener {
  getByPath(path: string): unknown;
  openProject(path: string): Promise<unknown> | unknown;
}

export async function ensureWorkspaceOpen(pm: WorkspaceOpener, workspacePath: string): Promise<boolean> {
  if (pm.getByPath(workspacePath)) return false;
  const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js');
  const knownSessions = await sessionStore.listSessionsSlim(); /* 只用元数据 */
  const isKnownWorkspace = knownSessions.some((s: any) => sameWorkspace(s.workspacePath, workspacePath));
  if (!isKnownWorkspace && !(await isDirectoryInsideHome(workspacePath))) {
    throw new RpcError(RpcErrorCode.PERMISSION_DENIED, '只能打开用户主目录下已存在的文件夹');
  }
  await pm.openProject(workspacePath);
  return true;
}

async function isDirectoryInsideHome(workspacePath: string): Promise<boolean> {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const home = os.homedir();
  const resolved = path.resolve(workspacePath);
  const rel = path.relative(home, resolved);
  const insideHome = resolved === home || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!insideHome) return false;
  try { return (await fs.stat(resolved)).isDirectory(); } catch { return false; }
}
