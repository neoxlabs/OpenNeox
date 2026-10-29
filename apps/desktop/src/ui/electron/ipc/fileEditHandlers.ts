import { ipcMain } from './ipcMainBridged.js';
import * as path from 'path';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeBridgeResolver, makeWorkspaceResolver } from './scopeResolvers.js';
import { storageService } from '../../../platform-electron/storageService.js';

export function validateWorkspacePath(workspacePath: string, filePath: string): string {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedFile = path.resolve(resolvedWorkspace, filePath);
  if (resolvedFile === resolvedWorkspace) return resolvedFile;
  const rel = path.relative(resolvedWorkspace, resolvedFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${filePath} resolves outside workspace`);
  }
  return resolvedFile;
}

export function validateAgainstWorkspaceRoots(
  primaryWorkspace: string,
  filePath: string,
  otherRoots: readonly string[],
): string {
  try {
    return validateWorkspacePath(primaryWorkspace, filePath);
  } catch (primaryErr) {
    const primaryResolved = path.resolve(primaryWorkspace);
    for (const root of otherRoots) {
      /* 比较 resolve 后的值 — 根列表里常带着 '/a/b' 与 '/a/b/' 这类同目录不同写法 */
      if (!root || path.resolve(root) === primaryResolved) continue;
      try {
        return validateWorkspacePath(root, filePath);
      } catch {
        /* 换下一个根 */
      }
    }
    if (path.isAbsolute(filePath)) {
      const roots = [primaryWorkspace, ...otherRoots.filter(r => r && r !== primaryWorkspace)];
      throw new Error(
        `文件不在当前工作区的任何根目录内: ${filePath}\n`
        + `已登记的根: ${roots.join(', ')}\n`
        + `若确实要改它, 先把它所在目录加为工作区根 (侧栏 → 添加文件夹)。`,
      );
    }
    throw primaryErr;   /* 相对路径逃逸 → 保留原始 traversal 措辞 */
  }
}

interface RegisterFileEditIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerFileEditIpcHandlers(options: RegisterFileEditIpcHandlersOptions): void {
  const workspaceOf = makeWorkspaceResolver(options.projectManager);
  const bridgeOf = makeBridgeResolver(options.projectManager);

  const resolveInWorkspace = (workspacePath: string, filePath: string): string =>
    validateAgainstWorkspaceRoots(workspacePath, filePath, storageService.getWorkspaceRootsSync(workspacePath) || []);

  ipcMain.handle('file:revert-edit', async (event, filePath: string, oldString: string, newString: string, mode: 'file' | 'edit' = 'file') => {
    // console.log('[Main] Reverting edit:', { filePath, mode });

    if (mode === 'edit') {
      try {
        const fs = await import('fs/promises');
        const workspacePath = workspaceOf(event);
        if (!workspacePath) {
          return { success: false, error: 'No workspace set' };
        }
        const absolutePath = resolveInWorkspace(workspacePath, filePath);
        // console.log('[Main] Reading file for single edit revert:', absolutePath);
        const content = await fs.readFile(absolutePath, 'utf-8');
        if (!content.includes(newString)) {
          // console.warn('[Main] newString not found in file, cannot revert single edit');
          return { success: false, error: 'Edit content not found in file. The file may have been modified.' };
        }
        const newContent = content.replace(newString, oldString);
        await fs.writeFile(absolutePath, newContent, 'utf-8');
        // console.log('[Main] Successfully reverted single edit');
        return { success: true };
      } catch (error) {
        console.error('[Main] Failed to revert single edit:', error);
        return { success: false, error: String(error) };
      }
    } else {
      /* 整文件撤销走 core 的 RollbackService (EDIT-01) —— 与 CLI /undo、手共用同一实现 */
      return bridgeOf(event).revertFile(filePath);
    }
  });

  ipcMain.handle('file:revert-hunk', async (event, args: {
    filePath: string;
    oldString?: string;
    newString?: string;
    startLine?: number;
  }) => {
    try {
      const { filePath, oldString, newString, startLine } = args || {};
      if (!filePath || typeof oldString !== 'string' || typeof newString !== 'string') {
        return { success: false, error: 'invalid args (likely previewTruncated hunk)' };
      }
      const fs = await import('fs/promises');
      const workspacePath = workspaceOf(event);
      if (!workspacePath) return { success: false, error: 'No workspace set' };
      const absolutePath = resolveInWorkspace(workspacePath, filePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      /* 精准定位策略: 拿 content 按 \n 分行, 计算 startLine 对应的 byte offset,
       *   然后在 [offset_at_startLine - tolerance_bytes, end] 范围内 indexOf newString.
       *   tolerance 算 ±25 行的字节数, 用户手动改动小幅 / 前面 hunk 已 reject 导致
       *   行号漂移都能容下. */
      const LINE_TOLERANCE = 25;
      let searchStart = 0;
      if (typeof startLine === 'number' && startLine > 0) {
        const lines = content.split('\n');
        const anchorLine = Math.max(0, startLine - 1 - LINE_TOLERANCE);
        for (let i = 0; i < anchorLine && i < lines.length; i++) {
          searchStart += lines[i].length + 1; /* +1 for \n */
        }
      }

      const hitIdx = content.indexOf(newString, searchStart);
      if (hitIdx < 0) {
        /* startLine 附近找不到 → 退到全文找一次 (老 hunk 不带 startLine / 行号大幅漂移). */
        const globalIdx = content.indexOf(newString);
        if (globalIdx < 0) {
          return { success: false, error: 'hunk content not found in file (file may have been modified)' };
        }
        const newContent = content.slice(0, globalIdx) + oldString + content.slice(globalIdx + newString.length);
        await fs.writeFile(absolutePath, newContent, 'utf-8');
        return { success: true, matchedAt: globalIdx, anchored: false };
      }

      const newContent = content.slice(0, hitIdx) + oldString + content.slice(hitIdx + newString.length);
      await fs.writeFile(absolutePath, newContent, 'utf-8');
      return { success: true, matchedAt: hitIdx, anchored: true };
    } catch (error: any) {
      console.error('[Main] file:revert-hunk failed:', error);
      return { success: false, error: error?.message ?? String(error) };
    }
  });

  ipcMain.handle('file:reapply-edit', async (event, filePath: string, oldString?: string, newString?: string, mode: 'file' | 'edit' = 'file') => {
    // console.log('[Main] Reapplying edit:', { filePath, mode });

    if (mode === 'edit' && oldString && newString) {
      try {
        const fs = await import('fs/promises');
        const workspacePath = workspaceOf(event);
        if (!workspacePath) {
          return { success: false, error: 'No workspace set' };
        }
        const absolutePath = resolveInWorkspace(workspacePath, filePath);
        // console.log('[Main] Reading file for single edit reapply:', absolutePath);
        const content = await fs.readFile(absolutePath, 'utf-8');
        if (!content.includes(oldString)) {
          // console.warn('[Main] oldString not found in file, cannot reapply single edit');
          return { success: false, error: 'Original content not found in file. The file may have been modified.' };
        }
        const newContent = content.replace(oldString, newString);
        await fs.writeFile(absolutePath, newContent, 'utf-8');
        // console.log('[Main] Successfully reapplied single edit');
        return { success: true };
      } catch (error) {
        console.error('[Main] Failed to reapply single edit:', error);
        return { success: false, error: String(error) };
      }
    } else {
      return bridgeOf(event).reapplyFile(filePath);
    }
  });

  ipcMain.handle('file:delete', async (event, filePath: string) => {
    try {
      const fs = await import('fs/promises');
      const workspacePath = workspaceOf(event);
      if (!workspacePath) {
        return { success: false, error: 'No workspace set' };
      }
      const absolutePath = resolveInWorkspace(workspacePath, filePath);
      await fs.unlink(absolutePath);
      // console.log('[Main] Successfully deleted file:', absolutePath);
      return { success: true };
    } catch (error) {
      console.error('[Main] Failed to delete file:', filePath, error);
      return { success: false, error: String(error) };
    }
  });

  /* 从 write_file 覆盖前存的快照还原整文件 (P0-1).
   * write_file mode='overwrite' 不产生 old/new hunk, 所以内容级 Undo 走不通;
   * 在有快照之前, 这类改动只能依赖默认关闭的 Shadow Git —— 等于没有保护。 */
  ipcMain.handle('file:restore-snapshot', async (event, args: { filePath: string; snapshotId: string }) => {
    try {
      const { filePath, snapshotId } = args || ({} as any);
      if (!filePath || !snapshotId) return { success: false, error: '缺少文件路径或快照 ID' };

      const workspacePath = workspaceOf(event);
      if (!workspacePath) return { success: false, error: 'No workspace set' };
      /* 仍然走工作区边界校验 —— 快照 id 可信不代表目标路径可信 */
      const absolutePath = resolveInWorkspace(workspacePath, filePath);

      const { readFileSnapshot } = await import('@neoxlabs/core/tools/files/fileSnapshotStore.js');
      const content = await readFileSnapshot(snapshotId);
      if (content === null) {
        return { success: false, error: '快照已过期或不存在(默认保留 7 天)' };
      }

      const fs = await import('fs/promises');
      await fs.writeFile(absolutePath, content, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('[Main] Failed to restore snapshot:', args, error);
      return { success: false, error: String(error) };
    }
  });

  /* 撤销 agent 的 delete_file —— 按删除前存的 manifest 把整棵树写回原位 (P0-3).
   * 不做工作区边界校验: 恢复目标路径来自 manifest 自身(删除时记录的绝对路径),
   * 不接受调用方传路径, 所以没有被诱导写到工作区外的面。 */
  ipcMain.handle('file:restore-deletion', async (_event, args: { snapshotId: string }) => {
    try {
      const snapshotId = args?.snapshotId;
      if (!snapshotId) return { success: false, error: '缺少快照 ID' };
      const { restoreDeletionSnapshot } = await import('@neoxlabs/core/tools/files/fileSnapshotStore.js');
      return await restoreDeletionSnapshot(snapshotId);
    } catch (error) {
      console.error('[Main] Failed to restore deletion:', args, error);
      return { success: false, restored: 0, total: 0, error: String(error) };
    }
  });

  ipcMain.handle('file:rmdir', async (event, dirPath: string) => {
    try {
      const fs = await import('fs/promises');
      const workspacePath = workspaceOf(event);
      if (!workspacePath) {
        return { success: false, error: 'No workspace set' };
      }
      const absolutePath = resolveInWorkspace(workspacePath, dirPath);
      await fs.rmdir(absolutePath, { recursive: false });
      // console.log('[Main] Successfully removed directory:', absolutePath);
      return { success: true };
    } catch (error) {
      console.error('[Main] Failed to remove directory:', dirPath, error);
      return { success: false, error: String(error) };
    }
  });
}
