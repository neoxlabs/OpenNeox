/**
 * ptc_execute Tool — Programmatic Tool Calling
 *
 * LLM 调用此工具时传入 JS 脚本，脚本在 VM 沙箱中执行，
 * 所有其他工具都作为 async 函数可直接 await 调用。
 * 只有脚本最终输出返回给 LLM，中间工具结果不进上下文。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { PTCExecutor } from '../core/ptc/index.js';
import { describeToolBindings } from '../core/ptc/ptcToolBinder.js';

/**
 * 创建 ptc_execute 工具
 * @param allTools 当前可用的全部工具（用于绑定到沙箱）
 */
export function createPTCTool(allTools: Tool[]): Tool {
  const toolSignatures = describeToolBindings(allTools);

  return {
    name: 'ptc_execute',
    description: `Execute a JavaScript script that orchestrates multiple tool calls programmatically.
Use this when you need to call 3+ tools in sequence or do complex multi-step operations.
The script runs in a sandbox with all tools available as async functions.

Available tools in script scope:
${toolSignatures}

Rules:
- All tool functions are async, use \`await\`
- Use \`console.log()\` to output results
- Last expression or return value is captured
- Script timeout: 60 seconds
- Do NOT use require/import — tools are already in scope`,
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript code to execute. All tools are available as async functions.',
        },
        description: {
          type: 'string',
          description: 'Brief description of what the script does (for logging)',
        },
      },
      required: ['script'],
    },
    permission: {
      category: 'EXECUTE' as any,
      allowInAskMode: false,
    },
    async function(args: any) {
      const { script, description } = args;

      if (!script || typeof script !== 'string') {
        return '[ERROR] script parameter is required';
      }

      const executor = new PTCExecutor(allTools);
      const result = await executor.execute({
        script,
        description,
        timeout: 60_000,
      });

      if (!result.success) {
        const callsInfo = result.toolCalls.map(c => `  ${c.name} (${c.durationMs}ms)`).join('\n');
        return `[PTC Error: ${result.toolCallCount} calls, ${result.durationMs}ms]\n${callsInfo ? callsInfo + '\n' : ''}${result.error}\n\n${result.output}`;
      }

      const callsInfo = result.toolCalls.map(c => `  ${c.name} (${c.durationMs}ms)`).join('\n');
      const meta = `[PTC: ${result.toolCallCount} tool calls, ${result.durationMs}ms]`;
      return `${meta}\n${callsInfo}\n${result.output}`;
    },
  };
}
