import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { safeFs } from '../files/safeFs.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';

type CreateShowTreeToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
};

export function createShowTreeTool({ resolveWorkspacePath, formatDisplayPath }: CreateShowTreeToolDeps): Tool {
  return {
    name: 'show_tree',
    description: 'Display directory tree structure',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path (default: current directory)',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 3)',
        },
      },
    },
    async function({ directory = '.', max_depth = 3 }) {
      try {
        const absPath = resolveWorkspacePath(directory);
        const result = [`${formatDisplayPath(absPath)}/\n`];

        async function buildTree(currentPath: string, prefix = '', depth = 0): Promise<void> {
          if (depth >= max_depth) return;

          const items = await safeFs.readdir(currentPath, { withFileTypes: true });
          const filtered = items.filter(item => !item.name.startsWith('.'));
          const sorted = filtered.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          for (let i = 0; i < sorted.length; i++) {
            const item = sorted[i];
            const isLast = i === sorted.length - 1;
            const currentPrefix = isLast ? '└── ' : '├── ';
            const nextPrefix = isLast ? '    ' : '│   ';

            if (item.isDirectory()) {
              result.push(`${prefix}${currentPrefix}${item.name}/`);
              await buildTree(path.join(currentPath, item.name), prefix + nextPrefix, depth + 1);
            } else {
              const stats = await safeFs.stat(path.join(currentPath, item.name));
              const size = stats.size < 1024
                ? `${stats.size}B`
                : stats.size < 1024 * 1024
                  ? `${(stats.size / 1024).toFixed(1)}KB`
                  : `${(stats.size / (1024 * 1024)).toFixed(1)}MB`;
              result.push(`${prefix}${currentPrefix}${item.name} (${size})`);
            }
          }
        }

        await buildTree(absPath);
        return result.join('\n');
      } catch (error: any) {
        return fail(`✗ 显示目录树失败: ${error.message}`);
      }
    },
  };
}
