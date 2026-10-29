import path from 'path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { safeFs } from '../files/safeFs.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';
import { readLikeBudgetChars } from '@neoxlabs/kernel/core/toolOutputBudget.js';

type CreateShowTreeToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
};

type TreeEntry = {
  name: string;
  absPath: string;
  isDir: boolean;
  children?: TreeEntry[];
};

/** 聚合模式下数文件的全局上限 —— 防止在 node_modules 里数到天荒地老 */
const COUNT_CAP = 20_000;

function sortEntries(items: Array<{ name: string; isDirectory: () => boolean }>) {
  return items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
}

function formatSize(size: number): string {
  return size < 1024
    ? `${size}B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)}KB`
      : `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

export function createShowTreeTool({ resolveWorkspacePath, formatDisplayPath }: CreateShowTreeToolDeps): Tool {
  /** 收集树结构 (不 stat 文件); 条目数超过上限就放弃, 交给聚合渲染 */
  async function collectLevel(
    currentPath: string,
    depth: number,
    state: { entries: number; maxEntries: number; maxDepth: number; overflow: boolean },
  ): Promise<TreeEntry[]> {
    if (depth >= state.maxDepth) return [];
    const items = await safeFs.readdir(currentPath, { withFileTypes: true });
    const sorted = sortEntries(items.filter((item) => !item.name.startsWith('.')));
    const out: TreeEntry[] = [];
    for (const item of sorted) {
      state.entries++;
      if (state.entries > state.maxEntries) {
        state.overflow = true;
        return [];
      }
      const childPath = path.join(currentPath, item.name);
      const isDir = item.isDirectory();
      const entry: TreeEntry = { name: item.name, absPath: childPath, isDir };
      if (isDir) {
        const children = await collectLevel(childPath, depth + 1, state);
        if (state.overflow) return [];
        entry.children = children;
      }
      out.push(entry);
    }
    return out;
  }

  /** 明细渲染 —— 与改动前逐字一致 (前缀 / 顺序 / 文件大小格式都不动) */
  async function renderDetailed(absPath: string, entries: TreeEntry[]): Promise<string> {
    const result = [`${formatDisplayPath(absPath)}/\n`];
    const walk = async (nodes: TreeEntry[], prefix: string): Promise<void> => {
      for (let i = 0; i < nodes.length; i++) {
        const item = nodes[i];
        const isLast = i === nodes.length - 1;
        const currentPrefix = isLast ? '└── ' : '├── ';
        const nextPrefix = isLast ? '    ' : '│   ';
        if (item.isDir) {
          result.push(`${prefix}${currentPrefix}${item.name}/`);
          await walk(item.children ?? [], prefix + nextPrefix);
        } else {
          const stats = await safeFs.stat(item.absPath);
          result.push(`${prefix}${currentPrefix}${item.name} (${formatSize(stats.size)})`);
        }
      }
    };
    await walk(entries, '');
    return result.join('\n');
  }

  /** 递归数文件 (跳过隐藏条目, 与明细渲染的过滤规则一致); 撞 COUNT_CAP 就停 */
  async function countFiles(dirPath: string, state: { left: number }): Promise<number> {
    if (state.left <= 0) return 0;
    let items;
    try {
      items = await safeFs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    let count = 0;
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (state.left <= 0) break;
      state.left--;
      if (item.isDirectory()) count += await countFiles(path.join(dirPath, item.name), state);
      else count++;
    }
    return count;
  }

  /** 超预算时按目录聚合: 目录名 + 文件数, 不再展开, 也不截半行 */
  async function renderAggregated(absPath: string, budgetChars: number): Promise<string> {
    const items = await safeFs.readdir(absPath, { withFileTypes: true });
    const sorted = sortEntries(items.filter((item) => !item.name.startsWith('.')));
    const countState = { left: COUNT_CAP };
    const head = `${formatDisplayPath(absPath)}/\n`;
    const lines: string[] = [];
    let used = head.length;
    let dirCount = 0;
    let fileCount = 0;
    let hidden = 0;

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const isLast = i === sorted.length - 1;
      const currentPrefix = isLast ? '└── ' : '├── ';
      let line: string;
      if (item.isDirectory()) {
        const n = await countFiles(path.join(absPath, item.name), countState);
        dirCount++;
        fileCount += n;
        line = `${currentPrefix}${item.name}/ (${n} 个文件)`;
      } else {
        fileCount++;
        const stats = await safeFs.stat(path.join(absPath, item.name));
        line = `${currentPrefix}${item.name} (${formatSize(stats.size)})`;
      }
      /* 尾部提示 + 已聚合说明必须留下, 所以每次先按最坏情况留够再收这一行 */
      const reserve = 120;
      if (used + line.length + 1 + reserve > budgetChars) {
        hidden = sorted.length - i;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }

    const statNote = countState.left <= 0 ? ' (文件数已达统计上限)' : '';
    const tail = hidden > 0
      ? `…已按目录聚合: 显示 ${lines.length} 个条目, 另有 ${hidden} 个条目未显示${statNote} (指定 directory 查看某个子目录的明细)`
      : `…已按目录聚合: ${dirCount} 个目录 / ${fileCount} 个文件${statNote} (指定 directory 查看某个子目录的明细)`;
    return [head, ...lines, tail].join('\n');
  }

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
    async function({ directory = '.', max_depth = 3 }, context) {
      try {
        const absPath = resolveWorkspacePath(directory);
        const budgetChars = readLikeBudgetChars(context?.modelMaxInputTokens);
        /* 条目上限只是个早停保护 (结构收集不 stat), 真正判超没超看渲染后的字符数:
         * 目录树一行常有 20~30 字符, 按 25 字符/行估, 短名目录不会因为行数多被误聚合。 */
        const maxEntries = Math.max(120, Math.floor(budgetChars / 25));
        const state = { entries: 0, maxEntries, maxDepth: max_depth, overflow: false };

        const entries = await collectLevel(absPath, 0, state);
        if (!state.overflow) {
          const detailed = await renderDetailed(absPath, entries);
          if (detailed.length <= budgetChars) return detailed;
        }
        return await renderAggregated(absPath, budgetChars);
      } catch (error: any) {
        return fail(`✗ 显示目录树失败: ${error.message}`);
      }
    },
  };
}
