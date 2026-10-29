import { describe, expect, it } from 'vitest';
import { pickPilotCallModel } from '../callModel';

const m = (id: string, baseUrl: string) => ({ id, name: id.split(':')[1], baseUrl });

describe('pickPilotCallModel', () => {
  it('只挑 DeepSeek 官方渠道, 优先 deepseek-flash', () => {
    const picked = pickPilotCallModel([
      m('opencode-zen:deepseek-flash', 'https://opencode.ai/zen/go/v1'),
      m('deepseekmk:deepseek-v4-flash', 'https://api.deepseek.com/anthropic'),
      m('deepseekmk:deepseek-flash', 'https://api.deepseek.com/anthropic'),
    ]);
    expect(picked?.id).toBe('deepseekmk:deepseek-flash');
  });

  it('只有中转站的 = 不动 (中转是假流式)', () => {
    expect(pickPilotCallModel([m('opencode-zen:deepseek-flash', 'https://opencode.ai/zen/go/v1')])).toBeNull();
  });

  it('路径里带 deepseek.com 的中转不算', () => {
    expect(pickPilotCallModel([m('x:deepseek-flash', 'https://proxy.example.com/api.deepseek.com')])).toBeNull();
  });
});
