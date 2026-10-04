import { describe, expect, it } from 'vitest';
import { detectReplyLanguage, resolveReplyLanguageTag } from '../replyLanguage.js';

describe('detectReplyLanguage', () => {
  it('中文任务 (夹几个英文术语) → zh', () => {
    expect(detectReplyLanguage('把存储从内存换成 SQLite（用 Node 自带的 node:sqlite）')).toBe('zh');
  });

  it('英文任务 → en', () => {
    expect(detectReplyLanguage('Find the best autumn-leaf spots in Kyoto')).toBe('en');
  });

  it('英文请求里贴了一段中文数据 → 数据不算, 还是 en', () => {
    const prompt = 'Summarize the complaints below in two bullet points.\n```\n用户反馈：物流太慢，客服不回消息，包装破损\n```';
    expect(detectReplyLanguage(prompt)).toBe('en');
  });

  it('路径和链接不算 (中文目录名不能把英文请求判成中文)', () => {
    expect(detectReplyLanguage('Open ~/Documents/Neox/工作/报告.md and fix the typos')).toBe('en');
  });

  it('太短看不出来 → null', () => {
    expect(detectReplyLanguage('ok')).toBeNull();
    expect(detectReplyLanguage('继续')).toBeNull();
  });
});

describe('resolveReplyLanguageTag', () => {
  it('看不出来时沿用本会话上一次的判定', () => {
    const sid = 'lang-carry-over';
    expect(resolveReplyLanguageTag(sid, '帮我把这份周报改得简洁一点')).toContain('中文');
    expect(resolveReplyLanguageTag(sid, 'ok')).toContain('中文');
  });

  it('新会话第一句就看不出来 → 不加标签, 交给系统段那条规则', () => {
    expect(resolveReplyLanguageTag('lang-unknown', 'ok')).toBe('');
  });

  it('标签明说工具输出的语言不改变回复语言', () => {
    expect(resolveReplyLanguageTag('lang-en', 'Build a budget workbook for the trip'))
      .toMatch(/<reply-language>[\s\S]*does not change this[\s\S]*<\/reply-language>/);
  });
});
