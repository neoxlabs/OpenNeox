import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../../types/index.js';

const state = vi.hoisted(() => ({
  result: null as any,
  error: null as Error | null,
  calls: [] as Array<{ messages: Message[]; budget: number }>,
}));

vi.mock('../llmSummarizer.js', () => {
  const COMPACTION_SUMMARY_MARKER = '<<COMPACTION_SUMMARY>>';
  class LLMSummarizer {
    constructor(_options?: unknown) {}
    async summarize(messages: Message[], budget: number) {
      state.calls.push({ messages, budget });
      if (state.error) throw state.error;
      return state.result;
    }
  }
  return { LLMSummarizer, COMPACTION_SUMMARY_MARKER };
});

import { UnifiedCompressor, createUnifiedCompressor, getUnifiedCompressor } from '../index.js';

const provider = { chat: vi.fn(async () => ({ choices: [{ message: { content: 'x' } }] })) } as any;

function result(overrides: Partial<any> = {}) {
  return {
    messages: [{ role: 'user', content: '<<COMPACTION_SUMMARY>> summary' } as Message],
    originalTokens: 1000,
    compressedTokens: 200,
    savedTokens: 800,
    summarizedCount: 4,
    preservedCount: 2,
    bucketDetails: [{ status: 'done' }, { status: 'failed' }],
    summaryModel: 'mock-model',
    ...overrides,
  };
}

beforeEach(() => {
  state.result = result();
  state.error = null;
  state.calls = [];
  vi.clearAllMocks();
});

describe('UnifiedCompressor.compressHistory — 不压缩的边界', () => {
  it('预算内且非 force 时原样返回', async () => {
    const c = new UnifiedCompressor();
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const r = await c.compressHistory(messages, 1_000_000);
    expect(r.messages).toBe(messages);
    expect(r.savedTokens).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  it('没有 provider / model 时即使超预算也不压缩', async () => {
    const c = new UnifiedCompressor();
    const messages: Message[] = [{ role: 'user', content: 'x'.repeat(1000) }];
    const r = await c.compressHistory(messages, 1);
    expect(r.messages).toBe(messages);
    expect(state.calls).toHaveLength(0);
  });

  it('force 时即使预算内也跑摘要', async () => {
    const c = new UnifiedCompressor();
    c.setLLMProvider(provider, 'mock-model');
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const r = await c.compressHistory(messages, 1_000_000, { force: true });
    expect(state.calls).toHaveLength(1);
    expect(r.compressedTokens).toBe(200);
  });
});

describe('UnifiedCompressor.compressHistory — 摘要结果与统计', () => {
  it('摘要变小时采用结果并提取摘要内容', async () => {
    const c = new UnifiedCompressor();
    c.setLLMProvider(provider, 'mock-model');
    const r = await c.compressHistory([{ role: 'user', content: 'x'.repeat(1000) }], 100);
    expect(r.compressedTokens).toBe(200);
    expect(r.savedTokens).toBe(800);
    expect(r.summary).toContain('summary');
    expect(r.stats).toEqual({
      droppedMessages: 4,
      llmCompressedMessages: 1,
      truncatedMessages: 0,
      preservedMessages: 2,
    });
  });

  it('摘要后反而变大时丢弃结果、保留原文', async () => {
    state.result = result({ compressedTokens: 1200, savedTokens: -200 });
    const c = new UnifiedCompressor();
    c.setLLMProvider(provider, 'mock-model');
    const messages: Message[] = [{ role: 'user', content: 'x'.repeat(1000) }];
    const r = await c.compressHistory(messages, 100);
    expect(r.messages).toBe(messages);
    expect(r.compressedTokens).toBe(1000);
    expect(r.savedTokens).toBe(0);
    expect(r.stats.llmCompressedMessages).toBe(1);
  });

  it('摘要器抛错时向上抛出（由调用方决定降级）', async () => {
    state.error = new Error('summarizer down');
    const c = new UnifiedCompressor();
    c.setLLMProvider(provider, 'mock-model');
    await expect(c.compressHistory([{ role: 'user', content: 'x'.repeat(1000) }], 1)).rejects.toThrow('summarizer down');
  });
});

describe('UnifiedCompressor — 配置与工具压缩', () => {
  it('getStats 返回配置与 provider 状态', () => {
    const c = new UnifiedCompressor({ debug: false, defaultTokenBudget: 1234 });
    expect(c.getStats().hasLLMProvider).toBe(false);
    expect(c.getStats().config.defaultTokenBudget).toBe(1234);
    c.setLLMProvider(provider, 'm');
    expect(c.getStats().hasLLMProvider).toBe(true);
  });

  it('setContextWindow 不抛错，debug 下也不抛', () => {
    const c = new UnifiedCompressor({ debug: true });
    expect(() => c.setContextWindow(32000)).not.toThrow();
  });

  it('compressToolResult 走工具压缩器', async () => {
    const c = new UnifiedCompressor();
    const input = 'file: a.ts\n' + Array.from({ length: 100 }, (_, i) => `line-${i} ${'x'.repeat(50)}`).join('\n');
    const out = await c.compressToolResult('Read', input);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain('📄 a.ts');
  });

  it('registerToolCompressor / setMessageCompressor 作为扩展点不抛错', () => {
    const c = new UnifiedCompressor();
    const fakeTool = { supportedTools: [], getToolType: () => 'other', needsLLMCompression: () => false, compress: vi.fn() } as any;
    const fakeMessage = { compressMessage: vi.fn(), compressMessages: vi.fn() } as any;
    expect(() => c.registerToolCompressor(fakeTool)).not.toThrow();
    expect(() => c.setMessageCompressor(fakeMessage)).not.toThrow();
  });

  it('默认单例与显式创建互不影响', () => {
    const a = getUnifiedCompressor();
    const b = getUnifiedCompressor();
    const c = createUnifiedCompressor();
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
