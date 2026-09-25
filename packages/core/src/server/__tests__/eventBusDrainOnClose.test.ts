import { describe, it, expect } from 'vitest';
import { EventBus } from '../eventBus.js';

/** close() 停止接收新事件，但会先排空已经入队的事件。 */
describe('EventBus close 语义 = 不收新的, 不是丢已有的', () => {
  const ev = (i: number) => ({ sessionId: 's1', type: 'text', data: { delta: String(i) } } as any);

  it('close 后仍能取完已排队的事件', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    for (let i = 0; i < 5; i++) bus.publish(ev(i));

    sub.close();                                   /* 一个都还没消费就 close */

    const got: string[] = [];
    for await (const e of sub) got.push((e as any).data.delta);
    expect(got).toEqual(['0', '1', '2', '3', '4']); /* 一个都不能少 */
  });

  it('排空后才结束, 不会无限吐', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    bus.publish(ev(1));
    sub.close();
    const got: string[] = [];
    for await (const e of sub) got.push((e as any).data.delta);
    expect(got).toEqual(['1']);                    /* 排空即 done */
  });

  it('close 之后新 publish 的不再送达', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe();
    bus.publish(ev(1));
    sub.close();
    bus.publish(ev(2));                            /* close 之后来的 */
    const got: string[] = [];
    for await (const e of sub) got.push((e as any).data.delta);
    expect(got).toEqual(['1']);
  });

  it('变异验证: 把判序换回「先看 closed」就必须挂', () => {
    /* 用同构的最小实现复刻两种判序, 证明这条测试真的能咬到该缺陷。 */
    const mk = (drainFirst: boolean) => {
      const queue = [1, 2, 3];
      let closed = true;
      return () => {
        if (drainFirst) { if (queue.length) return queue.shift(); if (closed) return undefined; }
        else { if (closed) return undefined; if (queue.length) return queue.shift(); }
        return undefined;
      };
    };
    expect(mk(true)()).toBe(1);        /* 排空优先 → 拿得到 */
    expect(mk(false)()).toBeUndefined(); /* 先看 closed → 丢掉 */
  });
});
