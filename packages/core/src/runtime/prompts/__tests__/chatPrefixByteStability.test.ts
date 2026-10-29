/// chatPrefixByteStability.test.ts — 聊天档 system 段两分钟内逐字节相同 (C2-16).
///
/// 验收口径来自方案: 「两分钟内两次请求的 system 段逐字节相同 (抓 payload 比对)」。
/// 这里把聊天档真正进 system 的两块拼起来比: 轻聊天提示词 (buildChatPrompt) +
/// 日期/时区段 (buildChatTimeContext); 分钟级时间只允许出现在本轮用户消息尾部的
/// <current-time> 里, 不进 system。
import { describe, expect, it } from 'vitest';

import { buildChatPrompt } from '../chatPrompt.js';
import { buildChatTimeContext } from '../chatLightPrompt.js';

function chatSystem(at: Date): string {
  return [
    buildChatPrompt('chat', 'zh', { search: true, image: true }),
    buildChatTimeContext('zh', at),
  ].join('\n\n');
}

describe('C2-16 聊天档前缀字节稳定', () => {
  it('两分钟内两次请求: system 段逐字节相同', () => {
    const first = chatSystem(new Date(2026, 9, 18, 3, 25, 10));
    const second = chatSystem(new Date(2026, 9, 18, 3, 27, 42));

    expect(second).toBe(first);
  });

  it('system 段里没有分钟级时间 (有就会分钟一变, 前缀缓存全作废)', () => {
    const system = chatSystem(new Date(2026, 9, 18, 3, 25));

    expect(system).not.toContain('03:25');
    /* 时区偏移 (UTC+08:00) 是常量, 剥掉再看还有没有 HH:MM */
    expect(system.replace(/UTC[+-]\d{2}:\d{2}/g, '')).not.toMatch(/\d{2}:\d{2}/);
  });

  it('跨天只变一次 (模型仍知道今天几号)', () => {
    const today = chatSystem(new Date(2026, 9, 18, 3, 25));
    const tomorrow = chatSystem(new Date(2026, 9, 19, 3, 25));

    expect(tomorrow).not.toBe(today);
    expect(tomorrow).toContain('2026-10-19');
  });
});
