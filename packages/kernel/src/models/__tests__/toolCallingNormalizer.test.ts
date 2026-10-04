/**
 * Tool Calling Normalizer 单测 — 三种 wire format 双向转换契约固化.
 *
 * D14 重点: 防止新加 provider 时漏适配, 或 SDK 升级把 wire format 改了导致 silent breakage.
 */

import { describe, expect, test } from 'vitest';
import {
  fromClaudeToolUse,
  toClaudeToolUse,
  fromOpenAIToolCall,
  toOpenAIToolCall,
  fromGeminiFunctionCall,
  toGeminiFunctionCall,
  fromWireFormat,
  toWireFormat,
} from '../toolCallingNormalizer.js';

describe('Claude tool_use ↔ internal', () => {
  test('fromClaudeToolUse: stringify input + 保留 id/name', () => {
    const t = fromClaudeToolUse({
      type: 'tool_use',
      id: 'toolu_abc',
      name: 'read_file',
      input: { path: '/a.ts', limit: 100 },
    });
    expect(t).toEqual({
      id: 'toolu_abc',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"/a.ts","limit":100}' },
    });
  });

  test('fromClaudeToolUse: 缺 id → 自动合成 (不丢内容)', () => {
    const t = fromClaudeToolUse({
      type: 'tool_use',
      name: 'foo',
      input: { x: 1 },
    });
    expect(t?.id).toMatch(/^call_/);
    expect(t?.function.name).toBe('foo');
  });

  test('fromClaudeToolUse: 缺 name → null', () => {
    expect(fromClaudeToolUse({ type: 'tool_use', id: 'x' } as any)).toBeNull();
  });

  test('toClaudeToolUse: parse arguments → input object', () => {
    const block = toClaudeToolUse({
      id: 'toolu_x',
      type: 'function',
      function: { name: 'write_file', arguments: '{"path":"/b.ts","content":"hi"}' },
    });
    expect(block).toEqual({
      type: 'tool_use',
      id: 'toolu_x',
      name: 'write_file',
      input: { path: '/b.ts', content: 'hi' },
    });
  });

  test('toClaudeToolUse: 非法 JSON arguments → input._raw 兜底', () => {
    const block = toClaudeToolUse({
      id: 'x',
      type: 'function',
      function: { name: 'foo', arguments: '{broken' },
    });
    expect(block.input).toEqual({ _raw: '{broken' });
  });
});

describe('OpenAI function call ↔ internal (passthrough)', () => {
  test('fromOpenAIToolCall: 缺 id 也补一个', () => {
    const t = fromOpenAIToolCall({
      type: 'function',
      function: { name: 'edit', arguments: '{"a":1}' },
    });
    expect(t?.function).toEqual({ name: 'edit', arguments: '{"a":1}' });
    expect(t?.id).toMatch(/^call_/);
  });

  test('toOpenAIToolCall identity', () => {
    const tc = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'x', arguments: '{}' },
    };
    expect(toOpenAIToolCall(tc)).toBe(tc);
  });
});

describe('Gemini functionCall ↔ internal', () => {
  test('fromGeminiFunctionCall: 嵌套 functionCall.{name,args} 提取', () => {
    const t = fromGeminiFunctionCall({
      id: 'gem_1',
      functionCall: {
        name: 'search',
        args: { query: 'foo', max: 5 },
      },
    });
    expect(t).toEqual({
      id: 'gem_1',
      type: 'function',
      function: { name: 'search', arguments: '{"query":"foo","max":5}' },
    });
  });

  test('fromGeminiFunctionCall: 无 id 时合成', () => {
    const t = fromGeminiFunctionCall({
      functionCall: { name: 'search', args: {} },
    });
    expect(t?.id).toMatch(/^call_/);
  });

  test('toGeminiFunctionCall: 反向构造嵌套形态', () => {
    const g = toGeminiFunctionCall({
      id: 'c',
      type: 'function',
      function: { name: 'x', arguments: '{"a":1}' },
    });
    expect(g).toEqual({
      id: 'c',
      functionCall: { name: 'x', args: { a: 1 } },
    });
  });
});

describe('统一 wire format 入口', () => {
  test('fromWireFormat 按 family 选择实现', () => {
    expect(fromWireFormat('openai-function', {
      type: 'function',
      function: { name: 'a', arguments: '{}' },
    })?.function.name).toBe('a');

    expect(fromWireFormat('anthropic-blocks', {
      type: 'tool_use',
      name: 'a',
      input: {},
    })?.function.name).toBe('a');

    expect(fromWireFormat('gemini-function', {
      functionCall: { name: 'a', args: {} },
    })?.function.name).toBe('a');
  });

  test('round-trip: claude → internal → claude 保持语义不变', () => {
    const original = {
      type: 'tool_use' as const,
      id: 'toolu_rt',
      name: 'edit',
      input: { path: '/a.ts', new_string: 'x' },
    };
    const internal = fromClaudeToolUse(original)!;
    const back = toClaudeToolUse(internal);
    expect(back).toEqual(original);
  });

  test('round-trip: gemini → internal → gemini 保持嵌套形态', () => {
    const original = {
      id: 'g_rt',
      functionCall: { name: 'search', args: { q: 'hi' } },
    };
    const internal = fromGeminiFunctionCall(original)!;
    const back = toGeminiFunctionCall(internal);
    expect(back).toEqual(original);
  });
});

describe('fromGeminiFunctionCall — P1-4 加固 (id 位置 + string args)', () => {
  it('picks up id nested inside functionCall (official API shape)', async () => {
    const { fromGeminiFunctionCall } = await import('../toolCallingNormalizer.js');
    const tc = fromGeminiFunctionCall({ functionCall: { id: 'fc_1', name: 'readfile', args: { path: '/a' } } });
    expect(tc?.id).toBe('fc_1');
  });

  it('normalizes string args instead of double-stringifying', async () => {
    const { fromGeminiFunctionCall } = await import('../toolCallingNormalizer.js');
    const tc = fromGeminiFunctionCall({ functionCall: { name: 'search', args: '{"q":"x"}' } });
    expect(tc?.function.arguments).toBe('{"q":"x"}');
    const bare = fromGeminiFunctionCall({ functionCall: { name: 'search', args: 'hello' } });
    expect(JSON.parse(bare!.function.arguments)).toEqual({ value: 'hello' });
  });

  it('handles null args', async () => {
    const { fromGeminiFunctionCall } = await import('../toolCallingNormalizer.js');
    const tc = fromGeminiFunctionCall({ functionCall: { name: 'noop', args: null as any } });
    expect(tc?.function.arguments).toBe('{}');
  });
});
