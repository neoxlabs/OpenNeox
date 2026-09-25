import fs from 'fs/promises';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';

type CreateAnalyzeCodeToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
};

export function createAnalyzeCodeTool({ resolveWorkspacePath }: CreateAnalyzeCodeToolDeps): Tool {
  return {
    name: 'analyze_code',
    description: 'Analyze code file structure and statistics',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to code file',
        },
      },
      required: ['file_path'],
    },
    async function({ file_path }) {
      try {
        const absPath = resolveWorkspacePath(file_path);
        const content = await fs.readFile(absPath, 'utf-8');
        const lines = content.split('\n');

        const totalLines = lines.length;
        const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
        const commentLines = lines.filter(l => l.trim().startsWith('//')).length;
        const blankLines = totalLines - codeLines - commentLines;

        const imports = lines.filter(l => l.trim().startsWith('import ') || l.trim().startsWith('from '));
        const functions = lines.filter(l => l.trim().startsWith('function ') || l.trim().startsWith('async function'));
        const classes = lines.filter(l => l.trim().startsWith('class '));

        const result = [
          `✓ 代码分析: ${file_path}\n`,
          '统计:',
          `  总行数: ${totalLines}`,
          `  代码行: ${codeLines}`,
          `  注释行: ${commentLines}`,
          `  空白行: ${blankLines}`,
        ];

        if (imports.length > 0) {
          result.push(`\n导入 (${imports.length} 个):`);
          imports.slice(0, 5).forEach(imp => result.push(`  - ${imp.trim()}`));
          if (imports.length > 5) {
            result.push(`  ... 还有 ${imports.length - 5} 个导入`);
          }
        }

        if (classes.length > 0) {
          result.push(`\n类定义 (${classes.length} 个):`);
          classes.forEach(cls => result.push(`  - ${cls.trim()}`));
        }

        if (functions.length > 0) {
          result.push(`\n函数定义 (${functions.length} 个):`);
          functions.slice(0, 10).forEach(func => result.push(`  - ${func.trim()}`));
          if (functions.length > 10) {
            result.push(`  ... 还有 ${functions.length - 10} 个函数`);
          }
        }

        return result.join('\n');
      } catch (error: any) {
        return fail(`✗ 分析失败: ${error.message}`);
      }
    },
  };
}
