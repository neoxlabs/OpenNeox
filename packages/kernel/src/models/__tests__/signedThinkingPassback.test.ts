import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';
import { withSignedThinking } from '../signedThinkingPassback.js';

const signed = { type: 'thinking', thinking: '先看需求', signature: 'sig-1' };
const unsigned = { type: 'thinking', thinking: '自己拼的', signature: '' };
const toolCall = { id: 't1', type: 'function', function: { name: 'readfile', arguments: '{}' } };
const history = [
  { role: 'user', content: '按 TASK.md 实现' },
  { role: 'assistant', content: '先读需求。', tool_calls: [toolCall], thinking_blocks: [signed, unsigned] },
  { role: 'tool', tool_call_id: 't1', content: '# 需求' },
];
const wire = (apiKey: string, model = 'claude-opus-5-5') => {
  const provider = new OpenAIProvider({ apiKey, baseUrl: 'https://example.test/v1', defaultModel: model, disableSigning: true });
  return (provider as any).buildChatCompletionsPayload(history, { model, stream: true, temperature: 1 }).messages;
};

describe('收: 网关一块一帧下发, 累加后挂到 chunk 顶层', () => {
  it('多帧累加, 没有思考块的帧原样交出', () => {
    const acc: unknown[] = [];
    const a = withSignedThinking({ choices: [{ delta: { thinking_blocks: [signed] } }] }, acc) as any;
    const b = withSignedThinking({ choices: [{ delta: { thinking_blocks: [{ ...signed, signature: 'sig-2' }] } }] }, acc) as any;
    const text = { choices: [{ delta: { content: 'hi' } }] };
    expect(a.thinking_blocks).toHaveLength(1);
    expect(b.thinking_blocks.map((x: any) => x.signature)).toEqual(['sig-1', 'sig-2']);
    expect(withSignedThinking(text, acc)).toBe(text);
  });
});

describe('发: 只把带签名的块带回 Neox 网关', () => {
  it('发给网关: 只带有签名的那块', () => {
    const asst = wire('nxk_test').find((m: any) => m.role === 'assistant');
    expect(asst.thinking_blocks).toEqual([signed]);
  });

  it('发给别家 OpenAI 兼容接口: 不带这个字段', () => {
    const asst = wire('sk-thirdparty').find((m: any) => m.role === 'assistant');
    expect(asst.thinking_blocks).toBeUndefined();
  });
});
