import { describe, expect, it } from 'vitest';
import { resolveModelFlag } from '../modelFlag.js';

const providers = [
  { id: 'laogou-claude', models: [{ name: 'claude-sonnet-5' }] },
  { id: 'deepseek', models: [{ name: 'deepseek-v4-flash' }] },
  { id: 'deepseekmk', models: ['deepseek-v4-flash'] },
  { id: 'opencode-zen', models: [{ name: 'deepseek-v4.1-flash' }] },
];

describe('resolveModelFlag', () => {
  it('provider:模型 (桌面 / 手机的模型 id 写法) → 拆开', () => {
    expect(resolveModelFlag('opencode-zen:deepseek-v4.1-flash', providers, 'laogou-claude'))
      .toEqual({ provider: 'opencode-zen', model: 'deepseek-v4.1-flash' });
  });
  it('只给模型名 → 找有这个模型的 provider, 不落到默认那家', () => {
    expect(resolveModelFlag('deepseek-v4.1-flash', providers, 'laogou-claude')).toEqual({ provider: 'opencode-zen', model: 'deepseek-v4.1-flash' });
  });
  it('多家都有 → 默认 provider 优先, 否则第一家', () => {
    expect(resolveModelFlag('deepseek-v4-flash', providers, 'deepseekmk').provider).toBe('deepseekmk');
    expect(resolveModelFlag('deepseek-v4-flash', providers, 'laogou-claude').provider).toBe('deepseek');
  });
  it('默认是 neox-cloud 且订阅有这个模型 → 走订阅, 不落到同名 BYOK', () => {
    expect(resolveModelFlag('deepseek-v4-flash', providers, 'neox-cloud', ['deepseek-v4-flash']))
      .toEqual({ provider: 'neox-cloud', model: 'deepseek-v4-flash' });
    expect(resolveModelFlag('claude-sonnet-5', providers, 'neox-cloud', ['deepseek-v4-flash']).provider).toBe('laogou-claude');
  });
  it('对不上 → 原样 (含冒号但前缀不是 provider 的模型名, 例 ollama 的 qwen3:8b)', () => {
    expect(resolveModelFlag('qwen3:8b', providers)).toEqual({ model: 'qwen3:8b' });
  });
});
