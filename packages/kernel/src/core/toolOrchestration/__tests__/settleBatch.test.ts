/**
 * LOOP-04: 工具批次 1 个失败不许丢其余结果。
 *
 * `Promise.all` 下 5 个并行工具里 1 个 task reject, 另外 4 个**已经跑完**的结果也会一起丢,
 * 模型读成"结果全丢了" → 原样重跑 → 又压一张审批卡。这里守的是机制层:
 * reject 的只让它自己失败, 成功的照常落地。
 */
import { describe, expect, it } from 'vitest';
import { settleEach } from '../settleBatch.js';

describe('settleEach — 一个 reject 不拖垮其余', () => {
  it('5 个里 1 个 reject: 4 个成功照常落地, 只有那 1 个进 onRejected', async () => {
    const done: string[] = [];
    const rejected: Array<{ item: string; reason: unknown }> = [];
    const items = ['a', 'b', 'boom', 'd', 'e'];

    await settleEach(
      items,
      async (item) => {
        if (item === 'boom') throw new Error('approval rejected');
        done.push(item);
      },
      (item, reason) => rejected.push({ item, reason }),
    );

    expect(done).toEqual(['a', 'b', 'd', 'e']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.item).toBe('boom');
    expect((rejected[0]!.reason as Error).message).toBe('approval rejected');
  });

  it('整批全 reject 也不抛 —— settleEach 自己吃掉 rejection', async () => {
    const rejected: string[] = [];
    await expect(settleEach(
      ['a', 'b'],
      async () => { throw new Error('worker gone'); },
      (item) => rejected.push(item),
    )).resolves.toBeUndefined();
    expect(rejected).toEqual(['a', 'b']);
  });

  it('onRejected 自己抛也不影响其余回调', async () => {
    const rejected: string[] = [];
    await settleEach(
      ['boom1', 'ok', 'boom2'],
      async (item) => { if (item !== 'ok') throw new Error('x'); },
      (item) => { rejected.push(item); throw new Error('handler bug'); },
    );
    expect(rejected).toEqual(['boom1', 'boom2']);
  });
});
