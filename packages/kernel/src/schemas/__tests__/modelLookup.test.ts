import { describe, it, expect } from 'vitest';
import { getSchemaRegistry } from '../index.js';
import {
  canonicalizeSeparators,
  isVersionSafeMatch,
  lookupCandidates,
  normalizeModelName,
  stripVariantSuffix,
} from '../modelLookup.js';

const registry = getSchemaRegistry();
const id = (name: string) => registry.resolveModel(name)?.id ?? null;

describe('同一个模型的各种写法都要认出来', () => {
  it('provider 前缀 / OpenRouter 路径 / 上游 slug', () => {
    expect(id('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(id('neox-cloud:gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(id('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(id('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('分隔符写法: gpt5.6-sol / gpt-5-6-sol / 点与横线互换', () => {
    expect(id('gpt5.6-sol')).toBe('gpt-5.6-sol');
    expect(id('gpt-5-6-sol')).toBe('gpt-5.6-sol');
    expect(id('claude-opus-4.8')).toBe('claude-opus-4-8');
    expect(id('deepseek-v4-1-flash')).toBe('deepseek-v4.1-flash');
  });

  it('日期 / 渠道 / 档位后缀', () => {
    expect(id('gpt-5.6-sol-2026-07-09')).toBe('gpt-5.6-sol');
    expect(id('gpt-5.6-sol-preview')).toBe('gpt-5.6-sol');
    /* 中转把档位写进模型名 —— 仍是同一个模型 */
    expect(id('gpt-5.6-sol-high')).toBe('gpt-5.6-sol');
    /* 冒号在这里是**尾标**不是 provider 前缀 (第一版把它剥成了 'beta') */
    expect(id('gpt-5.6-sol:beta')).toBe('gpt-5.6-sol');
  });

  it('多层前缀 + 路径 + 后缀叠在一起', () => {
    expect(id('m5x:openai/gpt-5.6-sol-2026-07-09')).toBe('gpt-5.6-sol');
  });
});

describe('长得像但是另一个模型 —— 绝不能认', () => {
  it('版本续写不算同一个模型', () => {
    /* claude-opus-4 ≠ claude-opus-4-8。认错的后果这仓库吃过:
     * 上下文窗口被少报成 200K */
    expect(id('claude-opus-4')).toBeNull();
  });

  it('变体名不算同一个模型', () => {
    expect(id('glm-5.2-air')).toBeNull();
  });

  it('完全不认识的名字就是不认识', () => {
    expect(id('some-random-llm')).toBeNull();
    expect(id('')).toBeNull();
  });
});

describe('纯函数', () => {
  it('normalizeModelName 剥前缀和路径', () => {
    expect(normalizeModelName('m5x:gpt-6')).toBe('gpt-6');
    expect(normalizeModelName('openai/gpt-6')).toBe('gpt-6');
    expect(normalizeModelName('M5X:OpenAI/GPT-6')).toBe('gpt-6');
  });

  it('canonicalizeSeparators 折叠写法, 但不动 o 系型号', () => {
    expect(canonicalizeSeparators('gpt5.6')).toBe('gpt-5.6');
    expect(canonicalizeSeparators('gpt_5_6')).toBe('gpt-5.6');
    /* o3-mini 的 o+数字就是型号本身, 不能补成 o-3 */
    expect(canonicalizeSeparators('o3-mini')).toBe('o3-mini');
  });

  it('stripVariantSuffix 只去日期/渠道/尾标', () => {
    expect(stripVariantSuffix('gpt-6-2026-07-09')).toBe('gpt-6');
    expect(stripVariantSuffix('gpt-6-preview')).toBe('gpt-6');
    expect(stripVariantSuffix('gpt-6:beta')).toBe('gpt-6');
    /* mini 是另一个模型, 不许当后缀去掉 */
    expect(stripVariantSuffix('gpt-6-mini')).toBe('gpt-6-mini');
  });

  it('isVersionSafeMatch: 允许可忽略后缀, 拒绝版本续写和变体', () => {
    expect(isVersionSafeMatch('gpt-5.6-sol', 'gpt-5.6-sol')).toBe(true);
    expect(isVersionSafeMatch('gpt-5.6-sol-preview', 'gpt-5.6-sol')).toBe(true);
    expect(isVersionSafeMatch('gpt-5.6-sol-2026-07-09', 'gpt-5.6-sol')).toBe(true);
    expect(isVersionSafeMatch('gpt-5.6-sol-high', 'gpt-5.6-sol')).toBe(true);
    expect(isVersionSafeMatch('claude-opus-4.7', 'claude-opus-4')).toBe(false);
    expect(isVersionSafeMatch('glm-5.2-air', 'glm-5.2')).toBe(false);
    expect(isVersionSafeMatch('gpt-56', 'gpt-5')).toBe(false);
  });

  it('lookupCandidates 覆盖冒号的两种含义', () => {
    /* 冒号既可能是前缀分隔也可能是尾标 —— 候选里都要有 */
    const c = lookupCandidates('gpt-5.6-sol:beta');
    expect(c).toContain('gpt-5.6-sol');
    const d = lookupCandidates('m5x:gpt-6');
    expect(d).toContain('gpt-6');
  });
});

describe('family 兜底的前提: 家族声明可读到', () => {
  it('没有 per-model yaml 的新模型仍能识别家族', () => {
    /* gpt-6 还没有 schemas/models/gpt-6.yaml, 但 family 必须认出来 ——
     * 推理档位的 family 兜底就建立在这上面 (见 modelStorageUsageHandlers) */
    expect(registry.resolveModel('gpt-6')).toBeUndefined();
    expect(registry.detectFamily({ model: 'gpt-6' })?.id).toBe('openai');
    expect(registry.detectFamily({ model: 'claude-opus-5' })?.id).toBe('claude');
    expect(registry.detectFamily({ model: 'gemini-4-pro' })?.id).toBe('gemini');
    expect(registry.detectFamily({ model: 'deepseek-v5' })?.id).toBe('deepseek');
  });

  it('OpenAI 家族声明了分档, 多数家族声明的是开关', () => {
    const openai = registry.resolveFamily('openai');
    expect(openai?.capabilities?.reasoning_effort?.supported).toBe(true);
    expect(openai?.capabilities?.reasoning_effort?.values).toContain('high');

    for (const fam of ['claude', 'gemini', 'glm', 'kimi', 'qwen']) {
      const f = registry.resolveFamily(fam);
      expect(
        (f?.capabilities?.thinking as { native?: boolean } | undefined)?.native,
        `${fam} 该声明 thinking.native`,
      ).toBe(true);
    }
  });
});

describe('family 兜底的 payload 必须真的发得出去 (不许假开关)', () => {
  it('没有 per-model yaml 时按 family 声明构造', async () => {
    const { resolveEffortPayload } = await import('../effortPayload.js');
    const p = (m: string, l: string) => resolveEffortPayload(m, l).payload;

    /* OpenAI 系: reasoning_effort 直给档位; off 落到最低档 (没有"不思考"这个值) */
    expect(p('gpt-6', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(p('m5x:gpt-6', 'medium')).toEqual({ reasoning_effort: 'medium' });
    expect(p('gpt-6', 'off')).toEqual({ reasoning_effort: 'minimal' });

    /* Anthropic 形状的开关 (claude / glm / kimi / deepseek / 豆包) */
    expect(p('claude-opus-5', 'on')).toEqual({ thinking: { type: 'enabled' } });
    expect(p('claude-opus-5', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(p('kimi-k3', 'on')).toEqual({ thinking: { type: 'enabled' } });

    /* Gemini 是预算数字: 0 = 不思考, -1 = 自动 */
    expect(p('gemini-4-pro', 'off')).toEqual({ thinking_config: { thinking_budget: 0 } });
    expect(p('gemini-4-pro', 'on')).toEqual({ thinking_config: { thinking_budget: -1 } });

    expect(p('qwen-4-max', 'on')).toEqual({ enable_thinking: true });
    expect(p('qwen-4-max', 'off')).toEqual({ enable_thinking: false });
  });

  it('没有思考能力的家族 / 认不出家族 → 什么都不发', async () => {
    const { resolveEffortPayload } = await import('../effortPayload.js');
    /* 发一个上游不认的字段比不发更糟 (400) */
    expect(resolveEffortPayload('grok-5', 'on').payload).toEqual({});
    expect(resolveEffortPayload('some-random-llm', 'on').payload).toEqual({});
  });

  it('有 per-model yaml 时仍走它自己的 effort_map (family 只是兜底)', async () => {
    const { resolveEffortPayload } = await import('../effortPayload.js');
    const p = resolveEffortPayload('gpt-5.6-sol', 'high').payload;
    /* yaml 里 high 档带 verbosity —— family 兜底给不出这个, 所以它证明走的是 model */
    expect(p.reasoning_effort).toBe('high');
    expect(Object.keys(p).length).toBeGreaterThan(1);
  });
});
