/**
 * 02-tools.ts · Zod schema + tool() 用法
 *
 * 演示 tool() 的完整能力:
 *   - Zod schema 自动 validate
 *   - handler 类型推导
 *   - timeout + abort
 *   - dangerous flag(用于 permission:'ask' 场景)
 */

import { tool } from '@neoxlabs/sdk';
import { z } from 'zod';

// 1. 简单工具
const weather = tool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  schema: z.object({
    city: z.string().describe('City name in English'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  handler: async ({ city, unit }) => ({ temp: 22, unit, city }),
});

// 2. 标记危险操作的工具
const deleteFile = tool({
  name: 'delete_file',
  description: 'Delete a file from disk (DANGEROUS)',
  schema: z.object({ path: z.string() }),
  dangerous: true,
  handler: async ({ path }) => {
    console.log(`  Would delete ${path}`);
    return { deleted: true };
  },
});

// 3. 带 timeout 的慢工具
const slowQuery = tool({
  name: 'slow_query',
  description: 'A long-running database query',
  schema: z.object({ sql: z.string() }),
  timeout: 5000,
  cacheable: true,
  handler: async ({ sql }) => {
    await new Promise(r => setTimeout(r, 100));
    return { rows: [], sql };
  },
});

// 实际调用 tool 测试
const ctx = { signal: new AbortController().signal, logger: console };

const w = await weather.invoke({ city: 'Tokyo', unit: 'celsius' }, ctx);
console.log('weather →', w);

const q = await slowQuery.invoke({ sql: 'SELECT 1' }, ctx);
console.log('slowQuery →', q);

console.log('\n✅ Zod schemas validated, handlers ran, timeout enforced.');
console.log(`Tools registered: ${[weather, deleteFile, slowQuery].map(t => t.name).join(', ')}`);
