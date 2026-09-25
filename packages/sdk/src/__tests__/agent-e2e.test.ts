/**
 * Agent.run/stream · e2e · 走 mockLlm 路径,不触网.
 *
 * 真·provider 的 e2e 需要 API key,走不同的 gated suite(这里只验绿色路径 + 适配层).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent.js';
import { tool } from '../tool.js';
import { mockLlm } from '../testing/index.js';

describe('Agent · e2e with mockLlm', () => {
  it('run() returns final text + done usage', async () => {
    const agent = new Agent({
      model: 'mock',
      provider: mockLlm({
        responses: [
          { type: 'text', content: 'Hello ' },
          { type: 'text', content: 'world' },
        ],
      }),
    });

    const result = await agent.run('anything');
    expect(result.text).toBe('Hello world');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('stream() yields text_delta events in order', async () => {
    const agent = new Agent({
      model: 'mock',
      provider: mockLlm({
        responses: [
          { type: 'text', content: 'A' },
          { type: 'text', content: 'B' },
          { type: 'text', content: 'C' },
        ],
      }),
    });

    const deltas: string[] = [];
    let doneSeen = false;
    for await (const event of agent.stream('go')) {
      if (event.type === 'text_delta') deltas.push(event.delta);
      if (event.type === 'done') doneSeen = true;
    }
    expect(deltas.join('')).toBe('ABC');
    expect(doneSeen).toBe(true);
  });

  it('stream() fires tool_call event with structured input', async () => {
    const agent = new Agent({
      model: 'mock',
      provider: mockLlm({
        responses: [
          { type: 'tool_call', tool: 'lookup', input: { q: 'claude' } },
        ],
      }),
    });

    const toolCalls: Array<{ tool: string; input: unknown }> = [];
    for await (const event of agent.stream('go')) {
      if (event.type === 'tool_call') {
        toolCalls.push({ tool: event.tool, input: event.input });
      }
    }
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ tool: 'lookup', input: { q: 'claude' } });
  });

  it('error response surfaces through stream and aborts further events', async () => {
    const agent = new Agent({
      model: 'mock',
      provider: mockLlm({
        responses: [
          { type: 'text', content: 'before' },
          { type: 'error', error: 'boom' },
          { type: 'text', content: 'after-should-not-appear' },
        ],
      }),
    });

    const events: string[] = [];
    for await (const event of agent.stream('go')) {
      events.push(event.type);
      if (event.type === 'text_delta') events.push(`delta:${event.delta}`);
    }
    expect(events).toContain('text_delta');
    expect(events).toContain('error');
    // 'done' must not appear after error
    expect(events).not.toContain('done');
    // the 'after' text never comes through
    expect(events).not.toContain('delta:after-should-not-appear');
  });

  it('run() with tool config does not crash before provider dispatch', async () => {
    // Validates the NeoxSdkTool → core Tool adapter runs without throwing.
    const weather = tool({
      name: 'weather',
      description: 'Get weather',
      schema: z.object({ city: z.string() }),
      handler: async ({ city }) => ({ temp: 22, city }),
    });
    const agent = new Agent({
      model: 'mock',
      tools: [weather],
      provider: mockLlm({
        responses: [{ type: 'text', content: 'ok' }],
      }),
    });
    const result = await agent.run('hi');
    expect(result.text).toBe('ok');
  });

  it('onEvent config callback receives events from run()', async () => {
    const received: string[] = [];
    const agent = new Agent({
      model: 'mock',
      provider: mockLlm({
        responses: [
          { type: 'text', content: 'hi' },
          { type: 'thinking', content: 'hmm' },
        ],
      }),
      onEvent: (ev) => received.push(ev.type),
    });
    await agent.run('go');
    expect(received).toContain('text_delta');
    expect(received).toContain('thinking');
    expect(received).toContain('done');
  });
});
