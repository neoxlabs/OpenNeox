import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAIProvider, setExternalHmacSigner, setNeoxDeviceFp } from '../openai.js';


type Captured = { headers: Record<string, string> };

async function send(provider: OpenAIProvider): Promise<Captured> {
  let captured: Captured = { headers: {} };
  await (provider as any).client.request({
    url: '/chat/completions',
    method: 'post',
    data: { model: 'x', messages: [] },
    adapter: async (cfg: any) => {
      const h = cfg.headers?.toJSON ? cfg.headers.toJSON() : { ...cfg.headers };
      captured = { headers: h };
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg };
    },
  });
  return captured;
}

function cloudProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'nxk_test_0123456789',
    baseUrl: 'https://gateway.example.com/n1',
    defaultModel: 'x',
  });
}

describe('NeoxCloud 请求签名 fail-open', () => {
  const prevAead = process.env.NEOX_BODY_AEAD;
  beforeEach(() => {
    process.env.NEOX_BODY_AEAD = '0';
    setNeoxDeviceFp('fp-test');
  });
  afterEach(() => {
    setExternalHmacSigner(undefined as any);
    if (prevAead === undefined) delete process.env.NEOX_BODY_AEAD;
    else process.env.NEOX_BODY_AEAD = prevAead;
  });

  it('签名器正常: 带签名头', async () => {
    setExternalHmacSigner(async () => ({ ts: '1', nonce: 'n', sig: 'deadbeef', version: 'vtest', proto: 2 }));
    const { headers } = await send(cloudProvider());
    expect(headers['X-Sig']).toBe('deadbeef');
    expect(headers['X-Sig-Proto']).toBe('2');
    expect(headers['X-Device-FP']).toBe('fp-test');
  });

  it('签名器抛错: 请求照发, 不带签名, 带设备指纹', async () => {
    setExternalHmacSigner(async () => { throw new Error('boom'); });
    const { headers } = await send(cloudProvider());
    expect(headers['X-Sig']).toBeUndefined();
    expect(headers['X-Device-FP']).toBe('fp-test');
  });

  it('没有签名器 (未签名构建): 请求照发, 不带签名, 带设备指纹', async () => {
    setExternalHmacSigner(null);
    const { headers } = await send(cloudProvider());
    expect(headers['X-Sig']).toBeUndefined();
    expect(headers['X-Device-FP']).toBe('fp-test');
  });

  it('BYOK key 不签名也不带设备指纹 (请求不经过 NeoxCloud)', async () => {
    setExternalHmacSigner(async () => ({ ts: '1', nonce: 'n', sig: 'deadbeef', version: 'vtest', proto: 2 }));
    const provider = new OpenAIProvider({ apiKey: 'sk-byok', baseUrl: 'https://api.deepseek.com', defaultModel: 'x' });
    const { headers } = await send(provider);
    expect(headers['X-Sig']).toBeUndefined();
    expect(headers['X-Device-FP']).toBeUndefined();
  });
});
