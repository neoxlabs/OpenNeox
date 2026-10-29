/**
 * browser_run 回执的 page 只发差异 —— 同一页 (origin+path) 连着跑时。
 * 编号钉在元素上不复用 (见 browserRef.test), 所以没列出来的 ref 照常能用。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pageWithDelta, __resetBrowserViewState, type PageSnapshot } from '../browserRun.js';

const refs = (n: number, tweak: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, k) => `${k + 1}: button "${tweak[k + 1] ?? `b${k + 1}`}"`);
const page = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'https://a.com/list?page=1', title: 'List', actionable: refs(30), digest: 'rows…', rows: 10,
  refHint: 'hint', structure: { paging: '第 1/3 页' }, ...over,
});

beforeEach(() => __resetBrowserViewState());

describe('pageWithDelta', () => {
  it('第一次整份 (带 refHint)', () => {
    const p = pageWithDelta(page(), 's', false);
    expect(p.actionable).toHaveLength(30);
    expect(p.refHint).toBe('hint');
  });

  it('同页第二次: 只发变了的 ref 和变了的字段, url 照发', () => {
    pageWithDelta(page(), 's', false);
    const p = pageWithDelta(page({
      url: 'https://a.com/list?page=2', actionable: [...refs(30, { 5: 'done' }), '31: button "new"'],
      structure: { paging: '第 2/3 页' },
    }), 's', false) as any;
    expect(p.actionable).toBeUndefined();
    expect(p.refHint).toBeUndefined();
    expect(p.url).toBe('https://a.com/list?page=2');
    expect(p.pageDelta.changed).toEqual(['5: button "done"']);
    expect(p.pageDelta.added).toEqual(['31: button "new"']);
    expect(p.structure).toEqual({ paging: '第 2/3 页' });
    expect(p.digest).toBeUndefined();
    expect(p.pageDelta.unchangedFields).toEqual(expect.arrayContaining(['title', 'digest', 'rows']));
  });

  it('换页面 / fullPage / 没有会话 → 整份', () => {
    pageWithDelta(page(), 's', false);
    expect(pageWithDelta(page({ url: 'https://a.com/detail' }), 's', false).actionable).toHaveLength(30);
    expect(pageWithDelta(page(), 's', true).actionable).toHaveLength(30);
    expect(pageWithDelta(page(), undefined, false).actionable).toHaveLength(30);
  });
});
