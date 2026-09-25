/**
 * resolveEffortPayload 单测 — D13 yaml effort_map 真生效的保证.
 *
 * 防止"yaml 写了改了, 但代码没读"再次发生 (修复前的状态: openai.ts 读 yaml, anthropic/
 * kimi/glm/doubao 全没读)。
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { resolveEffortPayload } from '../effortPayload.js';
import { loadSchemas, resetSchemaRegistryForTesting } from '../loader.js';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

beforeAll(() => {
  /* 防止其它 test 已经把 schema cache 起来 */
  resetSchemaRegistryForTesting();
  loadSchemas({ dir: path.join(REPO_ROOT, 'schemas') });
});

describe('resolveEffortPayload', () => {
  test('claude-opus-4-8 high → adaptive thinking + output_config.effort', () => {
    /* Opus 4.8 不再支持手动 budget_tokens; 正确字段是 adaptive thinking
       + output_config.effort。 */
    const r = resolveEffortPayload('claude-opus-4-8', 'high');
    expect(r.payload).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    /* 开源树的 yaml 不带计费倍率 */
    expect(r.billingMultiplier).toBeNull();
    expect(r.upstreamSlugOverride).toBeNull();
  });

  test('claude-opus-4-8 max → output_config.effort max', () => {
    const r = resolveEffortPayload('claude-opus-4-8', 'max');
    expect(r.payload).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
    expect(r.billingMultiplier).toBeNull();
  });

  test('gpt-5.5 minimal → reasoning_effort + verbosity 联动', () => {
    const r = resolveEffortPayload('gpt-5.5', 'minimal');
    expect(r.payload).toEqual({ reasoning_effort: 'minimal', verbosity: 'low' });
    expect(r.billingMultiplier).toBeNull();
  });

  test('gpt-5.5 high → reasoning_effort + verbosity high', () => {
    const r = resolveEffortPayload('gpt-5.5', 'high');
    expect(r.payload).toEqual({ reasoning_effort: 'high', verbosity: 'high' });
    expect(r.billingMultiplier).toBeNull();
  });

  test('gemini-3.1-pro deep → thinking_config 透传 (嵌套 object 不被压平)', () => {
    const r = resolveEffortPayload('gemini-3.1-pro', 'deep');
    expect(r.payload).toEqual({ thinking_config: { thinking_budget: 8192 } });
    expect(r.billingMultiplier).toBeNull();
  });

  test('upstream_slug_override 按 providerId 提取, 不污染 payload', () => {
    /* claude-opus-4-7.yaml 没有 override; 这里只检 contract + adaptive payload。 */
    const r = resolveEffortPayload('claude-opus-4-7', 'high');
    expect(r.payload).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    /* 没 override → null */
    expect(r.upstreamSlugOverride).toBeNull();
  });

  test('不存在的 model → 空 payload, fail-open', () => {
    const r = resolveEffortPayload('no-such-model', 'high');
    expect(r.payload).toEqual({});
    expect(r.billingMultiplier).toBeNull();
  });

  test('不存在的 level → 空 payload', () => {
    const r = resolveEffortPayload('claude-opus-4-8', 'no-such-level');
    expect(r.payload).toEqual({});
  });

  test('effortLevel falsy → 直接返回空', () => {
    const r = resolveEffortPayload('claude-opus-4-8', undefined);
    expect(r.payload).toEqual({});
    expect(r.billingMultiplier).toBeNull();
  });

  test('META 字段 (billing_multiplier / upstream_slug_override) 不进 payload', () => {
    const r = resolveEffortPayload('gpt-5.5', 'low');
    expect(r.payload).not.toHaveProperty('billing_multiplier');
    expect(r.payload).not.toHaveProperty('upstream_slug_override');
  });
});
