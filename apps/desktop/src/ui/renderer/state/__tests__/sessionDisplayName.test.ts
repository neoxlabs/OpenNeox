import { describe, expect, it } from 'vitest';
import { displaySessionName } from '../sessionDisplayName';

const AT = new Date(2026, 7, 1, 22, 18, 36).getTime();

describe('只反解技术默认名', () => {
  it('English 默认名 → 中文 + 24 小时制', () => {
    expect(displaySessionName('New Chat - 10:18:36 PM', AT, true)).toBe('新会话 · 22:18');
  });

  it('英文界面下也不是原样, 但保持英文', () => {
    expect(displaySessionName('New Chat - 10:18:36 PM', AT, false)).toBe('New chat · 22:18');
  });

  it('空名字也当默认名', () => {
    expect(displaySessionName('', AT, true)).toBe('新会话 · 22:18');
    expect(displaySessionName(null, AT, true)).toBe('新会话 · 22:18');
  });

  it('没有创建时间就只给个名字, 不编时间', () => {
    expect(displaySessionName('', undefined, true)).toBe('新会话');
  });

  it('用户自己起的名字一个字都不许动', () => {
    expect(displaySessionName('修 target 的自动续跑', AT, true)).toBe('修 target 的自动续跑');
    /* 名字里凑巧带 chat 也不算默认名 */
    expect(displaySessionName('chat 模块重构', AT, true)).toBe('chat 模块重构');
    expect(displaySessionName('New Chatroom 设计', AT, true)).toBe('New Chatroom 设计');
  });
});
