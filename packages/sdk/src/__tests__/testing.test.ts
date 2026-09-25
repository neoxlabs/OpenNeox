import { describe, it, expect } from 'vitest';
import { mockLlm, isMockProvider, generateMockEvents, replayFromJsonl } from '../testing/index.js';
import { replay } from '../testing/node.js';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('mockLlm()', () => {
  it('creates a MockProvider with __mock attached', () => {
    const p = mockLlm({
      responses: [{ type: 'text', content: 'hi' }],
    });
    expect(p.type).toBe('openai-compatible');
    expect((p as any).__mock.responses).toHaveLength(1);
    expect(isMockProvider(p)).toBe(true);
  });

  it('isMockProvider returns false for plain provider', () => {
    expect(isMockProvider({ type: 'anthropic', apiKey: 'k' })).toBe(false);
    expect(isMockProvider(undefined)).toBe(false);
  });

  it('generateMockEvents yields text_delta + step + done', async () => {
    const p = mockLlm({
      responses: [
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' World' },
      ],
    });
    const events = [];
    for await (const e of generateMockEvents(p)) {
      events.push(e);
    }
    const types = events.map(e => e.type);
    expect(types).toContain('step_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('step_end');
    expect(types).toContain('done');
    const textDeltas = events.filter(e => e.type === 'text_delta') as any[];
    expect(textDeltas.map(e => e.delta).join('')).toBe('Hello World');
  });

  it('generateMockEvents yields tool_call + thinking', async () => {
    const p = mockLlm({
      responses: [
        { type: 'thinking', content: 'reasoning...' },
        { type: 'tool_call', tool: 'search', input: { query: 'x' } },
      ],
    });
    const events = [];
    for await (const e of generateMockEvents(p)) events.push(e);
    const thinkings = events.filter(e => e.type === 'thinking');
    const toolCalls = events.filter(e => e.type === 'tool_call') as any[];
    expect(thinkings).toHaveLength(1);
    expect(toolCalls[0].tool).toBe('search');
    expect(toolCalls[0].input).toEqual({ query: 'x' });
    expect(toolCalls[0].id).toMatch(/^mock-/);
  });

  it('generateMockEvents stops on error response', async () => {
    const p = mockLlm({
      responses: [
        { type: 'text', content: 'before' },
        { type: 'error', error: 'oops' },
        { type: 'text', content: 'after (should not appear)' },
      ],
    });
    const events = [];
    for await (const e of generateMockEvents(p)) events.push(e);
    const errors = events.filter(e => e.type === 'error') as any[];
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(Error);
    expect((errors[0].error as Error).message).toBe('oops');
    // done event should NOT be emitted after error
    expect(events.some(e => e.type === 'done')).toBe(false);
  });
});

describe('replayFromJsonl() (browser+node 通用)', () => {
  it('parses inline JSONL string', () => {
    const jsonl = [
      '{"type":"text","content":"A"}',
      '  ',
      '// comment line ignored',
      '{"type":"tool_call","tool":"foo","input":{"x":1}}',
    ].join('\n');
    const p = replayFromJsonl(jsonl);
    expect((p as any).__mock.responses).toHaveLength(2);
    expect((p as any).__mock.responses[0].type).toBe('text');
    expect((p as any).__mock.responses[1].type).toBe('tool_call');
  });

  it('throws on malformed JSON with source label', () => {
    expect(() => replayFromJsonl('{not json}\n', 'inline-test')).toThrow(/inline-test/);
  });
});

describe('replay() (node-only fixturePath)', () => {
  it('parses JSONL fixture from file path', () => {
    const tmp = join(tmpdir(), `replay-test-${Date.now()}.jsonl`);
    writeFileSync(
      tmp,
      [
        '{"type":"text","content":"A"}',
        '  ',
        '// comment line ignored',
        '{"type":"tool_call","tool":"foo","input":{"x":1}}',
      ].join('\n'),
      'utf-8',
    );
    const p = replay(tmp);
    expect((p as any).__mock.responses).toHaveLength(2);
    expect((p as any).__mock.responses[0].type).toBe('text');
    expect((p as any).__mock.responses[1].type).toBe('tool_call');
    unlinkSync(tmp);
  });

  it('throws on malformed JSON with source path', () => {
    const tmp = join(tmpdir(), `bad-${Date.now()}.jsonl`);
    writeFileSync(tmp, '{not json}\n', 'utf-8');
    expect(() => replay(tmp)).toThrow(/failed to parse/);
    unlinkSync(tmp);
  });
});
