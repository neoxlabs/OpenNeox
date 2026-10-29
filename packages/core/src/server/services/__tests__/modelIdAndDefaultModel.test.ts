import { describe, expect, it } from 'vitest';
import { toModelId } from '../modelIdNormalize.js';
import { prepareChatRequest } from '../chatRequestPreparation.js';

describe('toModelId', () => {
  const napiGrok = { models: [{ id: 'grok-4.5', name: 'Grok 4.5' }, { id: 'grok-4.3', name: 'Grok 4.3' }] };

  it('显示名 → id', () => {
    expect(toModelId(napiGrok, 'Grok 4.5')).toBe('grok-4.5');
  });

  it('本来就是 id 的原样返回', () => {
    expect(toModelId(napiGrok, 'grok-4.3')).toBe('grok-4.3');
  });

  it('规范形状 (name 就是 id) 不动', () => {
    expect(toModelId({ models: [{ name: 'deepseek-v4-flash' }] }, 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('不认识的值 / 空值原样返回', () => {
    expect(toModelId(napiGrok, 'some-other-model')).toBe('some-other-model');
    expect(toModelId(napiGrok, '')).toBe('');
    expect(toModelId(undefined, 'x')).toBe('x');
  });
});

describe('prepareChatRequest 默认模型名只属于默认 provider', () => {
  const base = { currentMode: 'agentic' as any, defaultProviderId: 'napi-grok', defaultModelName: 'grok-4.5' };

  it('点名 neox-cloud 却没带 modelName → 不拼默认 provider 的模型名', () => {
    const { metadata } = prepareChatRequest({ ...base, request: { prompt: 'hi', providerId: 'neox-cloud' } as any });
    expect((metadata as any).providerId).toBe('neox-cloud');
    expect((metadata as any).modelName).toBeUndefined();
  });

  it('没点名 provider → 照旧用 server 默认', () => {
    const { metadata } = prepareChatRequest({ ...base, request: { prompt: 'hi' } as any });
    expect((metadata as any).providerId).toBe('napi-grok');
    expect((metadata as any).modelName).toBe('grok-4.5');
  });

  it('点名的就是默认 provider → 可以用默认模型名', () => {
    const { metadata } = prepareChatRequest({ ...base, request: { prompt: 'hi', providerId: 'napi-grok' } as any });
    expect((metadata as any).modelName).toBe('grok-4.5');
  });

  it('请求自己带了 modelName 一律用请求的', () => {
    const { metadata } = prepareChatRequest({ ...base, request: { prompt: 'hi', providerId: 'neox-cloud', modelName: 'qwen3.8-flash' } as any });
    expect((metadata as any).modelName).toBe('qwen3.8-flash');
  });
});
