import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';

describe('tool() JSONSchema generation', () => {
  it('simple object schema', () => {
    const t = tool({
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string(), count: z.number().optional() }),
      handler: ({ text }) => text,
    });
    // inputSchema 应含 type:object + properties
    expect(t.inputSchema.type).toBe('object');
    const props = t.inputSchema.properties as Record<string, any>;
    expect(props.text?.type).toBe('string');
    // count optional field · 只要字段存在即可(target:openAi 对 optional 的具体表达
    // 可能是 type:number/nullable 或省略, 都合规)
    expect(props.count).toBeDefined();
    // required: text 必然在. OpenAI target 会把所有字段都列 required(它的
    // function calling 约定), 所以不强断言 count 不在.
    const required = t.inputSchema.required as string[];
    expect(required).toContain('text');
  });

  it('enum + description are preserved', () => {
    const t = tool({
      name: 'weather',
      description: 'weather',
      schema: z.object({
        city: z.string().describe('City name'),
        unit: z.enum(['celsius', 'fahrenheit']),
      }),
      handler: () => 'ok',
    });
    const props = t.inputSchema.properties as Record<string, any>;
    expect(props.city.description).toBe('City name');
    expect(props.unit.enum).toEqual(['celsius', 'fahrenheit']);
  });

  it('nested object', () => {
    const t = tool({
      name: 'create',
      description: 'create',
      schema: z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      }),
      handler: () => 'ok',
    });
    const props = t.inputSchema.properties as Record<string, any>;
    expect(props.user.type).toBe('object');
    expect(props.user.properties.name.type).toBe('string');
  });

  it('array of strings', () => {
    const t = tool({
      name: 'list',
      description: 'list',
      schema: z.object({ items: z.array(z.string()) }),
      handler: () => 'ok',
    });
    const props = t.inputSchema.properties as Record<string, any>;
    expect(props.items.type).toBe('array');
    expect(props.items.items.type).toBe('string');
  });

  it('no $schema or definitions leaked in output', () => {
    const t = tool({
      name: 'simple',
      description: 'simple',
      schema: z.object({ x: z.number() }),
      handler: () => 1,
    });
    expect(t.inputSchema.$schema).toBeUndefined();
    expect((t.inputSchema as any).definitions).toBeUndefined();
  });
});
