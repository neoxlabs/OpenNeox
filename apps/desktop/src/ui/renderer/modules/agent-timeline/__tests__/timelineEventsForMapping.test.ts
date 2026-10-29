
import { describe, it, expect } from 'vitest';
import { isUserJustSent } from '../hooks/useTimelineEventsForMapping';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

const e = (id: string, type: string): TimelineEntry =>
  ({ id, type, title: 't', timestamp: 1 } as unknown as TimelineEntry);

describe('isUserJustSent · 只认"尾部新增了一条 user_message"', () => {
  it('尾部新增 user_message → true', () => {
    const next = [e('a1', 'assistant_message'), e('u1', 'user_message')];
    expect(isUserJustSent(1, 'a1', next)).toBe(true);
  });

  it('尾部新增的不是 user_message → false (agent 事件走原有 deferred)', () => {
    const next = [e('u1', 'user_message'), e('t1', 'tool_call')];
    expect(isUserJustSent(1, 'u1', next)).toBe(false);
  });

  it('长度没变, 只是内容更新 → false (不能每次流式更新都强制同步)', () => {
    const next = [e('u1', 'user_message')];
    expect(isUserJustSent(1, 'u1', next)).toBe(false);
  });

  it('长度增长但尾部 id 没变 → false (前面插入历史, 不是新发)', () => {
    const next = [e('h1', 'assistant_message'), e('h2', 'tool_call'), e('u1', 'user_message')];
    expect(isUserJustSent(1, 'u1', next)).toBe(false);
  });

  it('历史回捞: 批量增长但尾部是 agent 事件 → false', () => {
    const next = [e('h1', 'assistant_message'), e('u9', 'user_message'), e('t1', 'tool_call')];
    expect(isUserJustSent(1, 'u9', next)).toBe(false);
  });

  it('连续两次发送都要认', () => {
    const first = [e('u1', 'user_message')];
    expect(isUserJustSent(0, undefined, first)).toBe(true);
    const second = [...first, e('m1', 'assistant_message'), e('u2', 'user_message')];
    expect(isUserJustSent(1, 'u1', second)).toBe(true);
  });

  it('空数组 / 无尾部不抛也不误判', () => {
    expect(isUserJustSent(0, undefined, [])).toBe(false);
    expect(isUserJustSent(5, 'x', [])).toBe(false);
  });

  it('会话切换后从空开始的第一条也认', () => {
    expect(isUserJustSent(0, undefined, [e('u1', 'user_message')])).toBe(true);
  });
});
