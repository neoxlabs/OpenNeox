import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';

describe('tool()', () => {
  it('creates a NeoxSdkTool with correct metadata', () => {
    const t = tool({
      name: 'echo',
      description: 'echo back',
      schema: z.object({ text: z.string() }),
      handler: ({ text }) => ({ text }),
    });
    expect(t.__kind).toBe('neox-sdk-tool');
    expect(t.name).toBe('echo');
    expect(t.description).toBe('echo back');
    expect(t.config.name).toBe('echo');
    expect(typeof t.invoke).toBe('function');
  });

  it('invoke validates input and returns handler result', async () => {
    const t = tool({
      name: 'add',
      description: 'add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: ({ a, b }) => a + b,
    });
    const ac = new AbortController();
    const ctx = { signal: ac.signal, logger: makeLogger() };
    const result = await t.invoke({ a: 2, b: 3 }, ctx);
    expect(result).toBe(5);
  });

  it('invoke throws on invalid input (zod validation)', async () => {
    const t = tool({
      name: 'strict',
      description: 'strict input',
      schema: z.object({ count: z.number().int().positive() }),
      handler: ({ count }) => count,
    });
    const ctx = { signal: new AbortController().signal, logger: makeLogger() };
    await expect(t.invoke({ count: -1 } as any, ctx)).rejects.toThrow(/validation failed/);
  });

  it('invoke treats null as omitted for optional and defaulted fields', async () => {
    const t = tool({
      name: 'list_incidents',
      description: 'list incidents',
      schema: z.object({
        status: z.string().optional(),
        limit: z.number().default(15),
        nested: z.object({ note: z.string().optional() }).optional(),
        items: z.array(z.object({ tag: z.string().optional() })).default([]),
      }),
      handler: (input) => input,
    });
    const ctx = { signal: new AbortController().signal, logger: makeLogger() };
    const result = await t.invoke({
      status: null,
      limit: null,
      nested: { note: null },
      items: [{ tag: null }],
    } as any, ctx);
    expect(result).toEqual({
      status: undefined,
      limit: 15,
      nested: { note: undefined },
      items: [{ tag: undefined }],
    });
  });

  it('invoke still rejects null for required fields', async () => {
    const t = tool({
      name: 'get_incident',
      description: 'get incident',
      schema: z.object({ id: z.string(), status: z.string().optional() }),
      handler: (input) => input,
    });
    const ctx = { signal: new AbortController().signal, logger: makeLogger() };
    await expect(t.invoke({ id: null, status: null } as any, ctx)).rejects.toThrow(/validation failed/);
  });

  it('invoke respects timeout', async () => {
    const t = tool({
      name: 'slow',
      description: 'sleep',
      schema: z.object({ ms: z.number() }),
      timeout: 50,
      handler: async ({ ms }, ctx) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return 'done';
      },
    });
    const ctx = { signal: new AbortController().signal, logger: makeLogger() };
    await expect(t.invoke({ ms: 500 }, ctx)).rejects.toThrow(/aborted/);
  });

  it('handler sync return is supported', async () => {
    const t = tool({
      name: 'sync',
      description: 'sync handler',
      schema: z.object({}),
      handler: () => 42,
    });
    const ctx = { signal: new AbortController().signal, logger: makeLogger() };
    expect(await t.invoke({}, ctx)).toBe(42);
  });
});

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
