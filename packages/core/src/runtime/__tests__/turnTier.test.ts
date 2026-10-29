/**
 * 每轮带多少 (聊天 / 轻档 / 满档) —— 判据见 turnTier.ts 文件头。
 * 锁的是两条: 拿不准就满档 (跟没有这个功能时一样); 会话进过满档就不再降回去。
 */
import { describe, expect, it } from 'vitest';
import { decideTurnTier, createStartTaskTool, type TurnTierInput } from '../turnTier.js';
import { ToolTreeEngine } from '../../tools/toolTreeEngine.js';

const base: TurnTierInput = {
  chatMode: false, noToolsIntent: false, isRecovery: false, agentMode: 'code',
  latchedAgent: false, wasLite: false, hasToolHistory: false, chatOnly: null,
};
const tier = (over: Partial<TurnTierInput>) => decideTurnTier({ ...base, ...over });

describe('decideTurnTier', () => {
  it('聊天模式永远是 chat', () => {
    expect(tier({ chatMode: true, latchedAgent: true, hasToolHistory: true })).toBe('chat');
  });
  it('没开 Jev / 预判没赶上 (chatOnly=null) → 满档, 跟现在一样', () => {
    expect(tier({})).toBe('agent');
  });
  it('Jev 高把握纯聊天 → 轻档; 门槛以下 → 满档', () => {
    expect(tier({ chatOnly: 0.97 })).toBe('lite');
    expect(tier({ chatOnly: 0.82 })).toBe('agent');
  });
  it('会话进过满档 / 历史里调过工具 → 一直满档, 寒暄也不降', () => {
    expect(tier({ chatOnly: 0.99, latchedAgent: true })).toBe('agent');
    expect(tier({ chatOnly: 0.99, hasToolHistory: true })).toBe('agent');
  });
  it('轻档里短句没判出来 → 留在轻档; 重试沿用当前档', () => {
    expect(tier({ wasLite: true, chatOnly: null })).toBe('lite');
    expect(tier({ wasLite: true, isRecovery: true, chatOnly: 0.1 })).toBe('lite');
    expect(tier({ isRecovery: true, chatOnly: 0.99 })).toBe('agent');
  });
  it('只给 Code / Work; 「不要工具」照旧满档 prompt', () => {
    expect(tier({ agentMode: 'assistant', chatOnly: 0.99 })).toBe('agent');
    expect(tier({ agentMode: 'work', chatOnly: 0.99 })).toBe('lite');
    expect(tier({ noToolsIntent: true, chatOnly: 0.99 })).toBe('agent');
  });
});

describe('ToolTreeEngine 轻档', () => {
  const t = (name: string) => ({
    name, description: name, parameters: { type: 'object' as const, properties: {} }, function: async () => 'ok',
  });
  const tools = [t('readfile'), t('edit'), t('execute_shell')];

  it('轻档只有 start_task; 调用后原地换满档 (同一个数组), onEscalate 只触发一次', async () => {
    let escalations = 0;
    let engine!: ToolTreeEngine;
    engine = new ToolTreeEngine(tools, {
      liteTool: createStartTaskTool(() => { engine.escalate(); return engine.liveTools.map((x) => x.name); }),
      onEscalate: () => { escalations++; },
    });
    const live = engine.liveTools;
    expect(live.map((x) => x.name)).toEqual(['start_task']);
    const out = await live[0].function({});
    expect(engine.isLite).toBe(false);
    expect(engine.liveTools).toBe(live);
    expect(live.map((x) => x.name)).toEqual(expect.arrayContaining(['readfile', 'edit', 'execute_shell', 'tool_search']));
    expect(String(out)).toContain('readfile');
    expect(engine.escalate()).toBe(false);
    expect(escalations).toBe(1);
  });

  it('轻档里点名一个工具 (promote) 也会先升满档', () => {
    let escalated = false;
    const engine = new ToolTreeEngine(tools, { liteTool: t('start_task'), onEscalate: () => { escalated = true; } });
    engine.promote(['readfile']);
    expect(escalated).toBe(true);
    expect(engine.liveTools.some((x) => x.name === 'readfile')).toBe(true);
  });

  it('写进调用方的数组: 第二轮的新树改的就是 runner 手里那个 (host 跨轮复用)', () => {
    const shared: any[] = [];
    const turn1 = new ToolTreeEngine(tools, { liteTool: t('start_task'), liveTarget: shared });
    expect(turn1.liveTools).toBe(shared);
    expect(shared.map((x) => x.name)).toEqual(['start_task']);
    const turn2 = new ToolTreeEngine(tools, { liveTarget: shared });
    expect(turn2.liveTools).toBe(shared);
    expect(shared.map((x) => x.name)).toContain('readfile');
    expect(shared.some((x) => x.name === 'start_task')).toBe(false);
  });

  it('重建数组时常驻工具也过 decorateTool (原来 promote 一次, 常驻工具的闸就掉了)', () => {
    const seen = new Set<string>();
    const engine = new ToolTreeEngine(tools, { decorateTool: (x) => { seen.add(x.name); return x; } });
    seen.clear();
    engine.promote(['nothing_registered']);
    (engine as any).buildLiveTools();
    expect([...seen]).toEqual(expect.arrayContaining(['readfile', 'edit', 'execute_shell', 'call_tool']));
  });

  it('不给 liteTool 时行为不变', () => {
    const engine = new ToolTreeEngine(tools);
    expect(engine.isLite).toBe(false);
    expect(engine.liveTools.some((x) => x.name === 'start_task')).toBe(false);
  });
});
