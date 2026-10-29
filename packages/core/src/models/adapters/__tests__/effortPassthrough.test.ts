/** 思考档位和 side-agent 的关闭选项必须经 adapter 传给 provider。 */
import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../openai.js';

function captureStreamOptions(adapter: OpenAIAdapter): { calls: any[] } {
  const calls: any[] = [];
  (adapter as any).provider.chatStreamed = async function* (_messages: any, opts: any) {
    calls.push(opts);
  };
  return { calls };
}

async function drain(gen: AsyncGenerator<any>): Promise<void> {
  for await (const _ of gen) { /* noop */ }
}

describe('OpenAIAdapter effortLevel passthrough', () => {
  const adapter = () => new OpenAIAdapter({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4.1-flash' });
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('用户关思考 → provider 收到 effortLevel=off', async () => {
    const a = adapter();
    const { calls } = captureStreamOptions(a);
    await drain(a.chatStreamed(messages, { model: 'deepseek-v4.1-flash', effortLevel: 'off' }));
    expect(calls[0].effortLevel).toBe('off');
  });

  it('disableThinking (side-agent) 优先于用户档位', async () => {
    const a = adapter();
    const { calls } = captureStreamOptions(a);
    await drain(a.chatStreamed(messages, { model: 'deepseek-v4.1-flash', effortLevel: 'max', disableThinking: true }));
    expect(calls[0].effortLevel).toBe('off');
    expect(calls[0].reasoningEffortOverride).toBe('minimal');
  });

  it('没选档位 → 不发 effortLevel, provider 走 yaml 默认档', async () => {
    const a = adapter();
    const { calls } = captureStreamOptions(a);
    await drain(a.chatStreamed(messages, { model: 'deepseek-v4.1-flash' }));
    expect('effortLevel' in calls[0]).toBe(false);
  });

  it('非流式 chat() 把 maxTokens 和 signal 传给 provider', async () => {
    const a = adapter();
    const calls: any[] = [];
    (a as any).provider.chat = async (_m: any, opts: any) => { calls.push(opts); return { choices: [] }; };
    const ctrl = new AbortController();
    await a.chat(messages, { model: 'deepseek-v4.1-flash', maxTokens: 40, signal: ctrl.signal, disableThinking: true });
    expect(calls[0].maxTokens).toBe(40);
    expect(calls[0].signal).toBe(ctrl.signal);
    expect(calls[0].effortLevel).toBe('off');
  });
});
