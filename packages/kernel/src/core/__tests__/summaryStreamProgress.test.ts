import { describe, it, expect } from 'vitest';
import { estimateSummaryPercent, requestCachedPrefixSummary } from '../cachedSummaryCompaction.js';

describe('estimateSummaryPercent', () => {
  it('还没出字: 随时间缓慢前进, 停在前段', () => {
    expect(estimateSummaryPercent(0, 0, 0)).toBe(0);
    const a = estimateSummaryPercent(0, 0, 5_000);
    const b = estimateSummaryPercent(0, 0, 60_000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(15);
  });

  it('摘要写到预期长度附近接近尾段, 再长也不到 100', () => {
    const half = estimateSummaryPercent(1_250, 0, 10_000);
    const full = estimateSummaryPercent(2_500, 0, 20_000);
    const long = estimateSummaryPercent(10_000, 0, 60_000);
    expect(half).toBeGreaterThan(30);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeGreaterThan(70);
    expect(long).toBeLessThanOrEqual(95);
  });
});

describe('requestCachedPrefixSummary 流式报进度', () => {
  it('每段摘要文字都推进度, 单调不减, 输出 token 递增', async () => {
    const piece = '已完成 A、B; 下一步做 C, 涉及 src/a.ts。'.repeat(20);
    const provider = {
      async *chatStreamed() {
        for (let i = 0; i < 10; i++) yield { choices: [{ delta: { content: piece } }] };
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } };
      },
    } as any;
    const seen: Array<{ percent: number; outputTokens: number }> = [];
    const summary = await requestCachedPrefixSummary(provider, [{ role: 'user', content: 'hi' }], { model: 'm', tools: [] }, (p) => seen.push(p));
    expect(summary.length).toBe(piece.length * 10);
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.percent).toBeGreaterThan(seen[i - 1]!.percent);
      expect(seen[i]!.outputTokens).toBeGreaterThanOrEqual(seen[i - 1]!.outputTokens);
    }
    expect(seen[seen.length - 1]!.percent).toBeLessThan(100);
  });

  it('重试从头再流一遍: 进度不往回跳', async () => {
    const piece = 'x'.repeat(2000);
    const provider = {
      async *chatStreamed() {
        yield { choices: [{ delta: { content: piece } }] };
        yield { choices: [{ delta: { content: piece } }] };
        yield { type: 'stream_retry' };
        yield { choices: [{ delta: { content: piece } }] };
      },
    } as any;
    const seen: number[] = [];
    await requestCachedPrefixSummary(provider, [{ role: 'user', content: 'hi' }], { model: 'm', tools: [] }, (p) => seen.push(p.percent));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });
});
