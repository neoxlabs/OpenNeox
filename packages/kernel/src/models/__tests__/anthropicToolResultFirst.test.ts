import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

const provider = () =>
  new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://example.invalid', model: 'claude-x' } as any) as any;

describe('Anthropic 合并后的 user 消息: tool_result 在前', () => {
  it('夹在 tool 结果中间的图片附件被排到全部 tool_result 之后', () => {
    const { anthropicMessages } = provider().convertMessages(
      [
        { role: 'user', content: '测测读取能力' },
        {
          role: 'assistant',
          content: '一起读',
          tool_calls: ['A', 'B'].map((id) => ({ id, type: 'function', function: { name: 'readfile', arguments: '{}' } })),
        },
        { role: 'tool', tool_call_id: 'A', content: '[readfile 返回了 1 张图片]' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '[系统注入] 图片' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
        { role: 'tool', tool_call_id: 'B', content: 'ok' },
      ],
      { disableCaching: true },
    );
    const last = anthropicMessages[anthropicMessages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'image']);
    expect(last.content.slice(0, 2).map((b: any) => b.tool_use_id)).toEqual(['A', 'B']);
  });
});
