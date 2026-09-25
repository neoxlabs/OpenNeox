import { describe, it, expect } from 'vitest';
import { getCompletionSuggestions } from './completions.js';

const ctx = {
  providerStore: {
    getProviders: () => [{ id: 'neox-cloud' }, { id: 'openai' }, { id: 'openrouter' }],
    getProvider: (id: string) =>
      id === 'neox-cloud'
        ? ({ id, models: [{ name: 'gpt-5.6' }, { name: 'deepseek-v4-flash' }] } as any)
        : null,
  },
  providerSettings: { models: [{ name: 'gpt-5.6' }, { name: 'deepseek-v4-flash' }] },
} as any;

const suggest = (input: string): string[] => getCompletionSuggestions(ctx, input);

describe('联想候选必须按已输入的片段过滤', () => {
  it('provider 名打全后, 首项就是用户输的那个 (不能换成别的 provider)', () => {
    const out = suggest('/provider use openai');
    expect(out[0]).toBe('/provider use openai');
    expect(out).not.toContain('/provider use neox-cloud');
  });

  it('打了公共前缀时只留匹配项', () => {
    const out = suggest('/provider use open');
    expect(out).toEqual(['/provider use openai', '/provider use openrouter']);
  });

  it('模型名打全后不再往后拼另一个模型名', () => {
    const out = suggest('/model use deepseek-v4-flash');
    expect(out[0]).toBe('/model use deepseek-v4-flash');
    expect(out.some((x) => x.split(/\s+/).length > 3)).toBe(false);
  });

  it('一条都匹配不上 → 不给联想 (让回车提交用户输入的原文)', () => {
    expect(suggest('/provider use zzz-not-exist')).toEqual([]);
  });

  it('尾随空格 = 新起一个参数, 列全量候选', () => {
    const out = suggest('/provider use ');
    expect(out.length).toBe(3);
  });

  it('没有子命令联想的命令返回空 (如 /session ls)', () => {
    expect(suggest('/session ls')).toEqual([]);
  });
});
