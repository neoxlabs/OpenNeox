/**
 * ModelCapability 能力表 (code:MODEL-02).
 *
 * 守三件事:
 *   1. 表覆盖**全部在售模型** (availability: ga) —— 不是只给几个主力模型写死;
 *   2. 能从 yaml 推导的字段 (窗口 / thinking 支持) 必须跟 yaml 一致, 不许在代码里另抄一份;
 *   3. yaml 表达不了、必须落在代码表里的两项 (强制 tool_choice / 并行并发) 跟 family yaml 不矛盾。
 */

import { beforeAll, describe, expect, test } from 'vitest';
import {
  LARGE_CONTEXT_WINDOW_TOKENS,
  MODEL_CAPABILITY_TABLE,
  getModelCapabilityTable,
  listModelCapabilities,
  resolveModelCapability,
  truncationProfileFor,
} from '../modelCapability.js';
import { getSchemaRegistry, resetSchemaRegistryForTesting } from '../loader.js';

beforeAll(() => {
  resetSchemaRegistryForTesting();
  getSchemaRegistry();
});

describe('覆盖在售模型', () => {
  test('每个 availability: ga 的模型都有一条能力记录', () => {
    const registry = getSchemaRegistry();
    const ga = [...registry.models.values()].filter((m) => m.availability === 'ga');
    expect(ga.length).toBeGreaterThan(30);

    const table = getModelCapabilityTable();
    for (const model of ga) {
      expect(table[model.id], `缺 ${model.id} 的能力记录`).toBeDefined();
      expect(resolveModelCapability(model.id)).not.toBeNull();
    }
    expect(Object.keys(table).sort()).toEqual(ga.map((m) => m.id).sort());
  });

  test('默认不列 preview 模型; includeNonGa 才带上', () => {
    const registry = getSchemaRegistry();
    const preview = [...registry.models.values()].filter((m) => m.availability !== 'ga');
    expect(preview.length).toBeGreaterThan(0);

    const gaIds = new Set(listModelCapabilities().map((c) => c.modelId));
    for (const model of preview) {
      expect(gaIds.has(model.id), `${model.id} 不该出现在在售表里`).toBe(false);
    }
    expect(listModelCapabilities({ includeNonGa: true }).length)
      .toBe(listModelCapabilities().length + preview.length);
  });

  test('结果按 modelId 排序, 稳定可 diff', () => {
    const ids = listModelCapabilities().map((c) => c.modelId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe('字段跟 yaml 一致', () => {
  test('contextWindow 直接取模型 yaml 的 context_window', () => {
    const registry = getSchemaRegistry();
    for (const cap of listModelCapabilities()) {
      const model = registry.models.get(cap.modelId)!;
      expect(cap.contextWindow, cap.modelId).toBe(model.context_window);
    }
  });

  test('supportsThinking: 模型 yaml 有声明以它为准, 没声明按 family 兜底', () => {
    expect(resolveModelCapability('deepseek-v4.1-flash')!.supportsThinking).toBe(true);
    expect(resolveModelCapability('gpt-5.6-sol')!.supportsThinking).toBe(true);
    expect(resolveModelCapability('claude-opus-4-8')!.supportsThinking).toBe(true);
    /* claude-haiku-4-5 的模型 yaml 没声明 thinking / reasoning_effort → 走 claude family 的 thinking.native:true */
    expect(resolveModelCapability('claude-haiku-4-5')!.supportsThinking).toBe(true);
    /* xai family 的 thinking.native / reasoning_effort 都是 false */
    expect(resolveModelCapability('grok-4')!.supportsThinking).toBe(false);
    /* mimo family 的 thinking.native:false, 但 mimo-v2.5 的模型 yaml 显式声明了 thinking.supported:true */
    expect(resolveModelCapability('xiaomi/mimo-v2.5')!.supportsThinking).toBe(true);
  });

  test('truncationProfile 分界 = runner 的 200K', () => {
    expect(LARGE_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(truncationProfileFor(199_999)).toBe('small-window');
    expect(truncationProfileFor(200_000)).toBe('large-window');
    expect(resolveModelCapability('qwen-3-max')!.truncationProfile).toBe('small-window'); // 128K
    expect(resolveModelCapability('gpt-5.6-sol')!.truncationProfile).toBe('large-window'); // 272K
    expect(resolveModelCapability('claude-opus-4-8')!.truncationProfile).toBe('large-window'); // 1M
  });
});

describe('代码表: yaml 表达不了的两项', () => {
  test('强制 tool_choice: GLM / Kimi 不支持, 其余在售 family 支持', () => {
    expect(resolveModelCapability('glm-5.3-flash')!.supportsToolChoice).toBe(false);
    expect(resolveModelCapability('kimi-k3')!.supportsToolChoice).toBe(false);
    expect(resolveModelCapability('gpt-5.6-sol')!.supportsToolChoice).toBe(true);
    expect(resolveModelCapability('claude-opus-4-8')!.supportsToolChoice).toBe(true);
    expect(resolveModelCapability('deepseek-v4.1-flash')!.supportsToolChoice).toBe(true);
  });

  test('并行并发: 跟 family yaml 的 parallel_tool_use 不矛盾', () => {
    const registry = getSchemaRegistry();
    for (const cap of listModelCapabilities()) {
      const model = registry.models.get(cap.modelId)!;
      const family = registry.resolveFamily(model.family);
      if (!family) continue;
      expect(cap.maxParallelToolCalls, cap.modelId).toBeGreaterThanOrEqual(1);
      if (family.capabilities.parallel_tool_use === false) {
        expect(cap.maxParallelToolCalls, `${cap.modelId}: yaml 说不支持并行`).toBe(1);
      }
    }
  });

  test('在售模型涉及的每个 family 都在代码表里 (不允许悄悄落到保守默认)', () => {
    const registry = getSchemaRegistry();
    const families = new Set(
      listModelCapabilities().map((c) => registry.models.get(c.modelId)!.family),
    );
    for (const family of families) {
      expect(MODEL_CAPABILITY_TABLE[family], `family ${family} 没进 MODEL_CAPABILITY_TABLE`).toBeDefined();
    }
  });

  test('未知 family / 未知模型都按保守值处理', () => {
    expect(MODEL_CAPABILITY_TABLE['no-such-family']).toBeUndefined();
    expect(resolveModelCapability('definitely-not-a-model-xyz')).toBeNull();
  });

  test('名字走 registry 归一化: upstream slug 也能查到', () => {
    const byId = resolveModelCapability('gpt-5.6-sol')!;
    expect(resolveModelCapability('openai/gpt-5.6-sol')).toEqual(byId);
  });
});
