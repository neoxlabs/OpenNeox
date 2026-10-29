/**
 * 「编辑并重发」锚点 k 的对照测试 —— 见 editResendAnchor.ts 头部.
 * 数错一位不会报错, 只会让界面和模型记忆停在两个不同的位置, 所以这里逐位钉死。
 */

import { describe, expect, test } from 'vitest';
import { userMessageIndexFromEnd, type AnchorEntry } from '../editResendAnchor';

const u = (id: string): AnchorEntry => ({ id, type: 'user_message' });
const a = (id: string): AnchorEntry => ({ id, type: 'assistant_message' });
const t = (id: string): AnchorEntry => ({ id, type: 'tool_call' });

/* 三轮完整对话 */
const FEED: AnchorEntry[] = [u('u1'), a('a1'), t('t1'), u('u2'), a('a2'), t('t2'), u('u3'), a('a3')];

describe('userMessageIndexFromEnd', () => {
  test('最后一条用户消息 → k=1', () => {
    expect(userMessageIndexFromEnd(FEED, 'u3')).toBe(1);
  });

  test('倒数第二条 → k=2 (中间夹着助手消息和工具调用, 都不参与数)', () => {
    expect(userMessageIndexFromEnd(FEED, 'u2')).toBe(2);
  });

  test('第一条 → k=3', () => {
    expect(userMessageIndexFromEnd(FEED, 'u1')).toBe(3);
  });

  test('锚点后面还挂着助手消息, 不影响 k —— k 只数用户消息', () => {
    expect(userMessageIndexFromEnd([...FEED, a('a4'), t('t4')], 'u3')).toBe(1);
  });

  test('锚点不在列表里 → -1 (调用方中止, 不能瞎裁)', () => {
    expect(userMessageIndexFromEnd(FEED, 'nope')).toBe(-1);
  });

  test('锚点不是用户消息 → -1, 不去猜"最近的那条用户消息"', () => {
    expect(userMessageIndexFromEnd(FEED, 'a2')).toBe(-1);
    expect(userMessageIndexFromEnd(FEED, 't1')).toBe(-1);
  });

  test('空 id / 空列表 → -1', () => {
    expect(userMessageIndexFromEnd(FEED, '')).toBe(-1);
    expect(userMessageIndexFromEnd([], 'u1')).toBe(-1);
  });

  test('只有一条用户消息的会话 → k=1', () => {
    expect(userMessageIndexFromEnd([u('only')], 'only')).toBe(1);
  });

  test('连着两条用户消息 (用户连发) → 各自 k 相差 1', () => {
    const feed = [u('x1'), u('x2'), a('y')];
    expect(userMessageIndexFromEnd(feed, 'x2')).toBe(1);
    expect(userMessageIndexFromEnd(feed, 'x1')).toBe(2);
  });
});
