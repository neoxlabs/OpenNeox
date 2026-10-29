import { describe, it, expect, afterEach } from 'vitest';
import { compressContextWindow } from '../runnerCompressionUtils.js';
import { acquireCompactLock, releaseCompactLock, getLastCompactSkip } from '../autoCompactGuard.js';

const noopLog = () => {};
const args = () => ({
  maxInputTokens: 100_000,
  contextWindow: 200_000,
  iteration: 0,
  memory: { getMessagesForLLM: () => [], setMessages: () => {} } as any,
  unifiedCompressor: {} as any,
  compressionMode: 'sync' as const,
  trigger: 'manual' as const,
  logInfo: noopLog,
  logDebug: noopLog,
});

afterEach(() => releaseCompactLock());

describe('手动压缩撞上正在进行的压缩', () => {
  it('等它跑完再返回, 原因记成 busy (刚完成)', async () => {
    expect(acquireCompactLock()).toBe(true);
    const t0 = Date.now();
    setTimeout(() => releaseCompactLock(), 400);
    const r = await compressContextWindow(args());
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(getLastCompactSkip()?.reason).toBe('busy');
    expect(getLastCompactSkip()?.detail).toMatch(/finished/);
  });

  const longHistory = () => [
    { role: 'system', content: 's' },
    ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(4000) })),
  ];

  it('手动 /compact = 一次请求摘要整段 (对标 Claude Code / Codex): 换成「摘要 + 最新用户消息」', async () => {
    let saved: any[] = [];
    let calls = 0;
    const r = await compressContextWindow({
      ...args(),
      memory: { getMessagesForLLM: longHistory, setMessages: (m: any[]) => { saved = m; } } as any,
      summarizeOnCachedPrefix: async () => { calls++; return '## 进度\n已完成 A、B; 下一步做 C。\n' + '涉及文件 src/a.ts 与 src/b.ts 的改动细节。'.repeat(40); },
    });
    expect(calls).toBe(1);
    expect(r).not.toBeNull();
    expect(saved.length).toBeLessThanOrEqual(4);
    /* keeptask: 首条用户消息（任务正文）原样保留，不在摘要里转述。 */
    expect(saved.some((m) => String(m.content).startsWith('turn 0 '))).toBe(true);
    expect(String(saved.find((m) => /summarized/.test(String(m.content)))?.content)).toMatch(/下一步做 C/);
  });

  it('一次摘要出错 (超时 / 限流) → 手动压缩不报错, 退到分组摘要', async () => {
    let grouped = 0;
    const r = await compressContextWindow({
      ...args(),
      memory: { getMessagesForLLM: longHistory, setMessages: () => {} } as any,
      summarizeOnCachedPrefix: async () => { throw new Error('upstream timeout'); },
      unifiedCompressor: {
        compressHistory: async (m: any[]) => {
          grouped++;
          const kept = [m[0], m[m.length - 1]];
          return { messages: kept, originalCount: m.length, compressedCount: 2, originalTokens: 1e5, compressedTokens: 100, savedTokens: 1e5 - 100,
            stats: { droppedMessages: m.length - 2, llmCompressedMessages: 1, truncatedMessages: 0, preservedMessages: 2 } };
        },
      } as any,
    });
    expect(grouped).toBeGreaterThan(0);
    expect(r).not.toBeNull();
  });

  it('摘要一轮没缩小: 手动压缩收紧尾部保护再试, 三档都试完才放弃, 原因按"摘要模型失败"记', async () => {
    const msgs = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })),
    ];
    const tails: number[] = [];
    const unifiedCompressor = {
      compressHistory: async (m: any[], _budget: number, ctx: any) => {
        tails.push(ctx.summarizerOverrides.protectRecentTokens);
        /* 摘要模型一组都没摘成: 原样退回, llm 计数 0 */
        const t = m.length * 600;
        return { messages: m, originalCount: m.length, compressedCount: m.length, originalTokens: t, compressedTokens: 1e9, savedTokens: 0,
          stats: { droppedMessages: 0, llmCompressedMessages: 0, truncatedMessages: 0, preservedMessages: m.length } };
      },
    } as any;
    const r = await compressContextWindow({
      ...args(),
      memory: { getMessagesForLLM: () => msgs, setMessages: () => {} } as any,
      unifiedCompressor,
    });
    expect(tails.length).toBe(3);
    expect(tails[2]).toBe(0);
    /* 三轮摘要都失败后退到无 LLM 的分层折叠 —— 能折就照样压了 (不报"无需压缩");
     * 折不动才回空, 那时原因记成 summary_failed */
    if (r === null) expect(getLastCompactSkip()?.reason).toBe('summary_failed');
    else expect(r.compressedTokens).toBeLessThan(r.originalTokens);
  });
});
