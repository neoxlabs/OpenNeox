/**
 * reasoning_content 回传策略 (P1-4) — family yaml thinking.passback 声明驱动。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIProvider, resolveReasoningPassbackPolicy } from '../openai.js';
import { getSchemaRegistry, resetSchemaRegistryForTesting } from '../../schemas/loader.js';

describe('resolveReasoningPassbackPolicy', () => {
  afterEach(() => resetSchemaRegistryForTesting());

  it('DeepSeek preserves reasoning across all turns, including non-tool replies', () => {
    getSchemaRegistry();
    for (const model of ['deepseek-v4-pro', 'deepseek-v4.1-flash', 'deepseek-flash']) {
      expect(resolveReasoningPassbackPolicy(model)).toBe('always');
    }
  });

  it('undeclared family falls back to with_tool_calls default', () => {
    getSchemaRegistry();
    expect(resolveReasoningPassbackPolicy('gpt-5.5')).toBe('with_tool_calls');
  });

  it('missing model falls back to default', () => {
    expect(resolveReasoningPassbackPolicy(undefined)).toBe('with_tool_calls');
  });
});

describe('DeepSeek reasoning on the wire', () => {
  const tools = [{
    name: 'readfile', description: 'Read a file',
    parameters: { type: 'object', properties: {} }, function: () => '',
  }];
  const toolCall = { id: 't1', type: 'function', function: { name: 'readfile', arguments: '{}' } };
  const build = (messages: any[], model = 'deepseek-v4.1-flash', withTools = true) => {
    const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://example.test/v1', defaultModel: model });
    return (provider as any).buildChatCompletionsPayload(messages, {
      model, tools: withTools ? tools : undefined, stream: true, temperature: 1,
    }).messages;
  };

  it('keeps exact reasoning for tool calls AND final answers across user turns', () => {
    const messages = [
      { role: 'user', content: 'Read the file' },
      { role: 'assistant', content: '', reasoning_content: 'inspect\nfirst', tool_calls: [toolCall] },
      { role: 'tool', tool_call_id: 't1', content: 'contents' },
      { role: 'assistant', content: 'Done', reasoning_content: 'the result is complete' },
      { role: 'user', content: 'Now check the next file' },
    ];
    const snapshot = JSON.stringify(messages);
    expect(build(messages).filter((m: any) => m.role === 'assistant').map((m: any) => m.reasoning_content))
      .toEqual(['inspect\nfirst', 'the result is complete']);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('supplies an empty field for legacy/model-switch history without inventing reasoning', () => {
    const messages = [
      { role: 'assistant', content: 'empty', reasoning_content: '' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'legacy' },
      { role: 'assistant', content: '', reasoning_content: null, tool_calls: [toolCall] },
      { role: 'tool', tool_call_id: 't1', content: 'contents' },
    ];
    const snapshot = JSON.stringify(messages);
    const result = build(messages);
    expect(result[0].reasoning_content).toBe('');
    expect(result[2].reasoning_content).toBe('');
    expect(result[3].reasoning_content).toBe('');
    expect(result[1]).not.toHaveProperty('reasoning_content');
    expect(result[4]).not.toHaveProperty('reasoning_content');
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('retains reasoning without tools too (DeepSeek ignores it in this mode)', () => {
    expect(build([{ role: 'assistant', content: 'answer', reasoning_content: 'thinking' }], 'deepseek-v4-pro', false)[0])
      .toHaveProperty('reasoning_content', 'thinking');
  });

  it('does not change the passback policy for unrelated models', () => {
    const result = build([
      { role: 'assistant', content: 'answer', reasoning_content: 'text-only' },
      { role: 'assistant', content: '', reasoning_content: 'tool-turn', tool_calls: [toolCall] },
      { role: 'assistant', content: 'legacy' },
      { role: 'assistant', content: '', tool_calls: [toolCall] },
    ], 'gpt-5.5');
    expect(result[0]).not.toHaveProperty('reasoning_content');
    expect(result[1].reasoning_content).toBe('tool-turn');
    expect(result[2]).not.toHaveProperty('reasoning_content');
    expect(result[3]).not.toHaveProperty('reasoning_content');
  });

  it('never passes reasoning to a family declaring never', () => {
    const result = build([
      { role: 'assistant', content: 'answer', reasoning_content: 'thinking' },
      { role: 'assistant', content: '', reasoning_content: 'tool', tool_calls: [toolCall] },
    ], 'qwen3.5-plus');
    for (const message of result) expect(message).not.toHaveProperty('reasoning_content');
  });
});
