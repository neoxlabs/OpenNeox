/**
 * 验证摘要模型不可用时仅对模型不存在错误回退到当前模型；
 * 限流、超时和服务端错误保持原错误路径。
 */
import { describe, it, expect } from 'vitest';
import { LLMSummarizer } from '../llmSummarizer.js';

/** 造一份"够大所以一定会烧 LLM"的会话 */
function bigConversation(): any[] {
  const blob = 'some tool output line with detail\n'.repeat(1200);
  const msgs: any[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 12; i += 1) {
    msgs.push({ role: 'user', content: `step ${i}` });
    msgs.push({ role: 'assistant', content: `working on ${i}` });
    msgs.push({ role: 'tool', name: 'bash', content: `${blob}${i}` });
  }
  return msgs;
}

/** 记录每次 chat 用的 model; 对 rejectModel 抛指定错误, 其余正常返回摘要 */
function providerRejecting(rejectFor: (model: string) => boolean, error: Error) {
  const seen: string[] = [];
  return {
    seen,
    provider: {
      chat: async (_msgs: any, opts: any) => {
        seen.push(opts.model);
        if (rejectFor(opts.model)) throw error;
        return { choices: [{ message: { content: 'SUMMARY OK' } }] };
      },
      chatStreamed: () => { throw new Error('不该走流式'); },
    } as any,
  };
}

describe('摘要模型不可用时的兜底', () => {
  it('摘要模型 404 → 退回当前模型重试, 压缩成功', async () => {
    const s = new LLMSummarizer({ protectRecentCount: 2, protectHeadCount: 1 });
    /* gpt-5.4 会被映射成 gpt-5.4-mini; 让 mini 报 404, 当前模型可用 */
    const { seen, provider } = providerRejecting(
      m => m.includes('mini'),
      new Error('Anthropic API error: 404'),
    );
    const r = await s.summarize(bigConversation(), 4_000, provider, 'gpt-5.4');

    expect(seen.some(m => m.includes('mini'))).toBe(true);   // 先试了摘要模型
    expect(seen).toContain('gpt-5.4');                        // 又用当前模型重试
    expect(r.savedTokens).toBeGreaterThan(0);                 // 最终压缩成功
    expect(r.compressedTokens).toBeLessThan(r.originalTokens);
  });

  it('限流错误不兜底 — 换模型救不了, 不该多烧一次', async () => {
    const s = new LLMSummarizer({ protectRecentCount: 2, protectHeadCount: 1 });
    const { seen, provider } = providerRejecting(
      () => true,
      new Error('429 Too Many Requests'),
    );
    await s.summarize(bigConversation(), 4_000, provider, 'gpt-5.4').catch(() => { /* 失败是预期 */ });
    /* 只应看到摘要模型, 不应出现当前模型的重试 */
    expect(seen.every(m => m.includes('mini'))).toBe(true);
    expect(seen).not.toContain('gpt-5.4');
  });

  it('摘要模型本来就等于当前模型时不重复调用', async () => {
    const s = new LLMSummarizer({ protectRecentCount: 2, protectHeadCount: 1 });
    /* gpt-5.5 的映射结果就是它自己 */
    const { seen, provider } = providerRejecting(
      () => true,
      new Error('model not found'),
    );
    await s.summarize(bigConversation(), 4_000, provider, 'gpt-5.5').catch(() => { /* 预期失败 */ });
    const calls = seen.filter(m => m === 'gpt-5.5').length;
    expect(calls).toBeGreaterThan(0);
    /* 每个桶只该被调一次 —— 同名模型不该再触发一次"退回当前模型" */
    expect(new Set(seen).size).toBe(1);
  });
});
