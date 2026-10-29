/**
 * 流式 tool_calls 槽位归属。
 *
 * 上游可能在同一个 index 发送带新 id 的调用，因此槽位必须按调用 id 归属，
 * 同时处理 index 复用，避免不同调用的参数串接。
 */
import { describe, expect, it } from 'vitest';
import { ToolCallSlotTracker } from '../streamToolCallSlots.js';

describe('ToolCallSlotTracker', () => {
  it('标准 OpenAI 序列: 按 index 填槽, 同 id 后续分片回同一槽', () => {
    const t = new ToolCallSlotTracker();
    expect(t.resolve({ index: 0, id: 'a' })).toBe(0);
    expect(t.resolve({ index: 0 })).toBe(0);
    expect(t.resolve({ index: 1, id: 'b' })).toBe(1);
    expect(t.resolve({ index: 0 })).toBe(0);
    expect(t.resolve({ index: 1 })).toBe(1);
  });

  it('⚠️ 同 index 带新 id = 新调用, 另开一槽 (DS exp 那次的形状)', () => {
    const t = new ToolCallSlotTracker();
    expect(t.resolve({ index: 0, id: 'call_1' })).toBe(0);
    expect(t.resolve({ index: 0 })).toBe(0);
    expect(t.resolve({ index: 0, id: 'call_2' })).toBe(1);
    /* call_2 后面不带 id 的分片按 index 0 来 —— 没有 id 时归到最后开的那个槽 */
    expect(t.resolve({ index: 0 })).toBe(0);
    /* 带 id 的一律回自己的槽, 不看 index */
    expect(t.resolve({ index: 0, id: 'call_2' })).toBe(1);
    expect(t.resolve({ index: 5, id: 'call_1' })).toBe(0);
  });

  it('不带 index: 有 id 开新槽, 无 id 归到最后一槽', () => {
    const t = new ToolCallSlotTracker();
    expect(t.resolve({ id: 'x' })).toBe(0);
    expect(t.resolve({})).toBe(0);
    expect(t.resolve({ id: 'y' })).toBe(1);
    expect(t.resolve({})).toBe(1);
  });

  it('第一片没带 id、第二片才带 (正常序列) 不会被错拆', () => {
    const t = new ToolCallSlotTracker();
    expect(t.resolve({ index: 0 })).toBe(0);
    expect(t.resolve({ index: 0, id: 'late' })).toBe(0);
    expect(t.resolve({ index: 0 })).toBe(0);
  });

  it('跳号 index 照旧保留 (densify 在下游处理)', () => {
    const t = new ToolCallSlotTracker();
    expect(t.resolve({ index: 3, id: 'a' })).toBe(3);
    expect(t.resolve({ index: 3 })).toBe(3);
    expect(t.resolve({ index: 3, id: 'b' })).toBe(4);
  });
});
