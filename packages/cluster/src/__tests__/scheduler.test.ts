import { describe, expect, it } from 'vitest';
import { computeReadySet, validateGraph, findCycle, topoLayers } from '../scheduler/readySet.js';
import { ClusterBudgetTracker } from '../scheduler/budget.js';
import type { NodeSpec, NodeStatus } from '../types.js';

/**
 * 调度器正确性 —— 这一层必须是确定性的, 所以能被完整测掉。
 *
 * 断言覆盖依赖、失败传播和状态转换等调度边界。
 */

const n = (id: string, dependsOn?: string[], extra?: Partial<NodeSpec>): NodeSpec =>
  ({ id, prompt: `do ${id}`, dependsOn, ...extra });

const st = (m: Record<string, NodeStatus>) => new Map(Object.entries(m));

describe('就绪集 — 依赖显式化', () => {
  it('无依赖节点一开始就就绪', () => {
    const nodes = [n('a'), n('b')];
    const { ready } = computeReadySet({ nodes, status: st({}) });
    expect(ready.map((x) => x.id)).toEqual(['a', 'b']);
  });

  /* 只看被依赖的那个节点 c —— b 自己没依赖, 任何时候都在就绪集里, 跟本条无关 */
  it('all_of: 前驱全 done 才就绪', () => {
    const nodes = [n('a'), n('b'), n('c', ['a', 'b'])];
    const readyIds = (s: Record<string, NodeStatus>) =>
      computeReadySet({ nodes, status: st(s) }).ready.map((x) => x.id);
    expect(readyIds({ a: 'done' }), 'b 未完成时 c 不该就绪').not.toContain('c');
    expect(readyIds({ a: 'done', b: 'done' }), '前驱全完成后 c 就绪').toContain('c');
  });

  it('any_of: 任一前驱 done 即就绪', () => {
    const nodes = [n('a'), n('b'), n('c', ['a', 'b'], { join: 'any_of' })];
    expect(computeReadySet({ nodes, status: st({ a: 'done' }) }).ready.map((x) => x.id)).toContain('c');
  });

  it('all_of: 前驱失败 → 后继 skip, 不是永远挂着', () => {
    const nodes = [n('a'), n('b', ['a'])];
    const { ready, skip } = computeReadySet({ nodes, status: st({ a: 'failed' }) });
    expect(ready).toEqual([]);
    expect(skip).toEqual(['b']);
  });

  it('any_of: 前驱全失败才 skip, 有一个没跑完就继续等', () => {
    const nodes = [n('a'), n('b'), n('c', ['a', 'b'], { join: 'any_of' })];
    expect(computeReadySet({ nodes, status: st({ a: 'failed' }) }).skip).toEqual([]);
    expect(computeReadySet({ nodes, status: st({ a: 'failed', b: 'failed' }) }).skip).toEqual(['c']);
  });

  it('已在跑/已完成的节点不会被重复放进就绪集', () => {
    const nodes = [n('a')];
    for (const s of ['running', 'done', 'failed', 'skipped'] as NodeStatus[]) {
      expect(computeReadySet({ nodes, status: st({ a: s }) }).ready).toEqual([]);
    }
  });
});

