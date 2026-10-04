/** 验证尾部保护按 token 预算选择消息数量，而不是按固定条数选择。 */
import { describe, it, expect } from 'vitest';
import { countTailMessagesWithinTokens } from '../llmSummarizer.js';
import type { Message } from '../../../types/index.js';

const msg = (chars: number): Message => ({ role: 'user', content: 'x'.repeat(chars) } as any);

describe('尾部保护按 token 预算', () => {
  it('小消息 → 多保几条；大消息 → 少保几条，占用恒定', () => {
    /* 4 chars ≈ 1 token (ASCII) */
    const small = Array.from({ length: 40 }, () => msg(4_000));    // 各 ~1K token
    const huge = Array.from({ length: 40 }, () => msg(200_000));   // 各 ~50K token

    const keptSmall = countTailMessagesWithinTokens(small, 8_000);
    const keptHuge = countTailMessagesWithinTokens(huge, 8_000);

    expect(keptSmall).toBeGreaterThan(keptHuge);
    expect(keptSmall).toBeLessThanOrEqual(9);   // 8K 预算装不下 9 条 1K
    expect(keptHuge).toBe(1);                   // 一条就超预算 → 只保 1 条
  });

  it('预算 0 → 一条不保（收敛循环最后一轮）', () => {
    expect(countTailMessagesWithinTokens(Array.from({ length: 10 }, () => msg(4_000)), 0)).toBe(0);
  });

  it('第一条就超预算仍保 1 条 — 尾部全空会让模型失去"我刚才在干嘛"的锚点', () => {
    expect(countTailMessagesWithinTokens([msg(400_000)], 8_000)).toBe(1);
  });

  it('预算大于全部内容 → 全保，不会越界', () => {
    const msgs = Array.from({ length: 5 }, () => msg(400));
    expect(countTailMessagesWithinTokens(msgs, 1_000_000)).toBe(5);
  });

  it('空历史不炸', () => {
    expect(countTailMessagesWithinTokens([], 8_000)).toBe(0);
  });
});
