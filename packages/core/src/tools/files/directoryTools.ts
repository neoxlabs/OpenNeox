import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createEphemeralResult, markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';

type DirectoryToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
};

export function createListDirectoryTool({ resolveWorkspacePath, formatDisplayPath }: DirectoryToolDeps): Tool {
  return {
    name: 'list_directory',
    description: 'List contents of a directory',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path (default: current directory)',
        },
        show_hidden: {
          type: 'boolean',
          description: 'Show hidden files',
        },
      },
    },
    async function({ directory = '.', show_hidden = false }) {
      try {
        const absPath = resolveWorkspacePath(directory);
        const items = await fs.readdir(absPath, { withFileTypes: true });

        const filtered = show_hidden ? items : items.filter(item => !item.name.startsWith('.'));
        const dirs = filtered.filter(item => item.isDirectory()).map(item => item.name);
        const files = filtered.filter(item => item.isFile()).map(item => item.name);
        const result = [`✓ 目录: ${formatDisplayPath(absPath)}\n`];

        if (dirs.length > 0) {
          result.push('子目录:');
          dirs.forEach(dir => result.push(`  - ${dir}/`));
        }

        if (files.length > 0) {
          result.push('\n文件:');
          for (const file of files) {
            const stats = await fs.stat(path.join(absPath, file));
            const size = stats.size < 1024
              ? `${stats.size}B`
              : stats.size < 1024 * 1024
                ? `${(stats.size / 1024).toFixed(1)}KB`
                : `${(stats.size / (1024 * 1024)).toFixed(1)}MB`;
            result.push(`  - ${file} (${size})`);
          }
        }

        if (dirs.length === 0 && files.length === 0) {
          result.push('(空目录)');
        }

        return result.join('\n');
      } catch (error: any) {
        const code = String(error?.code ?? '');
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const hint = await describeNearestExistingAncestor(directory, resolveWorkspacePath, formatDisplayPath);
          return fail(`✗ 目录不存在: ${directory}${hint}`);
        }
        return fail(`✗ 列出目录失败: ${error.message}`);
      }
    },
  };
}

export function createCreateDirectoryTool({ resolveWorkspacePath, formatDisplayPath }: DirectoryToolDeps): Tool {
  return {
    name: 'create_directory',
    description: 'Create a new directory (supports recursive). Accepts `directory` / `path` (alias).',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path to create',
        },
        path: {
          type: 'string',
          description: 'Alias for directory',
        },
      },
      required: ['directory'],
    },
    async function(args: any) {
      /* 模型经常发 path / name 而非 directory — 兼容它们减少"参数缺失"误报 */
      const directory: string = args?.directory || args?.path || args?.name || args?.dir || args?.dirname || '';
      if (!directory) {
        return JSON.stringify(createEphemeralResult(
          'create_directory',
          'error',
          'Missing required parameter: directory (or alias: path / name)',
          {
            error: 'directory path is required',
            verify_hint: 'Provide directory path. Examples: { directory: "src/utils" } or { path: "src/utils" }.',
          }
        ));
      }

      const absPath = resolveWorkspacePath(directory);
      const displayPath = formatDisplayPath(absPath);

      try {
        try {
          const stats = await fs.stat(absPath);
          if (stats.isDirectory()) {
            return JSON.stringify(createEphemeralResult(
              'create_directory',
              'already_done',
              `Directory already exists: ${displayPath}`,
              {
                file_path: absPath,
                verify_hint: `Use "list_directory ${directory}" to view contents.`,
              }
            ));
          }
        } catch {
          // ignore
        }

        await fs.mkdir(absPath, { recursive: true });

        return JSON.stringify(createEphemeralResult(
          'create_directory',
          'success',
          `Directory created: ${displayPath}`,
          {
            file_path: absPath,
            verify_hint: `Use "list_directory ${directory}" to verify.`,
          }
        ));
      } catch (error: any) {
        return JSON.stringify(createEphemeralResult(
          'create_directory',
          'error',
          `Failed to create directory: ${error.message}`,
          {
            file_path: absPath,
            error: error.message,
            verify_hint: 'Check path validity and permissions.',
          }
        ));
      }
    },
  };
}

/**
 * 沿着请求路径往上找最近一个真实存在的目录, 并列出它的直接子项。
 *
 *   给模型看的, 不是给用户看的 —— 目的是让"猜错了路径"这件事**一次**就纠正过来,
 *   而不是让它继续猜 (见 list_directory catch 里的说明)。
 *
 *   边界: 最多往上 6 层; resolveWorkspacePath 抛错 (超出工作区) 立即停 —— 这条路径
 *   绝不能变成读工作区外目录的后门。任何一步失败都静默返回空串, 退化成原来那句话。
 */
async function describeNearestExistingAncestor(
  requested: string,
  resolveWorkspacePath: (p?: string) => string,
  formatDisplayPath: (p: string) => string,
): Promise<string> {
  try {
    let cur = requested;
    for (let up = 0; up < 6; up++) {
      const parent = path.dirname(cur);
      /* dirname 到顶了 (再往上还是自己) —— 停 */
      if (!parent || parent === cur) return '';
      cur = parent;

      let abs: string;
      try { abs = resolveWorkspacePath(cur); } catch { return ''; }   /* 出了工作区 → 不再往上 */

      let items;
      try { items = await fs.readdir(abs, { withFileTypes: true }); } catch { continue; }

      const dirs = items.filter(i => i.isDirectory() && !i.name.startsWith('.')).map(i => `${i.name}/`);
      const files = items.filter(i => i.isFile() && !i.name.startsWith('.')).map(i => i.name);
      /* 只列一屏的量 —— 这是纠错线索, 不是完整目录清单 */
      const shown = [...dirs, ...files].slice(0, 40);
      const more = dirs.length + files.length - shown.length;
      const listed = shown.length
        ? shown.join('  ') + (more > 0 ? `  …还有 ${more} 项` : '')
        : '(空目录)';
      return `\n最近存在的上级是 ${formatDisplayPath(abs)}, 它下面有:\n  ${listed}\n`
        + '请从上面这些里挑一个真实存在的再试, 不要继续拼路径。';
    }
    return '';
  } catch {
    return '';
  }
}
