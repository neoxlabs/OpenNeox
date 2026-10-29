import { describe, it, expect } from 'vitest';
import { inferProviderBrand } from '../ProviderBrandIcon';

describe('inferProviderBrand — 用户实拍的缺图标行', () => {
  it('GPT Image 系列: 品牌只在 name 里且写成空格分隔', () => {
    /* 副标题是 "relay-a · 出图" → id 是数字编号, 品牌信息只在 name */
    expect(inferProviderBrand({ id: 'relay-a', name: 'GPT Image 2 Pro (23s · 横版)' })).toBe('openai');
    expect(inferProviderBrand({ id: 'relay-a', name: 'GPT Image 2' })).toBe('openai');
    expect(inferProviderBrand({ id: 'relay-a', name: 'GPT Image 2 4K' })).toBe('openai');
  });

  it('MiniMax 两种来源都要认出来', () => {
    expect(inferProviderBrand({ id: 'minimax/minimax-m3', providerId: 'openrouter' })).toBe('minimax');
    expect(inferProviderBrand({ id: 'MiniMax-M3', providerId: 'relay-b' })).toBe('minimax');
  });

  it('原有品牌不能被新规则吃掉', () => {
    expect(inferProviderBrand({ id: 'grok-4.3' })).toBe('xai');
    expect(inferProviderBrand({ id: 'glm-5.2' })).toBe('glm');
    expect(inferProviderBrand({ id: 'deepseek-v4-pro' })).toBe('deepseek');
    expect(inferProviderBrand({ id: 'mistral-large' })).toBe('mistral');
    /* mistral 和 minimax 都是 mi- 开头, 不能互吃 */
    expect(inferProviderBrand({ id: 'mixtral-8x7b' })).toBe('mistral');
  });

  it('认不出品牌时仍是 generic (兜底图标在渲染层给, 不在这里)', () => {
    expect(inferProviderBrand({ id: 'some-unknown-model-x' })).toBe('generic');
  });
});
