/**
 * schema vision 权威判定 — loadSchemas 注入后, modelVisionHeuristic/resolveModelVision
 * 不再被 TEXT_ONLY 正则误杀新视觉模型 (glm-5.2/doubao-pro/qwen-3-max)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSchemaRegistry, resetSchemaRegistryForTesting } from '../loader.js';
import { modelVisionHeuristic, resolveModelVision } from '../../platform/modelCapabilities.js';

describe('schema vision authority', () => {
  beforeEach(() => {
    resetSchemaRegistryForTesting();
    getSchemaRegistry();
  });
  afterEach(() => resetSchemaRegistryForTesting());

  it('model yaml vision=true overrides the TEXT_ONLY regex', () => {
    expect(modelVisionHeuristic('glm-5.2')).toBe(true);
    expect(modelVisionHeuristic('doubao-pro')).toBe(true);
    expect(modelVisionHeuristic('qwen-3-max')).toBe(true);
  });

  it('model yaml vision=false still blocks text-only models', () => {
    expect(modelVisionHeuristic('deepseek-v4-pro')).toBe(false);
    expect(modelVisionHeuristic('kimi-k2-6')).toBe(false);
  });

  it('variant names resolve through substring match', () => {
    expect(modelVisionHeuristic('glm-5.2-flash-0701')).toBe(true);
  });

  it('deepseek 的多模态型号不再被 TEXT_ONLY 正则里的 "deepseek" 误杀', () => {
    /* The explicit vision declaration keeps this multimodal DeepSeek variant
     * distinct from the text-only model sharing its prefix. */
    expect(modelVisionHeuristic('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(modelVisionHeuristic('deepseek/deepseek-v4-flash-vision-exp')).toBe(true);
    /* 同名前缀的纯文本档必须仍然是 false —— 两者只差一个后缀 */
    expect(modelVisionHeuristic('deepseek-v4-flash')).toBe(false);
  });

  it('子串兜底取最长匹配 —— 不许"先撞上谁算谁"', () => {
    /* deepseek-v4-flash-vision-exp-0821 同时包含 `deepseek-v4-flash` (false) 和
     * `deepseek-v4-flash-vision-exp` (true)。短的先命中就会把多模态判成纯文本。
     * 今天即使按插入序遍历也碰巧是对的 (文件名 '-' < '.', 长的排前面) ——
     * 这条断言钉的是**结果**, 好在换个命名时立刻红, 而不是等用户发现图片发不出去。 */
    expect(modelVisionHeuristic('deepseek-v4-flash-vision-exp-0821')).toBe(true);
  });

  it('family yaml default covers models without per-model yaml', () => {
    // deepseek family vision=false; 未列入 schemas/models 的变体走 family 默认
    expect(modelVisionHeuristic('deepseek-v9-hypothetical')).toBe(false);
    // claude family vision=true
    expect(modelVisionHeuristic('claude-omega-9')).toBe(true);
  });

  it('explicit server flag still wins over schema authority', () => {
    expect(resolveModelVision('glm-5.2', false)).toBe(false);
    expect(resolveModelVision('deepseek-v4-pro', true)).toBe(true);
  });

  it('falls back to regex heuristics after reset (renderer-like environment)', () => {
    resetSchemaRegistryForTesting();
    expect(modelVisionHeuristic('glm-5.2')).toBe(false); // 无权威 → 老正则行为
    expect(modelVisionHeuristic('gpt-5.5')).toBe(true);
  });
});
