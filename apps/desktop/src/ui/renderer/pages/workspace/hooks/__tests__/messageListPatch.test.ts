import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../../../../shared/ipc';
import { patchMessageById, makeForegroundMessageDispatch } from '../messageListPatch';

describe('makeForegroundMessageDispatch', () => {
  test('事件属于后台会话 → 不写 (真机: 后台会话首段输出把助手消息塞进前台列表, 之后每帧改它)', () => {
    const calls: unknown[] = [];
    const ref = { current: 'fg' as string | null };
    const dispatchFg = makeForegroundMessageDispatch((fn) => calls.push(fn), ref);
    dispatchFg('bg', (prev) => prev);
    expect(calls).toHaveLength(0);
    dispatchFg('fg', (prev) => prev);
    expect(calls).toHaveLength(1);
  });

  test('读的是 ref 的实时值: 切到那个会话之后它的事件才开始写', () => {
    const calls: unknown[] = [];
    const ref = { current: 'a' as string | null };
    const dispatchFg = makeForegroundMessageDispatch((fn) => calls.push(fn), ref);
    dispatchFg('b', (prev) => prev);
    ref.current = 'b';
    dispatchFg('b', (prev) => prev);
    expect(calls).toHaveLength(1);
  });
});

const msgs = (): ChatMessage[] => ([
  { id: 'u1', role: 'user', text: '问', pending: false, timestamp: 1 } as ChatMessage,
  { id: 'a1', role: 'assistant', text: '答', pending: true, timestamp: 2 } as ChatMessage,
]);

describe('patchMessageById', () => {
  test('id 不在列表里 (后台会话的 slot) → 原样返回同一个数组引用', () => {
    const prev = msgs();
    expect(patchMessageById(prev, 'bg-session-msg', (m) => ({ ...m, text: m.text + 'x' }))).toBe(prev);
  });

  test('命中 → 新数组, 只替换那一条, 其余条目引用不变', () => {
    const prev = msgs();
    const next = patchMessageById(prev, 'a1', (m) => ({ ...m, text: m.text + '案' }));
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1].text).toBe('答案');
  });

  test('patch 返回 null (条件不满足, 例如正文已有内容不补全) → 原样返回', () => {
    const prev = msgs();
    expect(patchMessageById(prev, 'a1', (m) => (m.text ? null : { ...m, text: '补' }))).toBe(prev);
  });
});
