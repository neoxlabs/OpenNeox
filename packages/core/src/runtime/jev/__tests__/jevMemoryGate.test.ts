import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeWorthRemembering, lastExchange, worthRemembering } from '../jevMemoryGate.js';

describe('lastExchange', () => {
  it('取最后一条有文字的用户消息和它之后的助手文字, 跳过工具结果', () => {
    const got = lastExchange([
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '以后提交信息都用英文' },
      { role: 'assistant', content: [{ type: 'text', text: '好的。' }, { type: 'tool_use', id: 't', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      { role: 'assistant', content: '已记下。' },
    ]);
    expect(got).toEqual({ user: '以后提交信息都用英文', reply: '好的。\n已记下。' });
  });

  it('没有用户文字 → null', () => {
    expect(lastExchange([{ role: 'assistant', content: 'hi' }])).toBeNull();
  });
});

describe('worthRemembering', () => {
  it('两题取较大值, 0.3 起提取', () => {
    expect(worthRemembering({ rule: 0.38, lesson: 0.1, ms: 1 })).toBe(true);
    expect(worthRemembering({ rule: 0.05, lesson: 0.3, ms: 1 })).toBe(true);
    expect(worthRemembering({ rule: 0.2, lesson: 0.15, ms: 1 })).toBe(false);
  });
});

describe('judgeWorthRemembering', () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings = { apiKey: 'k', model: 'jev-latest' };

  it('两题一次请求, 读回两个概率', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      answers: { rule: { type: 'noul', noul: 0.9 }, lesson: { type: 'noul', noul: 0.1 } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const v = await judgeWorthRemembering(settings, { user: 'u', reply: 'r' });
    expect(v?.rule).toBe(0.9);
    expect(v?.lesson).toBe(0.1);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(Object.keys(body.questions)).toEqual(['rule', 'lesson']);
    expect(body.state).toEqual({ user: 'u', assistant: 'r' });
  });

  it('请求失败 → null (调用方照常提取)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    expect(await judgeWorthRemembering(settings, { user: 'u', reply: 'r' })).toBeNull();
  });
});
