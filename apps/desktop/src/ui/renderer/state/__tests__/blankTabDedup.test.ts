import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, _resetSurfaceStoreForTest, isBlankTabUrl } = store as any;
const view = (sid: string) => (store as any).__peekSurfaces(sid);

let n = 0;
const openWeb = (sid: string, url: string) => {
  n += 1;
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id: `web-${n}`, kind: 'web', title: '浏览器',
      source: { type: 'url', url },
      pinned: false, createdAt: 1000 + n, updatedAt: 1000 + n,
    },
  });
};
const tabsOf = (sid: string) => {
  const host = view(sid).find((s: any) => s.kind === 'web');
  return (host?.metadata?.tabs ?? []) as Array<{ id: string; url: string }>;
};

describe('浏览器空白 tab 不重复堆积', () => {
  beforeEach(() => { n = 0; _resetSurfaceStoreForTest(); });

  it('连开三次空白浏览器 = 一条 tab, 不是三条', () => {
    openWeb('S', 'about:blank');
    openWeb('S', 'about:blank');
    openWeb('S', 'about:blank');
    expect(tabsOf('S').length).toBe(1);
  });

  it('真 URL 照旧各算各的 —— 不能顺手把正常多开也去重了', () => {
    openWeb('S', 'https://a.example/1');
    openWeb('S', 'https://a.example/2');
    expect(tabsOf('S').length).toBe(2);
  });

  it('空白 tab 之后再开真页面, 两条都在', () => {
    openWeb('S', 'about:blank');
    openWeb('S', 'https://a.example/1');
    expect(tabsOf('S').length).toBe(2);
  });

  it('盘上已经堆着的重复空白页, 再进来一次就被收敛掉', () => {
    /* 只靠"以后不再加"清不掉老用户已有的那几条 —— 必须进来时扫一遍。
     * 这里直接把 host 的 tabs 造成三条空白, 模拟从 SQLite 恢复出来的旧数据。 */
    openWeb('S', 'about:blank');
    const host = view('S').find((s: any) => s.kind === 'web');
    host.metadata.tabs = [
      { id: 'old1', url: 'about:blank', title: '浏览器' },
      { id: 'old2', url: 'about:blank', title: '浏览器' },
      { id: 'old3', url: '', title: '浏览器' },
    ];
    openWeb('S', 'about:blank');
    const tabs = tabsOf('S');
    expect(tabs.length, `没收敛: ${JSON.stringify(tabs)}`).toBe(1);
    expect(tabs[0].id).toBe('old1');   /* 留最早那条, 不是新造一条 */
  });

  it('isBlankTabUrl 的口径: 空串 / 空白字符 / 大小写都算空白', () => {
    for (const v of ['', '   ', 'about:blank', 'ABOUT:BLANK', ' about:blank ', null, undefined]) {
      expect(isBlankTabUrl(v), String(v)).toBe(true);
    }
    for (const v of ['https://x', 'about:config', '/tmp/a.ts']) {
      expect(isBlankTabUrl(v), String(v)).toBe(false);
    }
  });
});
