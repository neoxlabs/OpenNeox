import { describe, it, expect } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

const mk = (name: string): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async function() { return 'ok'; },
});

const ALWAYS = new Set(['search', 'readfile']);
const DEFERRED_NAMES = Array.from({ length: 30 }, (_, i) => `deferred_${i}`);
/* 必须归到 category 里才算真 deferred —— 未分类的工具 buildLiveTools 会当安全网直接注册 */
const build = () => {
  const tools = [mk('search'), mk('readfile'), ...DEFERRED_NAMES.map(mk)];
  return new ToolTreeEngine(tools, {
    alwaysActive: ALWAYS,
    categories: [{ id: 'mockpack', label: 'Mock', description: 'mock pack', toolNames: DEFERRED_NAMES }],
  });
};

describe('团队包按需 + 整包解锁', () => {
  const TEAM = ['team_run', 'team_decompose', 'team_prune', 'team_roster', 'team_member_review', 'team_claim', 'team_meeting', 'team_execute'];
  const buildWithTeam = () => new ToolTreeEngine([mk('search'), mk('readfile'), ...TEAM.map(mk)], { alwaysActive: ALWAYS });

  it('默认不常驻', () => {
    const live = buildWithTeam().liveTools.map((t) => t.name);
    for (const n of TEAM) expect(live).not.toContain(n);
  });

  it('直调 team_run 点名解锁 → 同包 8 个一起进来', () => {
    const e = buildWithTeam();
    const added = e.promote(['team_run']);
    expect(added[0]).toBe('team_run');
    expect(new Set(added)).toEqual(new Set(TEAM));
    const live = e.liveTools.map((t) => t.name);
    for (const n of TEAM) expect(live).toContain(n);
  });
});

describe('ToolTreeEngine.promote', () => {
  it('promote 后工具进 liveTools, 且仍是同一个数组引用', () => {
    const e = build();
    const ref = e.liveTools;                       // runner 持有的引用
    const before = e.liveTools.map((t) => t.name);
    expect(before).not.toContain('deferred_3');

    const added = e.promote(['deferred_3']);
    expect(added).toEqual(['deferred_3']);
    expect(e.liveTools).toBe(ref);                 // 必须原地重建, 不能换数组
    expect(e.liveTools.map((t) => t.name)).toContain('deferred_3');
  });

  it('常驻工具不重复解锁, 不存在的工具忽略', () => {
    const e = build();
    expect(e.promote(['search'])).toEqual([]);
    expect(e.promote(['nope_not_a_tool'])).toEqual([]);
    expect(e.getUnlockedTools()).toEqual([]);
  });

  it('重复 promote 幂等', () => {
    const e = build();
    expect(e.promote(['deferred_1'])).toEqual(['deferred_1']);
    expect(e.promote(['deferred_1'])).toEqual([]);
    const count = e.liveTools.filter((t) => t.name === 'deferred_1').length;
    expect(count).toBe(1);
  });

  it('顺序稳定: 先解锁的仍在前面 (前缀缓存友好)', () => {
    const e = build();
    e.promote(['deferred_5']);
    const afterFirst = e.liveTools.map((t) => t.name);
    e.promote(['deferred_9']);
    const afterSecond = e.liveTools.map((t) => t.name);
    /* 第一批的相对顺序不能被打乱 —— 只允许在中间追加 */
    const idx5a = afterFirst.indexOf('deferred_5');
    const idx5b = afterSecond.indexOf('deferred_5');
    expect(idx5b).toBe(idx5a);
    expect(afterSecond.indexOf('deferred_9')).toBeGreaterThan(idx5b);
  });

  it('元工具永远在末尾 (tool_search / call_tool)', () => {
    const e = build();
    e.promote(['deferred_2', 'deferred_4']);
    const names = e.liveTools.map((t) => t.name);
    expect(names.slice(-2)).toEqual(['tool_search', 'call_tool']);
  });

  it('decorateTool 作用于 promote 进来的工具 (session ALS 包装不能漏)', () => {
    const seen: string[] = [];
    const e = new ToolTreeEngine([mk('search'), ...DEFERRED_NAMES.map(mk)], {
      alwaysActive: ALWAYS,
      categories: [{ id: 'mockpack', label: 'Mock', description: 'mock', toolNames: DEFERRED_NAMES }],
      decorateTool: (t) => { seen.push(t.name); return { ...t, description: t.description + ' [wrapped]' }; },
    });
    e.promote(['deferred_7']);
    const got = e.liveTools.find((t) => t.name === 'deferred_7');
    expect(seen).toContain('deferred_7');
    expect(got?.description).toContain('[wrapped]');
  });

  it('解锁上限生效 — 不许把全部工具推进常驻面', () => {
    const e = build();
    const all = Array.from({ length: 30 }, (_, i) => `deferred_${i}`);
    e.promote(all);
    expect(e.getUnlockedTools().length).toBeLessThanOrEqual(15);
    /* 到顶后继续 promote 不再增长 */
    const n = e.getUnlockedTools().length;
    e.promote(['deferred_29']);
    expect(e.getUnlockedTools().length).toBe(n);
  });
});
