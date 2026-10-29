/**
 * 03-streaming.ts · Agent.stream() 用法形态
 *
 * v0.0.0-alpha: stream() 抛 NotImplemented; 此 example 展示最终的 API 形态,
 * 让你知道 v0.1.0 时代码长什么样,API 不会变.
 */

import { Agent, tool } from '@neoxlabs/sdk';
import { z } from 'zod';

const search = tool({
  name: 'search',
  description: 'Search knowledge base',
  schema: z.object({ query: z.string() }),
  handler: async ({ query }) => ({ results: [`Result for ${query}`] }),
});

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  tools: [search],
  maxSteps: 10,
});

// v0.1.0 将真实工作; v0.0.0-alpha 抛 NotImplemented
try {
  for await (const event of agent.stream('Search for TypeScript')) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.delta);
        break;
      case 'tool_call':
        console.log(`\n→ calling ${event.tool}`, event.input);
        break;
      case 'tool_result':
        console.log(`  ✓ ${event.tool} returned`, event.output);
        break;
      case 'thinking':
        // 折叠展示(可选)
        break;
      case 'step_end':
        console.log(`\n--- step ${event.step} end ---`);
        break;
      case 'done':
        console.log(`\n\nusage: ${JSON.stringify(event.usage)}`);
        break;
      case 'error':
        console.error('\n[error]', event.error);
        break;
    }
  }
} catch (err) {
  console.log(`(expected in v0.0.0-alpha) ${(err as Error).message}`);
}
