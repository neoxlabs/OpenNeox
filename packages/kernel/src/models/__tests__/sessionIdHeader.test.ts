/**
 * chat/completions 必须带 session_id
 *
 *   opencode 上的 mimo-v2.5 / mimo-v2.5-pro / longcat-2.0 / omen-alpha 把它当**必填**:
 *   不带就直接 400 MissingSessionID ("Request is missing session id")。补上立刻 200。
 *
 *   我们本来就有 sessionId (prompt_cache_key 用的就是它), 只是从没往上游发过 ——
 *   这是我们的适配缺口, 不是上游的毛病。我一开始把这四个模型记成"上游坏了", 是误判:
 *   把自己的缺口当成对方的问题, 就永远不会去修。
 *
 *   Responses API 那条路 (buildResponses* 的 headers) 早就在发这两个头,
 *   chat/completions 这条一直漏着 —— 同一件事只做了一半。
 */
import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';

const headersOf = (p: OpenAIProvider): Record<string, string> =>
  ((p as unknown as { client: { defaults: { headers: Record<string, string> } } }).client.defaults.headers);

describe('OpenAI 兼容客户端的会话头', () => {
  it('显式传入的 sessionId 原样进 header', () => {
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'm', sessionId: 'sess-abc' } as never);
    const h = headersOf(p);
    expect(h.session_id).toBe('sess-abc');
    /* 两个名字都发 —— conversation_id 是 Codex 系网关认的那个叫法 */
    expect(h.conversation_id).toBe('sess-abc');
  });

  it('没传也要有值 —— 空字符串会被上游当成"没带", 照样 400', () => {
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'm' } as never);
    const h = headersOf(p);
    expect(h.session_id).toBeTruthy();
    expect(h.session_id.length).toBeGreaterThan(8);
    expect(h.session_id).toBe(h.conversation_id);
  });

  it('不同实例的兜底 id 不同 —— 撞在一起会让上游把两个会话当成一个', () => {
    const a = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'm' } as never);
    const b = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'm' } as never);
    expect(headersOf(a).session_id).not.toBe(headersOf(b).session_id);
  });
});
