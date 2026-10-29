import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, _resetSurfaceStoreForTest, setActiveSurface } = store as any;
const view = (sid: string) => (store as any).__peekSurfaces(sid);

let clock = 1_000;
const open = (sid: string, id: string, opts: { pinned?: boolean } = {}) => {
  clock += 1000;
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id, kind: 'doc', title: id,
      source: { type: 'inline', content: 'x' },
      pinned: !!opts.pinned,
      createdAt: clock, updatedAt: clock,
    },
  });
};
/** 用一次 = 刷新 updatedAt */
const touch = (sid: string, id: string) => {
  clock += 1000;
  ingestSurfaceEvent(sid, { action: 'update', surfaceId: id, patch: { title: id } });
};

describe('标签不再有数量上限', () => {
  beforeEach(() => { clock = 1000; _resetSurfaceStoreForTest(); });

  it('开 20 个就是 20 个 —— 不许替用户关掉任何一个', () => {
    for (let i = 1; i <= 20; i++) open('S', `d${i}`);
    const ids = view('S').map((s: any) => s.id);
    expect(ids.length).toBe(20);
    /* 逐个点名, 不只看总数: 只判长度的话"挤掉 d2 又多开一个"也能蒙混过去 */
    for (let i = 1; i <= 20; i++) expect(ids, `d${i} 被谁关掉了`).toContain(`d${i}`);
  });

  it('用户正看着的那个当然更不能消失', () => {
    for (let i = 1; i <= 8; i++) open('S', `d${i}`);
    setActiveSurface('S', 'd1');
    for (let i = 9; i <= 16; i++) open('S', `d${i}`);
    expect(view('S').map((s: any) => s.id)).toContain('d1');
  });

  it('钉住的一样在', () => {
    open('S', 'pinned-1', { pinned: true });
    for (let i = 2; i <= 20; i++) open('S', `d${i}`);
    expect(view('S').map((s: any) => s.id)).toContain('pinned-1');
  });

  it('updatedAt 仍然跟着"用一次"走 —— 排序和最近使用都靠它', () => {
    /* 上限撤了不代表 LRU 这个信息没用: 标签排序、"最近打开"、将来真要做休眠都要它。
     * touch 之后 updatedAt 必须变大, 否则那套信息是死的。 */
    open('S', 'd1');
    const before = view('S').find((s: any) => s.id === 'd1').updatedAt;
    touch('S', 'd1');
    const after = view('S').find((s: any) => s.id === 'd1').updatedAt;
    expect(after).toBeGreaterThan(before);
  });
});

describe('关掉 active 之后焦点去哪', () => {
  beforeEach(() => { clock = 1000; _resetSurfaceStoreForTest(); });

  it('接班的是右邻, 不是"剩下里最早创建的那个"', () => {
    for (let i = 1; i <= 4; i++) open('S', `d${i}`);
    setActiveSurface('S', 'd2');
    ingestSurfaceEvent('S', { action: 'close', surfaceId: 'd2' });
    expect((store as any).__peekActiveId('S')).toBe('d3');
  });

  it('关的是最后一个就退到左邻', () => {
    for (let i = 1; i <= 3; i++) open('S', `d${i}`);
    setActiveSurface('S', 'd3');
    ingestSurfaceEvent('S', { action: 'close', surfaceId: 'd3' });
    expect((store as any).__peekActiveId('S')).toBe('d2');
  });
});
