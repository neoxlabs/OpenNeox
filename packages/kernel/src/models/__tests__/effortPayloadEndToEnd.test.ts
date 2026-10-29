
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../openai.js';
import { AnthropicProvider } from '../anthropic.js';
import { GLMProvider } from '../glm.js';
import { KimiProvider } from '../kimi.js';
import { getSchemaRegistry, resetSchemaRegistryForTesting } from '../../schemas/loader.js';

beforeAll(() => {
  resetSchemaRegistryForTesting();
  getSchemaRegistry();
});

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

async function* bufferStream(text: string): AsyncGenerator<Buffer> {
  yield Buffer.from(text);
}

const CHAT_SSE = [
  `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const ANTHROPIC_SSE = [
  { type: 'message_start', message: { id: 'm1', usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
  { type: 'message_stop' },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** Anthropic / OpenAI 直连 axios 的 provider: 拦 client.post, 返回一段立刻结束的 SSE。 */
async function captureAxiosPayload(
  provider: any,
  sseText: string,
  run: () => AsyncGenerator<any>,
): Promise<any> {
  let captured: any;
  provider.client.post = async (_path: string, payload: any) => {
    captured = payload;
    return { status: 200, headers: {}, data: bufferStream(sseText) };
  };
  for await (const _chunk of run()) { /* 消费完 SSE, 只为走完整条链路 */ }
  return captured;
}

/** GLM / Kimi 走 OpenAICompatibleClient.streamJsonEvents: 拦这一层拿 payload。 */
async function captureCompatiblePayload(
  provider: any,
  run: () => AsyncGenerator<any>,
): Promise<any> {
  let captured: any;
  provider.client.streamJsonEvents = async function* (_path: string, payload: any) {
    captured = payload;
    yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
  };
  for await (const _chunk of run()) { /* drain */ }
  return captured;
}

function makeOpenAI(model: string): any {
  return new OpenAIProvider({
    apiKey: 'nxk_test_key',
    baseUrl: 'https://gateway.example.invalid/v1',
    defaultModel: model,
    disableSigning: true,
  } as any);
}

describe('Anthropic · claude-opus-4-8', () => {
  it('high 档: thinking=adaptive + output_config.effort=high, 不自带 temperature', async () => {
    const provider: any = new AnthropicProvider({
      authToken: 'k',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-4-8',
    } as any);

    const payload = await captureAxiosPayload(provider, ANTHROPIC_SSE, () =>
      provider.chatStreamed(MESSAGES, { model: 'claude-opus-4-8', effortLevel: 'high' }));

    expect(payload.model).toBe('claude-opus-4-8');
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.output_config).toEqual({ effort: 'high' });
    expect(payload.temperature).toBeUndefined();
  });
});

describe('OpenAI chat completions · deepseek-v4.1-flash', () => {
  it('high 档: thinking=enabled + reasoning_effort=high', async () => {
    const provider = makeOpenAI('deepseek-v4.1-flash');
    const payload = await captureAxiosPayload(provider, CHAT_SSE, () =>
      provider.chatStreamed(MESSAGES, { model: 'deepseek-v4.1-flash', effortLevel: 'high' } as any));

    expect(payload.model).toBe('deepseek-v4.1-flash');
    expect(payload.thinking).toEqual({ type: 'enabled' });
    expect(payload.reasoning_effort).toBe('high');
  });

  it('off 档: 明发 thinking=disabled, 不带 reasoning_effort', async () => {
    const provider = makeOpenAI('deepseek-v4.1-flash');
    const payload = await captureAxiosPayload(provider, CHAT_SSE, () =>
      provider.chatStreamed(MESSAGES, { model: 'deepseek-v4.1-flash', effortLevel: 'off' } as any));

    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.reasoning_effort).toBeUndefined();
  });

  it('不传档位: 按 yaml default_level 发 high (开思考真的进 payload)', async () => {
    const provider = makeOpenAI('deepseek-v4.1-flash');
    const payload = await captureAxiosPayload(provider, CHAT_SSE, () =>
      provider.chatStreamed(MESSAGES, { model: 'deepseek-v4.1-flash' } as any));

    expect(payload.thinking).toEqual({ type: 'enabled' });
    expect(payload.reasoning_effort).toBe('high');
  });
});

describe('OpenAI chat completions · gpt-5.6-sol', () => {
  it('xhigh 档: reasoning_effort=xhigh + verbosity=high', async () => {
    const provider = makeOpenAI('gpt-5.6-sol');
    const payload = await captureAxiosPayload(provider, CHAT_SSE, () =>
      provider.chatStreamed(MESSAGES, { model: 'gpt-5.6-sol', effortLevel: 'xhigh' } as any));

    expect(payload.model).toBe('gpt-5.6-sol');
    expect(payload.reasoning_effort).toBe('xhigh');
    expect(payload.verbosity).toBe('high');
  });
});

describe('GLM · glm-5.3-flash', () => {
  it('high 档: reasoning_effort=high', async () => {
    const provider: any = new GLMProvider({
      apiKey: 'k',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: 'glm-5.3-flash',
    } as any);

    const payload = await captureCompatiblePayload(provider, () =>
      provider.chatStreamed(MESSAGES, { model: 'glm-5.3-flash', effortLevel: 'high' }));

    expect(payload.model).toBe('glm-5.3-flash');
    expect(payload.reasoning_effort).toBe('high');
  });
});

describe('Kimi · kimi-k2.7-code', () => {
  it('high 档: reasoning_effort=high', async () => {
    const provider: any = new KimiProvider({
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'kimi-k2.7-code',
    } as any);

    const payload = await captureCompatiblePayload(provider, () =>
      provider.chatStreamed(MESSAGES, { model: 'kimi-k2.7-code', effortLevel: 'high' }));

    expect(payload.model).toBe('kimi-k2.7-code');
    expect(payload.reasoning_effort).toBe('high');
  });
});
