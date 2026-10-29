import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, _resetSurfaceStoreForTest } = store as any;
const view = (sid: string) => (store as any).__peekSurfaces(sid);

const SID = 's1';
const ensure = { kind: 'todo' as const, title: '待办清单' };
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `任务${i}`, status: 'pending' as const }));

beforeEach(() => { _resetSurfaceStoreForTest?.(); });

describe('todo_replace upsert', () => {
  it('surface 不存在 + 带 ensureSurface → 现场建, 内容就是这批 items', () => {
    ingestSurfaceEvent(SID, {
      action: 'todo_replace', surfaceId: 'todo:current', todoItems: items(3), ensureSurface: ensure,
    });
    const todos = view(SID).filter((s: any) => s.kind === 'todo');
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('todo:current');
    expect(todos[0].title).toBe('待办清单');
    expect(JSON.parse(todos[0].source.content).items).toHaveLength(3);
  });

  it('第二次换了 surfaceId 也复用同一个 todo surface, 不长第二个 tab', () => {
    ingestSurfaceEvent(SID, { action: 'todo_replace', surfaceId: 'todo:current', todoItems: items(2), ensureSurface: ensure });
    ingestSurfaceEvent(SID, { action: 'todo_replace', surfaceId: 'todo', todoItems: items(4), ensureSurface: ensure });
    ingestSurfaceEvent(SID, { action: 'todo_replace', surfaceId: 'current', todoItems: items(5), ensureSurface: ensure });
    const todos = view(SID).filter((s: any) => s.kind === 'todo');
    expect(todos).toHaveLength(1);
    expect(JSON.parse(todos[0].source.content).items).toHaveLength(5);
  });

  it('没带 ensureSurface 且 surface 不存在 → 保持老的拒绝行为, 不凭空造', () => {
    ingestSurfaceEvent(SID, { action: 'todo_replace', surfaceId: 'nope', todoItems: items(2) });
    expect(view(SID).filter((s: any) => s.kind === 'todo')).toHaveLength(0);
  });

  it('surfaceId 撞上一个非 todo 的 surface → 拒绝, 不会把别人的面板改成清单', () => {
    ingestSurfaceEvent(SID, {
      action: 'open',
      surface: {
        id: 'doc1', kind: 'doc', title: 'd',
        source: { type: 'inline', content: 'hello' },
        pinned: false, createdAt: 1, updatedAt: 1,
      },
    });
    ingestSurfaceEvent(SID, { action: 'todo_replace', surfaceId: 'doc1', todoItems: items(2) });
    const doc = view(SID).find((s: any) => s.id === 'doc1');
    expect(doc.kind).toBe('doc');
    expect(doc.source.content).toBe('hello');
  });
});
