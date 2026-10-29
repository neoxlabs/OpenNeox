import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, getSurfacesForTest, _resetSurfaceStoreForTest, closeSurface } = store as any;

/** 直接读缓存视图 —— useSurfaces 要 React 环境, 这里测的是它背后那份数据 */
const view = (sid: string) => (store as any).__peekSurfaces?.(sid) ?? getSurfacesForTest?.(sid) ?? [];

const openSurface = (sid: string, id: string, kind: string, title: string) => {
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id, kind, title,
      source: { type: 'inline', content: 'x' },
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
};

describe('常驻 surface 跨会话共享', () => {
  beforeEach(() => _resetSurfaceStoreForTest());

  it('在会话 A 开的服务面板, 会话 B 也看得见', () => {
    openSurface('A', 'svc-1', 'services', '服务');
    const inA = view('A').map((s: any) => s.id);
    const inB = view('B').map((s: any) => s.id);
    expect(inA).toContain('svc-1');
    expect(inB).toContain('svc-1');
  });

  it('浏览器同理 —— 它对应的是真窗口, 不该跟着会话走', () => {
    openSurface('A', 'web-1', 'web', '浏览器');
    /* web 会被 normalize 成单 host (id 变成 web-host-<sid>), 所以按 kind 断言而不是 id */
    expect(view('B').some((s: any) => s.kind === 'web')).toBe(true);
  });

  it('临时类只属于自己那条会话, 绝不串台', () => {
    openSurface('A', 'doc-1', 'doc', '一份文档');
    openSurface('B', 'doc-2', 'doc', '另一份文档');
    expect(view('A').map((s: any) => s.id)).toEqual(['doc-1']);
    expect(view('B').map((s: any) => s.id)).toEqual(['doc-2']);
  });

  it('常驻的排在临时的前面 —— 位置要稳, 不能被新开的文档挤走', () => {
    openSurface('A', 'doc-1', 'doc', '文档');
    openSurface('A', 'svc-1', 'services', '服务');
    expect(view('A')[0].id).toBe('svc-1');
  });

  it('关掉常驻的 = 所有会话都不再显示 (语义一致, 不留幽灵)', () => {
    openSurface('A', 'svc-1', 'services', '服务');
    const realId = view('A').find((s: any) => s.kind === 'services')?.id;
    expect(realId, 'services surface 应该存在').toBeTruthy();
    expect(view('B').map((s: any) => s.id)).toContain(realId);
    /* 用**落库后的真实 id** 关 —— normalize 可能改写 id (web 就会变成 web-host-<sid>),
     * 拿调用方传进去的 id 去关会关不掉, 那是测试自己的坑不是产品的。 */
    closeSurface('A', realId!);
    expect(view('A').map((s: any) => s.id)).not.toContain(realId);
    expect(view('B').map((s: any) => s.id)).not.toContain(realId);
  });

  it('别的会话已经开着服务, 这条会话再开一次不会多出第二个 tab', () => {
    openSurface('A', 'svc-1', 'services', '服务');
    openSurface('B', 'svc-2', 'services', '服务');
    expect(view('B').filter((s: any) => s.kind === 'services')).toHaveLength(1);
    expect(view('A').filter((s: any) => s.kind === 'services')).toHaveLength(1);
    expect(view('B')[0].id).toBe('svc-1');
  });

  it('在别的会话里也关得掉 —— 共享的东西, 从哪条会话点叉都该生效', () => {
    openSurface('A', 'svc-1', 'services', '服务');
    openSurface('B', 'doc-9', 'doc', '文档');
    closeSurface('B', 'svc-1');
    expect(view('A').map((s: any) => s.id)).not.toContain('svc-1');
    expect(view('B').map((s: any) => s.id)).toEqual(['doc-9']);
  });

  it('常驻的在别处更新后, 其它会话的视图也跟着变 (不是停在旧快照)', () => {
    openSurface('A', 'svc-1', 'services', '服务');
    const realId = view('A').find((s: any) => s.kind === 'services')!.id;
    expect(view('B').find((s: any) => s.id === realId)?.title).toBe('服务');
    ingestSurfaceEvent('A', { action: 'update', surfaceId: realId, patch: { title: '服务 · 2 个在跑' } });
    expect(view('B').find((s: any) => s.id === realId)?.title).toBe('服务 · 2 个在跑');
  });
});
