/** 验证保护区裁剪和可压缩量门槛，避免摘要结果扩大上下文或无效调用模型。 */
import { describe, it, expect } from 'vitest';
import { LLMSummarizer } from '../llmSummarizer.js';

const failingProvider: any = {
  chat: () => { throw new Error('LLM 不该被调用'); },
  chatStreamed: () => { throw new Error('LLM 不该被调用'); },
};

describe('summarize 根治守卫', () => {
  it('尾部保护区里的 40K 巨消息被就地裁剪, 且不烧 LLM', async () => {
    const s = new LLMSummarizer();
    const huge = 'log line xxxxxxxxxxxxxxxx\n'.repeat(8000); // ~200KB ≈ 50K tokens
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '帮我归档这份日志:\n' + huge },   // 短会话: 全在保护区
      { role: 'assistant', content: '已归档' },
    ];
    const r = await s.summarize(messages, 32_000, failingProvider, 'grok-4.5');
    // LLM 没被调 (failingProvider 会抛) 且结果显著变小
    expect(r.compressedTokens).toBeLessThan(r.originalTokens * 0.5);
    expect(r.savedTokens).toBeGreaterThan(0);
    const user = r.messages.find((m: any) => m.role === 'user');
    expect(String(user.content)).toContain('已截断');
    expect(String(user.content).startsWith('帮我归档这份日志:')).toBe(true);  // 头保留
  });

  it('小会话无超大消息: 原样返回, 零副作用, 不烧 LLM', async () => {
    const s = new LLMSummarizer();
    const messages: any[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好!' },
    ];
    const r = await s.summarize(messages, 32_000, failingProvider, 'grok-4.5');
    expect(r.messages).toBe(messages);          // 引用相等 = 完全没动
    expect(r.savedTokens).toBe(0);
  });

  it('多模态保护消息不裁', async () => {
    const s = new LLMSummarizer();
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(300_000) }] },
      { role: 'assistant', content: 'ok' },
    ];
    const r = await s.summarize(messages, 32_000, failingProvider, 'grok-4.5');
    expect(Array.isArray(r.messages.find((m: any) => m.role === 'user').content)).toBe(true);
  });
});
