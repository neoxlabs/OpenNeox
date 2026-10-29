/**
 * Verify repeat handling for dynamic list pages.
 *
 * ─── 它解决的是结构性问题, 不是省几步 ──────────────────────────────────────
 * browser_run 的脚本是**静态**步骤列表, 而列表页是**动态**的: 关掉一条整张表就重绘,
 * 后面写好的步骤连同 ref 全部失效。所以模型只能一条一条做, 每条一次完整往返 ——
 * 基准里 urgent-page2 四轮都卡在 230 秒。而手写下限用「关第一条、重复、直到列表空」
 * 这个模式 698ms 跑完。差的不是聪明程度, 是**表达能力**。
 *
 * The tests pin loop bounds, dynamic ref refresh, and empty-result termination.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neox/kernel';
import { runBrowserScript } from '../browserRun.js';

/** 假工具集: browser_query 报还剩几个, 其余动作按脚本安排成功/失败 */
function makeTools(opts: {
  counts: number[];                    /* 每次 query 依次返回的剩余数 */
  onAct?: () => unknown;               /* 动作的返回值 */
}): { tools: Map<string, Tool>; acts: () => number } {
  let qi = 0; let acted = 0;
  const t = (name: string, fn: () => unknown): [string, Tool] =>
    [name, { name, function: async () => JSON.stringify(fn()) } as unknown as Tool];
  return {
    acts: () => acted,
    tools: new Map<string, Tool>([
      t('browser_query', () => ({ ok: true, count: opts.counts[Math.min(qi++, opts.counts.length - 1)] })),
      t('browser_click', () => { acted++; return opts.onAct ? opts.onAct() : { ok: true }; }),
      t('browser_get_text', () => { acted++; return { ok: true, text: 'x' }; }),
      t('browser_get_state', () => ({ ok: true, url: 'http://x/', title: 'x' })),
      t('browser_eval', () => ({ ok: true, result: {} })),
    ]),
  };
}

const repeatStep = (extra: Record<string, unknown> = {}) => ({
  action: 'repeat' as const,
  untilGone: '#tbl tbody tr',
  do: [{ action: 'click' as const, args: { selector: '#tbl tbody tr:first-child .close' } }],
  ...extra,
});

describe('正常收敛', () => {
  it('一轮一轮做, 目标清零就停', async () => {
    const { tools, acts } = makeTools({ counts: [3, 2, 1, 0] });
    const r = await runBrowserScript({ steps: [repeatStep()] }, tools);
    expect(r.ok).toBe(true);
    expect(acts()).toBe(3);                       /* 做了 3 轮, 不多不少 */
    expect(r.steps[0]!.output).toContain('一个不剩');
  });

  it('目标一开始就是 0 —— 一步都不做', async () => {
    const { tools, acts } = makeTools({ counts: [0] });
    const r = await runBrowserScript({ steps: [repeatStep()] }, tools);
    expect(r.ok).toBe(true);
    expect(acts()).toBe(0);
    expect(r.steps[0]!.output).toContain('一开始就是 0');
  });
});

describe('三条护栏', () => {
  it('**一轮下来目标没少就停** —— 否则会把同一个无效操作重复 20 次', async () => {
    /* 这是最容易写出来的死循环: do 里那几步压根没改变页面 */
    const { tools, acts } = makeTools({ counts: [10, 10] });
    const r = await runBrowserScript({ steps: [repeatStep()] }, tools);
    expect(r.ok).toBe(false);
    expect(acts()).toBe(1);                       /* 只做了一轮就发现不对 */
    expect(r.steps[0]!.error).toContain('一个都没少');
    /* 报错要能指导下一步, 不能只说"失败了" */
    expect(r.steps[0]!.error).toContain('看一眼');
  });

  it('maxRounds 封顶 —— 到顶不算失败, 但要说清楚还剩多少', async () => {
    const { tools, acts } = makeTools({ counts: [9, 8, 7, 6, 5] });
    const r = await runBrowserScript({ steps: [repeatStep({ maxRounds: 3 })] }, tools);
    expect(r.ok).toBe(true);
    expect(acts()).toBe(3);
    expect(r.steps[0]!.output).toContain('还剩');
  });

  it('一轮里任何一步失败就停 —— 半路出错继续点是在乱点', async () => {
    const { tools, acts } = makeTools({
      counts: [5, 4, 3],
      onAct: () => ({ ok: false, error: '这个按钮点不动' }),
    });
    const r = await runBrowserScript({ steps: [repeatStep()] }, tools);
    expect(r.ok).toBe(false);
    expect(acts()).toBe(1);
    expect(r.steps[0]!.error).toContain('这个按钮点不动');
  });
});

describe('参数不全时说人话', () => {
  it('缺 do', async () => {
    const { tools } = makeTools({ counts: [1] });
    const r = await runBrowserScript({ steps: [{ action: 'repeat', untilGone: '#a' } as never] }, tools);
    expect(r.steps[0]!.error).toContain('do');
  });

  it('缺 untilGone', async () => {
    const { tools } = makeTools({ counts: [1] });
    const r = await runBrowserScript({
      steps: [{ action: 'repeat', do: [{ action: 'click', args: {} }] } as never],
    }, tools);
    expect(r.steps[0]!.error).toContain('untilGone');
  });

  it('do 里写了不存在的动作 —— 指出是第几步, 别让人自己数', async () => {
    const { tools } = makeTools({ counts: [2, 1, 0] });
    const r = await runBrowserScript({
      steps: [{ action: 'repeat', untilGone: '#a', do: [{ action: 'teleport', args: {} }] } as never],
    }, tools);
    expect(r.steps[0]!.error).toContain('第 1 步');
    expect(r.steps[0]!.error).toContain('teleport');
  });
});
