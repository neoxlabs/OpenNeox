import { describe, expect, it } from 'vitest';
import { inferProviderBrand } from '../ProviderBrandIcon';

/* 全部模拟"经 Anthropic 兼容网关接入" */
const viaAnthropicGateway = (id: string) =>
  inferProviderBrand({ id, name: id, protocol: 'anthropic', providerId: 'opencode' });

describe('Anthropic 网关里的非 Claude 模型不许挂 Claude 图标', () => {
  const cases: Array<[string, string]> = [
    ['deepseek-v4-pro', 'deepseek'],
    ['deepseek-v4-flash-vision-exp', 'deepseek'],
    ['glm-5.3-flash', 'glm'],
    ['glm-5.2', 'glm'],
    ['kimi-k3', 'kimi'],
    ['minimax-m3', 'minimax'],
    ['qwen3.8-max', 'qwen'],
    ['gpt-5.6-luna', 'openai'],
    ['grok-4.6', 'xai'],
    ['mimo-v2-pro', 'mimo'],
    /* 腾讯混元 —— 网关上只写 hy3 / hy4-preview, 不出现 hunyuan 字样 */
    ['hy4-preview', 'hunyuan'],
    ['hy3', 'hunyuan'],
  ];
  for (const [id, brand] of cases) {
    it(`${id} → ${brand}`, () => expect(viaAnthropicGateway(id)).toBe(brand));
  }

  it('真 Claude 模型仍然是 anthropic', () => {
    expect(viaAnthropicGateway('claude-opus-4-6')).toBe('anthropic');
  });

  it('名字认不出品牌时宁可不显示, 也不许拿 protocol 猜成 Claude', () => {
    expect(inferProviderBrand({ id: 'longcat-2.0', protocol: 'anthropic', providerId: 'opencode' })).toBe('generic');
    expect(inferProviderBrand({ id: 'omen-alpha', protocol: 'anthropic', providerId: 'opencode' })).toBe('generic');
    expect(inferProviderBrand({ id: 'my-relay-model', protocol: 'anthropic' })).toBe('generic');
    expect(inferProviderBrand({ id: 'my-relay-model', protocol: 'gemini' })).toBe('generic');
  });

  it('真 Claude / Gemini 靠**名字**认, 不靠协议 (上游只接受 claude-* / gemini-* 这类 id)', () => {
    expect(inferProviderBrand({ id: 'claude-sonnet-4-5', protocol: 'openai' })).toBe('anthropic');
    expect(inferProviderBrand({ id: 'gemini-3-pro', protocol: 'openai' })).toBe('gemini');
  });
});

describe('品牌图标资源完整性', () => {
  it('联合类型里每个真实品牌都有 svg 文件', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const have = new Set(
      readdirSync(join(here, '../../../assets/icons/providers'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => f.replace(/\.svg$/, '')),
    );
    /* auto 走 Neox 自己的 png mark, generic 是"不显示", 两者不需要 svg */
    const brands = [
      'openai', 'anthropic', 'gemini', 'kimi', 'mimo', 'deepseek',
      'glm', 'doubao', 'qwen', 'xai', 'mistral', 'minimax', 'hunyuan',
    ];
    const missing = brands.filter((b) => !have.has(b));
    expect(missing).toEqual([]);
  });
});
