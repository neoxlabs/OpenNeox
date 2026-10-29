import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, _resetSurfaceStoreForTest } = store as any;
const view = (sid: string) => (store as any).__peekSurfaces(sid);

let clock = 1_000;
const open = (sid: string, id: string, kind = 'doc') => {
  clock += 1000;
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id, kind, title: id,
      source: { type: 'inline', content: `content-of-${id}` },
      pinned: false, createdAt: clock, updatedAt: clock,
    },
  });
};

beforeEach(() => { _resetSurfaceStoreForTest?.(); clock = 1_000; });

describe('surfaceStore 快照身份', () => {
  it('别的会话动了东西, 本会话的快照数组身份不变', () => {
    open('A', 'a1');
    open('B', 'b1');
    const beforeA = view('A');
    const beforeB = view('B');

    open('B', 'b2');   /* 只动 B */

    expect(view('A')).toBe(beforeA);          /* ← 关键: A 必须还是同一个数组 */
    expect(view('B')).not.toBe(beforeB);      /* B 真变了, 该换身份 */
    expect(view('B')).toHaveLength(2);
  });

  it('同一个会话重复触发但内容没变 → 快照身份保持', () => {
    open('A', 'a1');
    const before = view('A');
    /* 用一次不存在 id 的 close 触发重建路径, 但内容其实没变 */
    ingestSurfaceEvent('A', { action: 'close', surfaceId: 'does-not-exist' });
    expect(view('A')).toBe(before);
  });

  it('内容真变了必须换身份, 不能因为省渲染把更新吃掉', () => {
    open('A', 'a1');
    const before = view('A');
    open('A', 'a2');
    const after = view('A');
    expect(after).not.toBe(before);
    expect(after.map((s: any) => s.id).sort()).toEqual(['a1', 'a2']);
  });

  it('未被改动的 surface 对象自身也保持身份 (viewer 的 effect 依赖靠它)', () => {
    open('A', 'a1');
    open('A', 'a2');
    const a1Before = view('A').find((s: any) => s.id === 'a1');
    open('A', 'a3');
    const a1After = view('A').find((s: any) => s.id === 'a1');
    expect(a1After).toBe(a1Before);
    expect(a1After.source).toBe(a1Before.source);
  });
});
