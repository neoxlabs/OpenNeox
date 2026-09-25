import { describe, test, expect } from 'vitest';
import { ShortTermMemory, MEMORY_BACKSTOP_MESSAGES } from '../shortterm';

/**
 * 消息条数上限只作为保险丝使用。越过上限时批量裁切到目标比例，保持裁切后的前缀稳定，
 * 让 token 预算和自动压缩承担常规上下文管理职责。
 */

function mem(cap?: number) {
  const m = new ShortTermMemory(cap);
  m.add({ role: 'system', content: 'SYS' } as any);
  return m;
}
const firstNonSystem = (m: ShortTermMemory) => {
  const all = m.getMessagesForLLM() as Array<{ role: string; content: unknown }>;
  return all.find((x) => x.role !== 'system')?.content;
};

describe('消息条数上限 = 保险丝, 且必须批量砍', () => {
  test('默认上限远高于压缩触发点 (按 ~520 token/条, 压缩约在 1300 条附近)', () => {
    expect(MEMORY_BACKSTOP_MESSAGES).toBeGreaterThan(10_000);
  });

  test('越线后一次砍到 70%, 不是砍一条', () => {
    const cap = 100;
    const m = mem(cap);
    for (let i = 0; i < cap + 5; i++) m.add({ role: 'user', content: `u${i}` } as any);
    const n = m.getMessagesForLLM().length;
    /* 砍到 ~70 条而不是 ~100 条 —— 这是"批量"的直接证据 */
    expect(n).toBeLessThanOrEqual(Math.floor(cap * 0.75) + 2);
    expect(n).toBeGreaterThan(Math.floor(cap * 0.6));
  });

  test('砍完之后连续加消息, 第 1 条必须长时间不变 (前缀稳定)', () => {
    const cap = 100;
    const m = mem(cap);
    for (let i = 0; i < cap + 5; i++) m.add({ role: 'user', content: `u${i}` } as any);
    const anchor = firstNonSystem(m);
    expect(anchor).toBeTruthy();
    /* 再加 20 条 —— 旧实现每加一条就换一次第 1 条; 新实现应当纹丝不动 */
    for (let i = 0; i < 20; i++) m.add({ role: 'user', content: `later${i}` } as any);
    expect(firstNonSystem(m)).toBe(anchor);
  });

  test('system 消息永远保留在最前面', () => {
    const cap = 60;
    const m = mem(cap);
    for (let i = 0; i < cap * 2; i++) m.add({ role: 'user', content: `u${i}` } as any);
    const all = m.getMessagesForLLM() as Array<{ role: string }>;
    expect(all[0].role).toBe('system');
    expect(all.filter((x) => x.role === 'system')).toHaveLength(1);
  });
});
