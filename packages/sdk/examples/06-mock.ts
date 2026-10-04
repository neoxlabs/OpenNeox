/**
 * 06-mock.ts · 用 mockLlm() 离网跑 agent
 *
 * 运行: tsx packages/sdk/examples/06-mock.ts
 *
 * 用途:写 SDK 用户的单元测试,或在 CI 里验证 agent 定义不需要 API key.
 */

import { Agent } from '@neoxlabs/sdk';
import { mockLlm } from '@neoxlabs/sdk/testing';

const agent = new Agent({
  model: 'mock',
  provider: mockLlm({
    responses: [
      { type: 'thinking', content: 'Let me check the weather...' },
      { type: 'tool_call', tool: 'get_weather', input: { city: 'Tokyo' } },
      { type: 'text', content: "It's 22°C in Tokyo, clear skies." },
    ],
  }),
});

// 流式消费
console.log('--- stream ---');
for await (const event of agent.stream('weather in Tokyo?')) {
  switch (event.type) {
    case 'thinking':
      process.stdout.write(`[think] ${event.delta}\n`);
      break;
    case 'tool_call':
      console.log(`[tool ] ${event.tool}(${JSON.stringify(event.input)})`);
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'done':
      console.log(`\n[done] stop=${event.stopReason}`);
      break;
    case 'error':
      console.error('[err ]', event.error);
      break;
  }
}

// 非流式
console.log('\n--- run ---');
const agent2 = new Agent({
  model: 'mock',
  provider: mockLlm({
    responses: [{ type: 'text', content: 'Hello from mock!' }],
  }),
});
const result = await agent2.run('hi');
console.log(result.text);
