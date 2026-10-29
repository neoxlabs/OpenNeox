import { describe, expect, it } from 'vitest';
import {
  anyConfiguredProviderSupportsWebSearch,
  neoxCloudSearchConfigured,
  providerSupportsWebSearch,
  webSearchAvailable,
  webSearchExternallyConfigured,
} from '../capabilityFilters.js';

describe('webSearch availability gates', () => {
  it('providerSupportsWebSearch covers native protocols only', () => {
    expect(providerSupportsWebSearch('anthropic')).toBe(true);
    expect(providerSupportsWebSearch('openai-responses')).toBe(true);
    expect(providerSupportsWebSearch('kimi')).toBe(true);
    expect(providerSupportsWebSearch('grok')).toBe(true);
    expect(providerSupportsWebSearch('deepseek')).toBe(true);
    expect(providerSupportsWebSearch('glm')).toBe(false);
    expect(providerSupportsWebSearch('openai')).toBe(true);
  });

  it('anyConfiguredProviderSupportsWebSearch sees non-default Claude/GPT/Kimi/Grok', () => {
    const config = {
      defaultProviderId: 'deepseek',
      providers: {
        deepseek: { protocol: 'deepseek' },
        luccio: { protocol: 'anthropic' },
        oauthGrok: { protocol: 'grok' },
      },
    };
    expect(anyConfiguredProviderSupportsWebSearch(config)).toBe(true);
    expect(webSearchAvailable(config, 'deepseek')).toBe(true);
  });

  it('grok-only config is available without external backend', () => {
    const config = {
      defaultProviderId: 'oauth-grok',
      providers: { 'oauth-grok': { protocol: 'grok', baseUrl: 'https://api.x.ai/v1' } },
    };
    expect(webSearchAvailable(config, 'grok')).toBe(true);
  });

  it('deepseek-only config is available (official endpoint has server-side search); glm-only is not', () => {
    const config = {
      defaultProviderId: 'deepseek',
      providers: { deepseek: { protocol: 'deepseek' } },
      webSearch: { enabled: true },
    };
    expect(webSearchAvailable(config, 'deepseek')).toBe(true);
    /* DeepSeek 常被配成 openai 协议 + api.deepseek.com; 域名兜底也要认 */
    expect(webSearchAvailable({ providers: { ds: { protocol: 'openai', baseUrl: 'https://api.deepseek.com' } } }, 'glm')).toBe(true);
    expect(webSearchAvailable({ providers: { glm: { protocol: 'glm' } }, webSearch: { enabled: true } }, 'glm')).toBe(false);
  });

  it('Neox 订阅 (sentinel neox-cloud) 给所有模型开搜索 —— 只在自带档', () => {
    const glmOnly = { providers: { glm: { protocol: 'glm' }, 'neox-cloud': { protocol: 'openai', apiKey: 'neox-managed' } } };
    expect(neoxCloudSearchConfigured(glmOnly)).toBe(true);
    expect(webSearchAvailable({ ...glmOnly, webSearch: { enabled: true } }, 'glm')).toBe(true);
    /* 用户显式选了外部后端: 不算网关 (但外部后端本身配齐了照样可用) */
    expect(neoxCloudSearchConfigured({ ...glmOnly, webSearch: { engine: 'serper' } })).toBe(false);
    /* 数组形态的 providers 也认 */
    expect(neoxCloudSearchConfigured({ providers: [{ id: 'neox-cloud' }] })).toBe(true);
    expect(neoxCloudSearchConfigured({ providers: { glm: { protocol: 'glm' } } })).toBe(false);
  });

  it('external bocha/serper key unlocks domestic models', () => {
    const config = {
      providers: { deepseek: { protocol: 'deepseek' } },
      webSearch: { engine: 'bocha', apiKey: 'bk-test' },
    };
    expect(webSearchExternallyConfigured(config)).toBe(true);
    expect(webSearchAvailable(config, 'deepseek')).toBe(true);
  });
});
