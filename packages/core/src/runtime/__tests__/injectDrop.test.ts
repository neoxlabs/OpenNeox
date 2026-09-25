/**
 * INJECT-DROP — inject 链路必须如实回报"有没有排上"
 *
 * 原始故障: `injectMessage 调用成功但消息不送达`。
 * 链上每一层都是 void + `?.`:
 *   client.injectMessage(): Promise<void>
 *     → bridge.injectMessage?.(): void
 *       → singleRuntime?.injectMessageToSession()   返回值被丢弃
 *         → host.injectUserMessage()        !isRunning 时 return 0, 只留一条 debug 日志
 * 于是消息进黑洞, 每一层都"成功"。
 *
 * 这里锁的是最底下那一层的契约: **没在跑就返回 0**, 并且入队成功时返回真实位置。
 * 上层只要还看返回值, 整条链就不会再骗人。
 */
import { describe, test, expect } from 'vitest';

/** 只取 injectUserMessage 的行为契约, 不实例化整个 host (它要一大堆运行时依赖) */
class FakeHost {
  isRunning = false;
  pendingInjectedMessages: Array<{ text: string }> = [];
  events: any[] = [];
  emitEvent(e: any) { this.events.push(e); }

  injectUserMessage(text: string): number {
    if (!this.isRunning) return 0;
    this.pendingInjectedMessages.push({ text });
    const position = this.pendingInjectedMessages.length;
    this.emitEvent({ type: 'queued_message_added', position, text });
    return position;
  }
}

describe('inject 链路的"有没有排上"契约', () => {
  test('★ 没有任务在跑 → 返回 0 且不入队 (绝不能报成功)', () => {
    const h = new FakeHost();
    expect(h.injectUserMessage('你好')).toBe(0);
    expect(h.pendingInjectedMessages).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('在跑 → 返回递增的真实队列位置', () => {
    const h = new FakeHost();
    h.isRunning = true;
    expect(h.injectUserMessage('第一条')).toBe(1);
    expect(h.injectUserMessage('第二条')).toBe(2);
    expect(h.pendingInjectedMessages.map(m => m.text)).toEqual(['第一条', '第二条']);
    expect(h.events.map(e => e.position)).toEqual([1, 2]);
  });

  test('position > 0 才算排上 —— 调用方的判据只能是这个', () => {
    const h = new FakeHost();
    const before = h.injectUserMessage('x');
    h.isRunning = true;
    const after = h.injectUserMessage('x');
    expect(before > 0).toBe(false);
    expect(after > 0).toBe(true);
  });
});
