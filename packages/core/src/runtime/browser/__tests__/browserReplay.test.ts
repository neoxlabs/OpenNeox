/**
 * 录 → 存 → 复跑 → 自愈 → 写回, 整条链路。
 *
 * 用假工具跑, 因为要验的是**编排**: 什么时候存、失败时试哪些备选、什么时候不该重试、
 * 自愈的结果有没有写回文件。真实定位那一层由浏览器自己的测试覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@neox/kernel';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return { ...real, default: real, homedir: () => process.env.__NEOX_TEST_HOME__ || real.homedir() };
});

const { runBrowserScript, replayRecipe, replayAll } = await import('../browserRun.js');
const { loadRecipe, recipePath, saveRecipe } = await import('../browserRecipes.js');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neox-replay-'));
  process.env.__NEOX_TEST_HOME__ = home;
});
afterEach(() => {
  delete process.env.__NEOX_TEST_HOME__;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 一个按参数决定成败的假工具 —— 自愈要靠"换了参数就成功"来验。 */
function tool(name: string, impl: (a: Record<string, unknown>) => unknown): [string, Tool] {
  return [name, { name, function: async (a: Record<string, unknown>) => JSON.stringify(impl(a)) } as unknown as Tool];
}
const OK = { ok: true };
const MISS = { ok: false, error: 'locator not found: waiting for locator(".gone")' };

/** 收尾快照会调这些, 给个空实现免得每个用例都写一遍 */
function baseTools(extra: [string, Tool][]): Map<string, Tool> {
  return new Map<string, Tool>([
    tool('browser_get_state', () => ({ ok: true, url: 'https://x/', title: 'x' })),
    tool('browser_query', (a) => ({ ok: true, count: 1, texts: [a.selector === '.btn-x7f2' ? '登录' : ''] })),
    ...extra,
  ]);
}

describe('录制', () => {
  it('整段成功才存 —— 存一段半路失败的脚本, 下次复跑只会再失败一次', async () => {
    const tools = baseTools([tool('browser_click', () => MISS)]);
    const r = await runBrowserScript(
      { steps: [{ action: 'click', args: { selector: '.gone' } }], record: '每日报表' },
      tools,
    );
    expect(r.ok).toBe(false);
    expect(r.recorded).toBeUndefined();
    expect(existsSync(recipePath('每日报表'))).toBe(false);
  });

  it('成功时落成 SKILL.md, 并顺手把可见文字存成备用定位', async () => {
    const tools = baseTools([tool('browser_click', () => OK)]);
    const r = await runBrowserScript(
      { steps: [{ action: 'click', args: { selector: '.btn-x7f2' }, label: '登录' }],
        record: 'daily', recordDescription: '每天导报表' },
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.recorded?.steps).toBe(1);
    const saved = loadRecipe('daily');
    expect(saved?.steps[0]!.anchors).toEqual([{ text: '登录' }]);
    expect(readFileSync(recipePath('daily'), 'utf8')).toContain('每天导报表');
  });
});

describe('回放 + 自愈', () => {
  const RECIPE = {
    name: 'daily', description: '每天导报表',
    createdAt: 'T0', updatedAt: 'T0',
    steps: [{ action: 'click', args: { selector: '.btn-x7f2' }, label: '登录', anchors: [{ text: '登录' }] }],
  };

  it('主定位失效时用备用定位救回来, 并把生效的定位写回文件', async () => {
    saveRecipe(RECIPE);
    /* 选择器烂了 (类名换了), 但按钮上的字没变 */
    const tools = baseTools([tool('browser_click', (a) => (a.text === '登录' ? OK : MISS))]);
    const r = await replayRecipe('daily', tools) as any;
    expect(r.ok).toBe(true);
    expect(r.steps[0].healed).toContain('原定位失效');
    /* 写回了才有意义 —— 不写回下次还要再白付一次失败的超时 */
    const after = loadRecipe('daily')!;
    expect(after.steps[0]!.args).toEqual({ text: '登录' });
    expect(after.healCount).toBe(1);
  });

  it('**只对"找不到元素"自愈** —— 业务报错换个选择器再点一遍是有副作用的', async () => {
    saveRecipe(RECIPE);
    let calls = 0;
    const tools = baseTools([tool('browser_click', () => { calls++; return { ok: false, error: '表单校验没过: 手机号不合法' }; })]);
    const r = await replayRecipe('daily', tools) as any;
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);            /* 一次都没重试 */
    expect(loadRecipe('daily')!.healCount ?? 0).toBe(0);
  });

  it('备用定位也不行时如实失败, 不假装成功', async () => {
    saveRecipe(RECIPE);
    const tools = baseTools([tool('browser_click', () => MISS)]);
    const r = await replayRecipe('daily', tools) as any;
    expect(r.ok).toBe(false);
    expect(r.steps[0].healed).toBeUndefined();
  });

  it('没录过的名字: 明确说没有, 并把录过的列出来 (别让模型瞎猜名字)', async () => {
    saveRecipe(RECIPE);
    const r = await replayRecipe('不存在的', baseTools([])) as any;
    expect(r.ok).toBe(false);
    expect(r.available).toEqual(['daily']);
  });

  it('SKILL.md 的代码块被改坏时当"读不出来", **绝不当空脚本跑成功**', async () => {
    saveRecipe(RECIPE);
    const p = recipePath('daily');
    const broken = readFileSync(p, 'utf8').replace('"steps"', '"steps"坏了');
    (await import('node:fs')).writeFileSync(p, broken, 'utf8');
    const r = await replayRecipe('daily', baseTools([])) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('daily');
  });
});

describe('全部回放 = 回归测试 (2026-09-10)', () => {
  it('一张表: 谁过谁没过、坏在第几步; 一条失败不影响下一条', async () => {
    saveRecipe({ name: 'a-好的', description: 'a', createdAt: 'x', updatedAt: 'x',
      steps: [{ action: 'click', args: { selector: '.ok' } }] });
    saveRecipe({ name: 'b-坏的', description: 'b', createdAt: 'x', updatedAt: 'x',
      steps: [{ action: 'click', args: { selector: '.ok' } }, { action: 'click', args: { selector: '.gone' } }] });
    const tools = baseTools([tool('browser_click', (a) => (a.selector === '.gone' ? MISS : OK))]);
    const rep = await replayAll(tools);
    expect(rep.total).toBe(2);
    expect(rep.passed).toBe(1);
    expect(rep.ok).toBe(false);
    const bad = rep.rows.find((r) => r.name === 'b-坏的')!;
    expect(bad.ok).toBe(false);
    expect(bad.failedAt).toBe(2);
    expect(bad.error).toMatch(/not found/);
    expect(rep.rows.find((r) => r.name === 'a-好的')!.ok).toBe(true);
  });

  it('names 只跑点名的那几条', async () => {
    saveRecipe({ name: 'x1', description: '', createdAt: 'x', updatedAt: 'x', steps: [{ action: 'click', args: { selector: '.ok' } }] });
    saveRecipe({ name: 'x2', description: '', createdAt: 'x', updatedAt: 'x', steps: [{ action: 'click', args: { selector: '.ok' } }] });
    const rep = await replayAll(baseTools([tool('browser_click', () => OK)]), { names: ['x2'] });
    expect(rep.rows.map((r) => r.name)).toEqual(['x2']);
  });
});
