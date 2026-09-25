/**
 * tokenEstimate 契约固化 — CJK 分字符类加权不回归.
 *
 *  发布审计 P1: char/4 对 CJK 低估 → 中文长会话晚压缩撞 prompt_too_long.
 * 断言三类文本的估算行为: 纯英文维持 char/4; 纯中文显著高于 char/4 (0.6 token/字);
 * 混合文本 = 两段分类累加.
 */

import { describe, expect, test } from 'vitest';
import { estimateTokens, estimateTokensRaw } from '../tokenEstimate.js';

describe('estimateTokens — 分字符类估算', () => {
  test('空值 → 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  test('纯英文 (ASCII) 维持 char/4', () => {
    const en = 'a'.repeat(100);
    expect(estimateTokens(en)).toBe(25);
    expect(estimateTokens(en)).toBe(estimateTokensRaw(en));
  });

  test('纯中文按 0.6 token/字, 显著高于 char/4', () => {
    const zh = '中'.repeat(100);
    expect(estimateTokens(zh)).toBe(60);
    // 显著高于旧 char/4 (=25): 至少 2 倍
    expect(estimateTokens(zh)).toBeGreaterThanOrEqual(estimateTokensRaw(zh) * 2);
  });

  test('中文全角标点也按 CJK 计', () => {
    const punct = '，。！？'.repeat(25); // 100 个全角标点
    expect(estimateTokens(punct)).toBe(60);
  });

  test('日文假名 / 韩文谚文按 CJK 计', () => {
    expect(estimateTokens('あ'.repeat(10))).toBe(6);
    expect(estimateTokens('한'.repeat(10))).toBe(6);
  });

  test('混合文本分段累加', () => {
    const mixed = '中'.repeat(50) + 'a'.repeat(50);
    // ceil(50 * 0.6 + 50 / 4) = ceil(30 + 12.5) = 43
    expect(estimateTokens(mixed)).toBe(43);
    // 高于全按 char/4 (=25), 低于全按 CJK (=60)
    expect(estimateTokens(mixed)).toBeGreaterThan(estimateTokensRaw(mixed));
    expect(estimateTokens(mixed)).toBeLessThan(60);
  });

  test('estimateTokensRaw 保持旧 char/4 行为 (中文也不加权)', () => {
    expect(estimateTokensRaw('中'.repeat(100))).toBe(25);
    expect(estimateTokensRaw('a'.repeat(100))).toBe(25);
    expect(estimateTokensRaw('')).toBe(0);
  });
});
