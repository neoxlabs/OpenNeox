import { describe, expect, it } from 'vitest';
import { hoistToolResultImagesForDeepSeek } from '../anthropicMessageCompat';

const img = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } };
const msgs = () => [{
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'a.png' }, img] },
    { type: 'tool_result', tool_use_id: 'b', content: 'ok' },
    { type: 'text', text: 'reminder' },
  ],
}];

describe('hoistToolResultImagesForDeepSeek', () => {
  it('DeepSeek: 图片挪到全部 tool_result 之后, tool_result 里只留文字', () => {
    const m = msgs();
    expect(hoistToolResultImagesForDeepSeek(m, 'https://api.deepseek.com/anthropic', 'deepseek-v4.1-flash')).toBe(1);
    expect(m[0].content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'image', 'text']);
    expect((m[0].content[0] as any).content).toEqual([{ type: 'text', text: 'a.png' }]);
  });

  it('只有图片的 tool_result 补一句说明', () => {
    const m = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [img] }] }];
    hoistToolResultImagesForDeepSeek(m, 'https://relay.example.com', 'deepseek-v4.1-flash');
    expect((m[0].content[0] as any).content[0].text).toMatch(/1 image/);
  });

  it('Claude / 其它目标不动', () => {
    const m = msgs();
    expect(hoistToolResultImagesForDeepSeek(m, 'https://api.anthropic.com', 'claude-opus-4-7')).toBe(0);
    expect(hoistToolResultImagesForDeepSeek(m, 'https://api.moonshot.cn/anthropic', 'kimi-k2.6')).toBe(0);
    expect(m[0].content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
  });
});
