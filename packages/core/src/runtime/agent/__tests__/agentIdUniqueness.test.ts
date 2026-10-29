/** agentId 同时作为子会话 sessionId，生成时必须避开内存和持久化会话中的已有标识。 */
import { describe, it, expect } from 'vitest';
import { BackgroundAgentManager } from '../backgroundAgent.js';

const reg = (mgr: BackgroundAgentManager, id: string, session = 'parent-1') =>
  mgr.register(id, `任务 ${id}`, 'prompt', session, undefined, { synchronous: true });

describe('BackgroundAgentManager.register — agentId 唯一性', () => {
  it('没有历史占用时保持原样, 不加无谓后缀', () => {
    const mgr = new BackgroundAgentManager();
    expect(reg(mgr, 'Agent-1').agentId).toBe('Agent-1');
    expect(reg(mgr, 'Agent-2').agentId).toBe('Agent-2');
  });

  it('内存里已有同 id (并发同名 spawn) → 顺延后缀, 两个 task 都活着', () => {
    const mgr = new BackgroundAgentManager();
    const a = reg(mgr, 'Agent-1');
    const b = reg(mgr, 'Agent-1');
    expect(a.agentId).toBe('Agent-1');
    expect(b.agentId).toBe('Agent-1#2');
    /* 关键: 前一个没被覆盖掉 (否则它的 abortController 丢了会变僵尸) */
    expect(mgr.resolveAgent('Agent-1')?.agentId).toBe('Agent-1');
    expect(mgr.resolveAgent('Agent-1#2')?.agentId).toBe('Agent-1#2');
  });

  it('内存里没有但**已落库**的 id 也算被占用 — 跨轮次不再复用子会话', () => {
    /* 模拟: Agent-1 / Agent-2 是上一轮跑完、已经被 sweep 出内存的子会话 */
    const persisted = new Set(['Agent-1', 'Agent-2']);
    const mgr = new BackgroundAgentManager({
      isAgentIdTaken: (id) => persisted.has(id),
    });
    const t = reg(mgr, 'Agent-1');
    expect(t.agentId).not.toBe('Agent-1');
    expect(t.agentId).toBe('Agent-1#2');
  });

  it('顺延时会跳过所有已占用的候选 (内存 + 历史混合)', () => {
    const persisted = new Set(['Agent-1', 'Agent-1#2']);
    const mgr = new BackgroundAgentManager({
      isAgentIdTaken: (id) => persisted.has(id),
    });
    /* 带后缀的第三个候选标识是第一个未占用的标识。 */
    expect(reg(mgr, 'Agent-1').agentId).toBe('Agent-1#3');
  });

  it('两个不同父会话各自从 Agent-1 起编号也不会撞到同一个 id', () => {
    const persisted = new Set<string>();
    const mgr = new BackgroundAgentManager({
      isAgentIdTaken: (id) => persisted.has(id),
    });
    /* 会话 A 派了 Agent-1, 跑完落库 (从内存清掉, 但历史里留着) */
    const a = reg(mgr, 'Agent-1', 'parent-A');
    persisted.add(a.agentId);
    mgr.complete(a.agentId, 'done');
    mgr.clearCompleted();

    /* 会话 B 的计数器也从 1 开始 */
    const b = reg(mgr, 'Agent-1', 'parent-B');
    expect(b.agentId).not.toBe(a.agentId);
  });

  it('isAgentIdTaken 抛异常时降级为只查内存, 不能把派活整个挡掉', () => {
    const mgr = new BackgroundAgentManager({
      isAgentIdTaken: () => {
        throw new Error('db not ready');
      },
    });
    expect(() => reg(mgr, 'Agent-1')).not.toThrow();
    expect(reg(mgr, 'Agent-9').agentId).toBe('Agent-9');
  });

  it('不传 isAgentIdTaken 时行为与旧版一致 (纯内存判定)', () => {
    const mgr = new BackgroundAgentManager();
    expect(reg(mgr, 'Agent-7').agentId).toBe('Agent-7');
    expect(reg(mgr, 'Agent-7').agentId).toBe('Agent-7#2');
  });
});
