import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import { createEphemeralResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { saveDeletionSnapshot } from './fileSnapshotStore.js';

type FileMutationToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
  getWorkspaceRoot: () => string;
};

export function createDeleteFileTool({
  resolveWorkspacePath,
  formatDisplayPath,
  getWorkspaceRoot,
}: FileMutationToolDeps): Tool {
  return {
    name: 'delete_file',
    /* D wire: delete 短任务 30s 足够; 误删大 dir 时也不该陪 30min */
    timeoutMs: 30_000,
    description: 'Delete a file or directory (directory requires recursive=true)',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file or directory to delete',
        },
        recursive: {
          type: 'boolean',
          description: 'Allow deleting directories recursively (default: false)',
        },
        force: {
          type: 'boolean',
          description: 'Ignore missing paths (default: false)',
        },
      },
      required: ['path'],
    },
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function({ path: targetPath, recursive = false, force = false }) {
      if (!targetPath) {
        return JSON.stringify(createEphemeralResult(
          'delete_file',
          'error',
          'Missing required parameter: path',
          { error: 'path is required' }
        ));
      }

      const absPath = resolveWorkspacePath(targetPath);
      const displayPath = formatDisplayPath(absPath);
      const workspaceRoot = getWorkspaceRoot();

      if (absPath === workspaceRoot) {
        return JSON.stringify(createEphemeralResult(
          'delete_file',
          'error',
          'Refusing to delete workspace root',
          {
            file_path: absPath,
            error: 'Refusing to delete workspace root',
          }
        ));
      }

      try {
        const stats = await fs.lstat(absPath).catch(() => null);
        if (!stats) {
          if (force) {
            return JSON.stringify(createEphemeralResult(
              'delete_file',
              'already_done',
              `Path already removed: ${displayPath}`,
              { file_path: absPath }
            ));
          }
          return JSON.stringify(createEphemeralResult(
            'delete_file',
            'error',
            `Path not found: ${displayPath}`,
            { file_path: absPath, error: 'Path not found' }
          ));
        }

        if (stats.isDirectory() && !recursive) {
          return JSON.stringify(createEphemeralResult(
            'delete_file',
            'error',
            `Refusing to delete directory without recursive=true: ${displayPath}`,
            {
              file_path: absPath,
              error: 'Directory deletion requires recursive=true',
            }
          ));
        }

        /* 删之前先把内容存下来 —— agent 的 delete_file 是永久删(fs.rm), 而用户自己在文件树里
         * 删走的是系统回收站。neox-core 是 CLI/桌面共用的, 拿不到 Electron shell.trashItem,
         * 用快照兜底至少保证"救得回来"。失败不阻断删除, 但如实报告覆盖范围。 */
        const deletionSnapshot = await saveDeletionSnapshot(absPath);

        if (stats.isDirectory()) {
          await fs.rm(absPath, { recursive: true, force });
        } else {
          await fs.rm(absPath, { force });
        }

        return JSON.stringify(createEphemeralResult(
          'delete_file',
          'success',
          `Deleted: ${displayPath}`,
          {
            file_path: absPath,
            verify_hint: `Use "list_directory ${path.dirname(displayPath)}" to verify.`,
            /* 只带一个 manifest id + 几个数字 —— 内容全在快照库里, 绝不进返回值(会发给 LLM) */
            metadata: {
              recoverable: !!deletionSnapshot.manifestId,
              ...(deletionSnapshot.manifestId
                ? {
                    deletion_snapshot_id: deletionSnapshot.manifestId,
                    snapshot_file_count: deletionSnapshot.fileCount,
                    ...(deletionSnapshot.truncated ? { snapshot_truncated: true } : {}),
                    ...(deletionSnapshot.skippedCount ? { snapshot_skipped: deletionSnapshot.skippedCount } : {}),
                  }
                : {}),
            },
          }
        ));
      } catch (error: any) {
        return JSON.stringify(createEphemeralResult(
          'delete_file',
          'error',
          `Failed to delete: ${displayPath}`,
          {
            file_path: absPath,
            error: error.message,
          }
        ));
      }
    },
  };
}

export function createRenameFileTool({
  resolveWorkspacePath,
  formatDisplayPath,
  getWorkspaceRoot,
}: FileMutationToolDeps): Tool {
  return {
    name: 'rename_file',
    description: 'Rename or move a file/directory within the workspace',
    parameters: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Existing path to rename or move',
        },
        destination_path: {
          type: 'string',
          description: 'New path',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite destination if exists (default: false)',
        },
        create_dirs: {
          type: 'boolean',
          description: 'Create destination parent dirs if needed (default: true)',
        },
      },
      required: ['source_path', 'destination_path'],
    },
    permission: {
      category: ToolCategory.WRITE,
      allowInAskMode: false,
    },
    async function({ source_path, destination_path, overwrite = false, create_dirs = true }) {
      if (!source_path || !destination_path) {
        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'error',
          'Missing required parameters: source_path, destination_path',
          { error: 'source_path and destination_path are required' }
        ));
      }

      const sourceAbs = resolveWorkspacePath(source_path);
      const destAbs = resolveWorkspacePath(destination_path);
      const sourceDisplay = formatDisplayPath(sourceAbs);
      const destDisplay = formatDisplayPath(destAbs);
      const workspaceRoot = getWorkspaceRoot();

      if (sourceAbs === workspaceRoot || destAbs === workspaceRoot) {
        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'error',
          'Refusing to rename workspace root',
          { file_path: sourceAbs }
        ));
      }

      try {
        await fs.lstat(sourceAbs);
      } catch {
        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'error',
          `Source not found: ${sourceDisplay}`,
          { file_path: sourceAbs, error: 'Source not found' }
        ));
      }

      const destStats = await fs.lstat(destAbs).catch(() => null);
      if (destStats && !overwrite) {
        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'error',
          `Destination already exists: ${destDisplay}`,
          { file_path: destAbs, error: 'Destination already exists' }
        ));
      }

      try {
        if (destStats && overwrite) {
          await fs.rm(destAbs, { recursive: true, force: true });
        }

        if (create_dirs) {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
        }

        await fs.rename(sourceAbs, destAbs);

        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'success',
          `Renamed: ${sourceDisplay} → ${destDisplay}`,
          {
            file_path: destAbs,
            verify_hint: `Use "list_directory ${path.dirname(destDisplay)}" to verify.`,
            metadata: {
              from: sourceAbs,
              to: destAbs,
            },
          }
        ));
      } catch (error: any) {
        return JSON.stringify(createEphemeralResult(
          'rename_file',
          'error',
          `Failed to rename: ${sourceDisplay}`,
          { file_path: sourceAbs, error: error.message }
        ));
      }
    },
  };
}
