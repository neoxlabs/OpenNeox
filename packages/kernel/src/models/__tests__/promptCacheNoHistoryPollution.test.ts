import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';

const CLAUDE = 'claude-sonnet-5';
const DS = 'deepseek-v4-flash';

const provider = (baseUrl: string, defaultModel: string): any =>
  new OpenAIProvider({ apiKey: 'k', baseUrl, defaultModel } as any);

/** 走真实发线路径的两步：格式化消息 → 注入/清洗 breakpoint */
function buildPayload(p: any, history: any[], model: string): any {
  const messages = p.formatMessagesForChatCompletions(history, model);
  const payload: any = { model, messages };
  p.injectPromptCacheBreakpoints(payload, model);
  return payload;
}

/** 长会话里真实的形状：content 是数组（压缩快照恢复 / 多段文本注入） */
const historyWithArrayTail = () => [
  { role: 'system', content: 'you are neox' },
  { role: 'user', content: [{ type: 'text', text: '第一问' }, { type: 'text', text: '补充' }] },
  { role: 'assistant', content: '答一' },
  { role: 'user', content: [{ type: 'text', text: '第二问' }] },
];

const partsWith = (payload: any): any[] =>
  payload.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));

describe('cache_control 不许污染会话历史', () => {
  it('Claude 注入后历史原件一个字节都不变', () => {
    const history = historyWithArrayTail();
    const before = JSON.stringify(history);
    const payload = buildPayload(provider('https://relay-h.example', CLAUDE), history, CLAUDE);

    /* 功能不能回退：本次请求仍然打了 breakpoint */
    expect(partsWith(payload).some((p) => p.cache_control?.type === 'ephemeral')).toBe(true);
    /* 但历史必须干净 */
    expect(JSON.stringify(history)).toBe(before);
  });

  it('污染过的存量历史发给 DeepSeek 时被剥干净，且历史不被改', () => {
    const dirty = [
      { role: 'system', content: 'you are neox' },
      { role: 'user', content: [{ type: 'text', text: '问' }, { type: 'text', text: '补充' }, { type: 'text', text: '第三段', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: '答' },
      { role: 'user', content: [{ type: 'text', text: '再问' }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(dirty));

    const payload = buildPayload(provider('https://api.deepseek.com', DS), dirty, DS);

    expect(partsWith(payload).some((p) => 'cache_control' in p)).toBe(false);
    /* 只清洗本次 payload，不替上层改历史 */
    expect(dirty).toEqual(snapshot);
  });

  it('DeepSeek 的字符串 content 保持字符串，不被无谓包成数组', () => {
    const history = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: '继续' },
    ];
    const payload = buildPayload(provider('https://api.deepseek.com', DS), history, DS);
    expect(payload.messages[0].content).toBe('你好');
    expect(payload.messages[2].content).toBe('继续');
  });
});
