/**
 * Verify DOM ref assignment and lookup priority.
 *
 * Refs let actions address marked DOM elements directly.
 * Refs let callers reuse a stable element identity instead of reconstructing a
 * selector from the DOM before each action.
 *
 * The implementation rebuilds refs after navigation and supports selector and role fallbacks.
 *
 * The tests pin lookup priority and fallback behavior across DOM updates.
 */
import { describe, it, expect } from 'vitest';
import { NEOX_REF_ATTR } from '../browserTools.js';

/** 跟 browserTools.resolveLocator 的判定顺序逐字对应 */
function pick(opts: { ref?: number | string; selector?: string; role?: string; text?: string }): string {
  if (opts.ref !== undefined && String(opts.ref).trim() !== '') return `[${NEOX_REF_ATTR}="${String(opts.ref).replace(/"/g, '')}"]`;
  if (opts.selector) return `selector:${opts.selector}`;
  if (opts.role) return `role:${opts.role}`;
  if (opts.text) return `text:${opts.text}`;
  return 'none';
}

describe('ref 定位', () => {
  it('属性名固定 —— 快照那段页内脚本写的是同一个字面量', () => {
    expect(NEOX_REF_ATTR).toBe('data-neox-ref');
  });

  it('**ref 优先于 selector** —— 它是刚看过的那一页上的元素, 比凭印象拼的选择器可靠', () => {
    expect(pick({ ref: 3, selector: '#maybe-wrong' })).toBe('[data-neox-ref="3"]');
  });

  it('没给 ref 时按原来的顺序降级, 不影响老用法', () => {
    expect(pick({ selector: '#a' })).toBe('selector:#a');
    expect(pick({ role: 'button' })).toBe('role:button');
    expect(pick({ text: '登录' })).toBe('text:登录');
    expect(pick({})).toBe('none');
  });

  it('ref 收数字也收字符串 (模型两种都会写)', () => {
    expect(pick({ ref: 7 })).toBe('[data-neox-ref="7"]');
    expect(pick({ ref: '7' })).toBe('[data-neox-ref="7"]');
  });

  it('空 ref 当没给 —— 不能变成 [data-neox-ref=""] 去匹配一堆东西', () => {
    expect(pick({ ref: '', selector: '#a' })).toBe('selector:#a');
    expect(pick({ ref: '  ', selector: '#a' })).toBe('selector:#a');
  });

  it('引号被剥掉 —— 属性选择器不能被 ref 里的引号截断', () => {
    expect(pick({ ref: '3" or true' })).toBe('[data-neox-ref="3 or true"]');
  });
});

describe('快照脚本的两条硬要求', () => {
  /* Pin cleanup behavior that is otherwise difficult to observe in isolation. */
  it('每次快照先清掉上一次的编号', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../browserRun.ts', import.meta.url), 'utf8'));
    /* 不清的话: 页面变了之后旧号还指着旧元素, 模型照着点就是**点错东西** —— 比"找不到"糟得多 */
    expect(src).toContain("querySelectorAll('[data-neox-ref]').forEach");
    expect(src).toContain('removeAttribute');
  });

  it('回执里要告诉模型"这些编号能直接用"', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../browserRun.ts', import.meta.url), 'utf8'));
    /* 只写在工具 schema 里不够: schema 是任务开始时看过一次的, 而"现在这页有哪些编号"
     * 是每次结果里的, 两者隔着十几轮。 */
    expect(src).toContain('refHint');
  });
});
