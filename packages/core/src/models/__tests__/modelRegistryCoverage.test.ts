import { describe, it, expect } from 'vitest';
import { modelRegistry, type ModelMetadata } from '@neoxlabs/platform/models/registry/index.js';
import { getNormalizedModelOptionsByProtocol } from '../protocolModels.js';

const all = modelRegistry.getAllModels();
const live = all.filter((m) => !m.deprecated);

/** 每家至少要有的"当前主力" —— 缺了就是这份库又落后了一代 */
const MUST_HAVE: Array<[string, string]> = [
  ['anthropic', 'claude-opus-5'],
  ['anthropic', 'claude-sonnet-5'],
  ['anthropic', 'claude-fable-5'],
  ['openai', 'gpt-5.6-sol'],
  ['gemini', 'gemini-3.7-flash'],
  ['kimi', 'kimi-k3'],
  ['glm', 'glm-5.3'],
  ['qwen', 'qwen3.8-max'],
  ['xai', 'grok-4.6'],
  ['deepseek', 'deepseek-v4-pro'],
  ['minimax', 'MiniMax-M3'],
  ['doubao', 'doubao-seed-2-1-pro-260628'],
  ['mistral', 'mistral-medium-latest'],
  ['groq', 'openai/gpt-oss-120b'],
  ['together', 'moonshotai/Kimi-K3'],
];

describe('模型库覆盖', () => {
  it('每个当前主力都在库里, 且没被标弃用', () => {
    for (const [provider, id] of MUST_HAVE) {
      const m = modelRegistry.getModel(id);
      expect(m, `缺模型 ${id}`).toBeTruthy();
      expect(m!.provider, `${id} 的 provider 不对`).toBe(provider);
      expect(m!.deprecated, `${id} 不该是弃用状态`).toBeFalsy();
    }
  });

  it('每个 provider 都至少有一个可用模型 —— 没有的话它的下拉是空的', () => {
    const providers = new Set(all.map((m) => m.provider));
    for (const p of providers) {
      const n = live.filter((m) => m.provider === p).length;
      expect(n, `${p} 一个可用模型都没有`).toBeGreaterThan(0);
    }
  });

  it('token 上限必须是正数 —— 0 或缺失会让上下文表盘直接算崩', () => {
    for (const m of all) {
      expect(m.maxInputTokens, `${m.id} 的 maxInputTokens`).toBeGreaterThan(0);
      expect(m.maxOutputTokens, `${m.id} 的 maxOutputTokens`).toBeGreaterThan(0);
    }
  });

  it('id 唯一, 别名不许跟别家的 id 撞', () => {
    const ids = new Set<string>();
    for (const m of all) {
      expect(ids.has(m.id), `重复 id ${m.id}`).toBe(false);
      ids.add(m.id);
    }
    for (const m of all) {
      for (const alias of m.aliases ?? []) {
        const hit: ModelMetadata | undefined = modelRegistry.getModel(alias);
        expect(hit?.id, `别名 ${alias} 指向了别人 (${hit?.id})`).toBe(m.id);
      }
    }
  });
});

describe('协议 → 模型清单不许张冠李戴', () => {
  /** 每个协议的下拉首项应该属于这个协议自己的厂商 */
  const CASES: Array<[string, string]> = [
    ['mistral', 'mistral'],
    ['groq', 'groq'],
    ['together', 'together'],
    ['anthropic', 'anthropic'],
    ['gemini', 'gemini'],
    ['deepseek', 'deepseek'],
    ['kimi', 'kimi'],
    ['glm', 'glm'],
    ['qwen', 'qwen'],
    ['doubao', 'doubao'],
    ['minimax', 'minimax'],
    ['grok', 'xai'],
  ];

  for (const [protocol, provider] of CASES) {
    it(`${protocol} 的下拉里全是 ${provider} 自己的模型`, () => {
      const opts = getNormalizedModelOptionsByProtocol(protocol as never);
      expect(opts.length, `${protocol} 下拉是空的`).toBeGreaterThan(0);
      for (const o of opts) {
        const m = modelRegistry.getModel(o.id);
        expect(m?.provider, `${protocol} 的下拉里混进了 ${o.id} (${m?.provider})`).toBe(provider);
      }
    });
  }

  it('弃用的模型不进下拉', () => {
    const opts = getNormalizedModelOptionsByProtocol('groq' as never);
    /* Groq 官方把 Llama 系列标了弃用, 库里也照标了 —— 它们不该出现在给用户选的列表里 */
    expect(opts.map((o) => o.id)).not.toContain('llama-3.3-70b-versatile');
  });
});
