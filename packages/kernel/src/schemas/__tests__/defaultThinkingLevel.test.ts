import { describe, it, expect } from 'vitest';
import { resolveDefaultThinkingLevel } from '../effortPayload.js';

/**
 *  thinking 默认档 — "旗舰默认不思考"根治的核心解析:
 * 用户不动 effort 时, adapter 据此决定默认思考档 (null = 不注入, 交上游默认)。
 */
describe('resolveDefaultThinkingLevel', () => {
  /* 默认档跟 yaml / 官方 API 对齐: opus high; DeepSeek V4 官方默认 high; glm max。 */
  it('claude opus 4.8/4.7 default to declared high (adaptive thinking)', () => {
    expect(resolveDefaultThinkingLevel('claude-opus-4-8')).toBe('high');
    expect(resolveDefaultThinkingLevel('claude-opus-4-7')).toBe('high');
  });

  it('thinking families default per yaml declaration', () => {
    expect(resolveDefaultThinkingLevel('deepseek-v4-pro')).toBe('high');
    expect(resolveDefaultThinkingLevel('deepseek-v4-flash')).toBe('high');
    expect(resolveDefaultThinkingLevel('glm-5.2')).toBe('max');
    expect(resolveDefaultThinkingLevel('kimi-k2-6')).toBe('on');
    expect(resolveDefaultThinkingLevel('doubao-pro')).toBe('auto');
  });

  it('never picks off/fast as default', () => {
    for (const id of ['claude-opus-4-8', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k2-6', 'gemini-3.1-pro']) {
      const lvl = resolveDefaultThinkingLevel(id);
      expect(lvl).not.toBe('off');
      expect(lvl).not.toBe('fast');
    }
  });

  it('models without thinking support return null', () => {
    expect(resolveDefaultThinkingLevel('grok-4')).toBeNull();
    expect(resolveDefaultThinkingLevel('claude-haiku-4-5')).toBeNull();
    expect(resolveDefaultThinkingLevel('totally-unknown-model')).toBeNull();
  });

  it('qwen hybrid mode has no default (交上游自适应) but off/on levels exist', () => {
    /* qwen-3-max 没声明 default_level; 启发 candidates 里 'on' 有 payload → 'on'。
     * 这是刻意的: enable_thinking:true 显式开也符合混合模式语义。 */
    expect(resolveDefaultThinkingLevel('qwen-3-max')).toBe('on');
  });
});