describe('图校验 — 跑之前就拦下不合法的图', () => {
  it('放行合法图', () => {
    expect(validateGraph([n('a'), n('b', ['a'])])).toEqual([]);
  });

  it('拦: 依赖不存在的节点', () => {
    expect(validateGraph([n('a', ['ghost'])]).join()).toMatch(/不存在的节点 ghost/);
  });

  it('拦: 依赖自己', () => {
    expect(validateGraph([n('a', ['a'])]).join()).toMatch(/依赖自己|成环/);
  });

  it('拦: id 重复', () => {
    expect(validateGraph([n('a'), n('a')]).join()).toMatch(/id 重复/);
  });

  it('拦: 成环', () => {
    const p = validateGraph([n('a', ['c']), n('b', ['a']), n('c', ['b'])]);
    expect(p.join()).toMatch(/成环/);
  });

  it('findCycle 能报出环路成员', () => {
    const c = findCycle([n('a', ['b']), n('b', ['a'])]);
    expect(c).not.toBeNull();
    expect(c!.length).toBeGreaterThanOrEqual(2);
  });

  /* 写节点的领地必须互斥，才能让合并归属保持确定。 */
  it('拦: 写节点领地重叠 (含父子路径)', () => {
    expect(validateGraph([
      n('a', undefined, { ownedPaths: ['src/auth'] }),
      n('b', undefined, { ownedPaths: ['src/auth'] }),
    ]).join()).toMatch(/领地重叠/);

    expect(validateGraph([
      n('a', undefined, { ownedPaths: ['src'] }),
      n('b', undefined, { ownedPaths: ['src/auth'] }),
    ]).join()).toMatch(/领地重叠/);
  });

  it('放行: 领地不重叠', () => {
    expect(validateGraph([
      n('a', undefined, { ownedPaths: ['src/auth'] }),
      n('b', undefined, { ownedPaths: ['src/org'] }),
    ])).toEqual([]);
  });
});

describe('拓扑分层', () => {
  it('按最长距离分层', () => {
    /* a → b → d, a → c → d : d 应该在第 2 层 (最长路), 不是第 1 层 */
    const layers = topoLayers([n('a'), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c'])]);
    expect(layers[0]).toEqual(['a']);
    expect(layers[1].sort()).toEqual(['b', 'c']);
    expect(layers[2]).toEqual(['d']);
  });
});

describe('全局并发预算 — 跨层收口', () => {
  it('到上限就不再放行, 释放后恢复', () => {
    const b = new ClusterBudgetTracker({ maxConcurrent: 2 });
    expect(b.tryAcquire('n1')).toBe(true);
    expect(b.tryAcquire('n2')).toBe(true);
    expect(b.tryAcquire('n3')).toBe(false);
    expect(b.free).toBe(0);
    b.release('n1');
    expect(b.tryAcquire('n3')).toBe(true);
  });

  /* 集群化最容易失控的地方: 节点是完整 neox, 会自己再派子 agent。
   * 子 agent 必须占同一个全局池, 否则 3 节点 × 3 子agent = 12 并发。 */
  it('子 agent 与节点共用同一个全局池', () => {
    const b = new ClusterBudgetTracker({ maxConcurrent: 3 });
    expect(b.tryAcquire('node-a')).toBe(true);
    expect(b.tryAcquire('node-a/sub-1')).toBe(true);
    expect(b.tryAcquire('node-a/sub-2')).toBe(true);
    expect(b.tryAcquire('node-b'), '子 agent 已占满, 第二个节点必须等位').toBe(false);
  });

  it('重复 acquire 同一个 holder 是幂等的, 不会多占额度', () => {
    const b = new ClusterBudgetTracker({ maxConcurrent: 1 });
    expect(b.tryAcquire('x')).toBe(true);
    expect(b.tryAcquire('x')).toBe(true);
    expect(b.used).toBe(1);
  });

  it('token 熔断', () => {
    const b = new ClusterBudgetTracker({ maxConcurrent: 4, maxOutputTokens: 100 });
    b.addOutputTokens(99);
    expect(b.exhausted().stop).toBe(false);
    b.addOutputTokens(2);
    expect(b.exhausted().stop).toBe(true);
    expect(b.exhausted().reason).toMatch(/token 熔断/);
  });

  /* 与 core 侧 长任务预算同口径: 不设时长闸, 大任务跑很久是常态 */
  it('默认不设墙钟上限 — 长任务不该被时长判死', () => {
    const b = new ClusterBudgetTracker({ maxConcurrent: 4 });
    expect(b.exhausted().stop).toBe(false);
  });
});
