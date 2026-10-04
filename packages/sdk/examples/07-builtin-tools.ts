/**
 * 07-builtin-tools.ts · 内置文件工具 —— 让 agent 真的动代码
 *
 * 运行:
 *   export ANTHROPIC_API_KEY=sk-...
 *   tsx packages/sdk/examples/07-builtin-tools.ts
 *
 * 安全边界(这个示例直接碰磁盘, 先看清楚再跑):
 *   · root 之外的路径一律拒绝, 符号链接逃逸也拒
 *   · 不给 allowWrite 就只有读工具
 *   · 写工具标了 dangerous —— permission:'auto' 下会被拒, 所以这里显式给了 handler
 */

import { Agent } from '@neoxlabs/sdk';
import { builtinTools } from '@neoxlabs/sdk/tools';

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  tools: [
    ...builtinTools.fs({ root: './src', allowWrite: true }),
    ...builtinTools.shell({ allowedCommands: ['npm'] }),
  ],
  maxSteps: 20,
  /* 危险工具(写文件 / 跑命令)逐个过审批 —— 生产里把 confirm 换成你自己的审批流 */
  permission: async ({ tool, input, dangerous }) => {
    if (!dangerous) return { approved: true };
    console.log(`\n[approval] ${tool}`, JSON.stringify(input).slice(0, 200));
    return { approved: true, reason: 'approved by example script' };
  },
});

const stream = agent.stream('列出 src 下的文件, 找出最长的那个函数, 告诉我它在哪一行');

for await (const ev of stream) {
  if (ev.type === 'text_delta') process.stdout.write(ev.delta);
  if (ev.type === 'tool_call') console.log(`\n→ ${ev.tool}`, ev.input);
  if (ev.type === 'tool_error') console.error(`\n✗ ${ev.tool}: ${ev.error}`);
}

const { usage, stopReason } = await stream.result();
console.log(`\n\nstopReason=${stopReason} tokens=${usage.inputTokens}+${usage.outputTokens}`);
