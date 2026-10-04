import { describe, it, expect } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

const mkTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  function: async () => 'ok',
} as unknown as Tool);

describe('deferred 工具直调解锁', () => {
  it('注册过但没进常驻的工具 → promote 得到, 之后出现在 liveTools 里', () => {
    const engine = new ToolTreeEngine([mkTool('readfile'), mkTool('browser_eval')]);
    const liveBefore = engine.liveTools.map(t => t.name);
    /* browser_eval 不在常驻里 —— 这正是模型直调会撞墙的那一类 */
    expect(liveBefore).not.toContain('browser_eval');

    const added = engine.promote(['browser_eval']);
    expect(added).toEqual(['browser_eval']);
    expect(engine.liveTools.map(t => t.name)).toContain('browser_eval');
  });

  it('没注册过的名字解锁不了 —— "不存在"仍然是"不能调"', () => {
    const engine = new ToolTreeEngine([mkTool('readfile')]);
    expect(engine.promote(['execute_sql'])).toEqual([]);
    expect(engine.liveTools.map(t => t.name)).not.toContain('execute_sql');
  });

  it('重复解锁同一个工具不会重复计数 (runner 每轮都会调, 必须幂等)', () => {
    const engine = new ToolTreeEngine([mkTool('readfile'), mkTool('browser_eval')]);
    expect(engine.promote(['browser_eval'])).toEqual(['browser_eval']);
    expect(engine.promote(['browser_eval'])).toEqual([]);
  });

  it('liveTools 是**同一个数组引用** —— runner 持着它, 换新数组解锁就静默失效', () => {
    const engine = new ToolTreeEngine([mkTool('readfile'), mkTool('browser_eval')]);
    const ref = engine.liveTools;
    engine.promote(['browser_eval']);
    expect(engine.liveTools).toBe(ref);
    expect(ref.map(t => t.name)).toContain('browser_eval');
  });


  /* 真正 deferred 的工具必须归在某个 category 里 —— 否则会被 buildLiveTools 的
   * "未分类安全网"分支直接放进 liveTools, 压根不走解锁这条路。 */
  const deferredEngine = (names: string[]) => new ToolTreeEngine(
    [mkTool('readfile'), ...names.map(mkTool)],
    {
      alwaysActive: new Set(['readfile']),
      categories: [{ name: 'browser', description: 'browser tools', toolNames: names } as any],
    },
  );

  it('超过上限的第 N 个工具照样解锁得到 —— 存在就一定调得到', () => {
    const names = Array.from({ length: 40 }, (_, i) => `browser_t${i}`);
    const engine = deferredEngine(names);
    for (const n of names) {
      expect(engine.liveTools.map(t => t.name)).not.toContain(n);  // 先确认它真是 deferred
      expect(engine.promote([n])).toEqual([n]);                    // 一个都不许被拒
      expect(engine.liveTools.map(t => t.name)).toContain(n);
    }
    /* 预算仍然守住: 不会把 40 个全推进常驻面 */
    expect(engine.getUnlockedTools().length).toBeLessThanOrEqual(15);
  });

  it('淘汰的是最久没用的那个, 不是正在高频用的那个', async () => {
    const names = [...Array.from({ length: 15 }, (_, i) => `t${i}`), 'late'];
    const engine = deferredEngine(names);
    engine.promote(names.slice(0, 15));
    expect(engine.getUnlockedTools()).toHaveLength(15);

    /* t0 是最早解锁的, 但现在用它一次 → 它就不该是被淘汰的那个 */
    const t0 = engine.liveTools.find(t => t.name === 't0')!;
    await t0.function({}, {} as any);

    engine.promote(['late']);
    const unlocked = engine.getUnlockedTools();
    expect(unlocked).toContain('t0');      // 刚用过, 留下
    expect(unlocked).toContain('late');    // 新点名的, 进来
    expect(unlocked).not.toContain('t1');  // 最久没用的, 被淘汰
  });

  it('被淘汰的工具再点名 → 自动解锁回来 (不是永久失效)', () => {
    const names = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const engine = deferredEngine(names);
    for (const n of names) engine.promote([n]);
    expect(engine.getUnlockedTools()).not.toContain('t0');   // 已被挤掉
    expect(engine.promote(['t0'])).toEqual(['t0']);          // 再点名, 回来
    expect(engine.liveTools.map(t => t.name)).toContain('t0');
  });

  it('Win 能力报告点名的那三个 deferred 工具都能直调解锁', () => {
    const engine = new ToolTreeEngine([
      mkTool('search'),
      mkTool('execute_javascript'),
      mkTool('service_scan'),
    ]);
    expect(engine.promote(['execute_javascript'])).toEqual(['execute_javascript']);
    expect(engine.promote(['service_scan'])).toEqual(['service_scan']);
    const live = engine.liveTools.map(t => t.name);
    expect(live).toContain('execute_javascript');
    expect(live).toContain('service_scan');
  });

  it('没注册过的名字仍然解锁不了 —— "不存在"必须还是"不能调"', () => {
    const engine = new ToolTreeEngine([mkTool('readfile')]);
    expect(engine.promote(['execute_sql'])).toEqual([]);
    expect(engine.liveTools.map(t => t.name)).not.toContain('execute_sql');
  });
});
