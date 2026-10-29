import { describe, it, expect } from 'vitest';
import { resolveQueuedCancel } from '../TimelineComposer';

describe('resolveQueuedCancel', () => {
  it('摘到了 → 退回输入框 (就是这次修的 bug)', () => {
    const r = resolveQueuedCancel(['帮我改一下'], '帮我改一下', '');
    expect(r.restored).toBe(true);
    expect(r.nextValue).toBe('帮我改一下');
    expect(r.nextQueued).toEqual([]);
  });

  it('摘不到 (引擎已消费) → 绝不退回, 否则同一句话发两遍', () => {
    for (const removed of [null, undefined, '']) {
      const r = resolveQueuedCancel(['已经在路上了'], removed, '');
      expect(r.restored).toBe(false);
      expect(r.nextValue).toBe('');          /* 输入框保持原样 */
      expect(r.nextQueued).toEqual([]);      /* 但本地队列要摘掉 —— 它已经不在队列里了 */
    }
  });

  it('输入框已有内容 → 换行接上, 不覆盖用户正在写的东西', () => {
    const r = resolveQueuedCancel(['排队的那条'], '排队的那条', '我正在写的');
    expect(r.nextValue).toBe('我正在写的\n排队的那条');
  });

  it('输入框只有空白 → 直接替换, 不留一行空行', () => {
    const r = resolveQueuedCancel(['x'], 'x', '   ');
    expect(r.nextValue).toBe('x');
  });

  it('本地一律摘最后一条 —— 服务端只有 dequeue-last', () => {
    /* 按点击的 index 删会让本地和服务端队列错位: 用户点中间那条, 服务端摘的是最后一条。 */
    const r = resolveQueuedCancel(['第一条', '第二条', '第三条'], '第三条', '');
    expect(r.nextQueued).toEqual(['第一条', '第二条']);
    expect(r.nextValue).toBe('第三条');
  });

  it('空队列不炸', () => {
    const r = resolveQueuedCancel([], null, 'keep');
    expect(r.nextQueued).toEqual([]);
    expect(r.nextValue).toBe('keep');
  });
});
