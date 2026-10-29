import glob from 'fast-glob';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';

type CreateSearchFilesToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
};

export function createSearchFilesTool({ resolveWorkspacePath, formatDisplayPath }: CreateSearchFilesToolDeps): Tool {
  return {
    name: 'search_files',
    description: `Fast file pattern matching tool (Glob).

Use this to find files by name patterns:
- "**/*.ts" - all TypeScript files
- "src/**/*.jsx" - JSX files in src
- "**/test*.js" - test files anywhere

For searching file CONTENTS, use search instead.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., **/*.ts, src/**/*.jsx, **/test*.js)',
        },
        directory: {
          type: 'string',
          description: 'Directory to search in (default: current directory)',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden files (default: false)',
        },
      },
      required: ['pattern'],
    },
    async function({ pattern, directory = '.', include_hidden = false }) {
      try {
        const cwd = resolveWorkspacePath(directory);
        const files = await glob(pattern, {
          cwd,
          absolute: false,
          dot: include_hidden,
          ignore: ['**/node_modules/**', '**/.git/**'],
        });

        if (files.length === 0) {
          return `✓ 搜索: "${pattern}" 在 ${formatDisplayPath(cwd)}
未找到匹配的文件

建议:
- 检查路径是否正确
- 尝试更宽泛的模式: "**/*${pattern.replace(/\*\*/g, '').replace(/\*/g, '')}"`;
        }

        files.sort();

        const result = [`✓ 找到 ${files.length} 个文件`];
        result.push(`▸ 目录: ${formatDisplayPath(cwd)}`);
        result.push(`▸ 模式: ${pattern}\n`);

        const maxDisplay = 50;
        const displayFiles = files.slice(0, maxDisplay);

        displayFiles.forEach(file => {
          result.push(`  ${file}`);
        });

        if (files.length > maxDisplay) {
          result.push(`\n  ... 还有 ${files.length - maxDisplay} 个文件`);
        }

        return result.join('\n');
      } catch (error: any) {
        return fail(`✗ 搜索失败: ${error.message}`);
      }
    },
  };
}
