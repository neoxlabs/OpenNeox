/**
 * 01-hello.ts · Neox Agent SDK · 3 行 hello world
 *
 * 运行:
 *   export ANTHROPIC_API_KEY=sk-...   # 或 OPENAI_API_KEY / DEEPSEEK_API_KEY ...
 *   tsx packages/sdk/examples/01-hello.ts
 *
 * 想离网跑?看 06-mock.ts ——用 mockLlm() 脚本回放,不触网不计费.
 */

import { Agent, tool, VERSION } from '@neoxlabs/sdk';
import { z } from 'zod';

console.log(`Neox Agent SDK ${VERSION}`);

const weather = tool({
  name: 'get_weather',
  description: 'Get weather for a city',
  schema: z.object({
    city: z.string().describe('City name in English'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  handler: async ({ city, unit }) => {
    console.log(`  [tool:weather] city=${city} unit=${unit}`);
    return { temp: 22, unit, city };
  },
});

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful weather assistant.',
  tools: [weather],
  thinking: 'auto',
  maxSteps: 20,
});

const result = await agent.run('What is the weather in Tokyo?');
console.log('\n' + result.text);
console.log('\nusage:', result.usage);
