/**
 * 就绪集计算 —— 调度器的核心, 纯函数, 无 LLM 参与。
 *
 * 就绪集**只由声明的依赖决定**, 不依赖模型推理。谁能运行以及何时运行都可计算。
 */

import type { NodeSpec, NodeStatus } from '../types.js';

export interface ReadySetInput {
  nodes: NodeSpec[];
  status: Map<string, NodeStatus>;
}

/** 环检测 —— 返回一条环路 (首尾同节点), 无环返回 null */
export function findCycle(nodes: NodeSpec[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>();   // 0 未访问 1 在栈 2 完成
  const stack: string[] = [];
  let found: string[] | null = null;

  const dfs = (id: string): boolean => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;                 // 未知依赖单独校验, 这里跳过
      if (state.get(dep) === 1) {
        found = [...stack.slice(stack.indexOf(dep)), dep];
        return true;
      }
      if (!state.get(dep) && dfs(dep)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const n of nodes) if (!state.get(n.id) && dfs(n.id)) return found;
  return null;
}

/** 结构校验 —— 图不合法就别开跑, 跑到一半才发现更贵 */
export function validateGraph(nodes: NodeSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id || !n.id.trim()) problems.push('存在没有 id 的节点');
    else if (ids.has(n.id)) problems.push(`节点 id 重复: ${n.id}`);
    else ids.add(n.id);
    if (!n.prompt || !n.prompt.trim()) problems.push(`节点 ${n.id} 没有任务描述`);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) {
      if (!ids.has(d)) problems.push(`节点 ${n.id} 依赖了不存在的节点 ${d}`);
      if (d === n.id) problems.push(`节点 ${n.id} 依赖自己`);
    }
  }
  const cyc = findCycle(nodes);
  if (cyc) problems.push(`依赖成环: ${cyc.join(' -> ')}`);

  /* 写节点之间的领地不能重叠，否则合并时无法确定文件归属。 */
  const writers = nodes.filter((n) => (n.ownedPaths?.length ?? 0) > 0);
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i], b = writers[j];
      for (const pa of a.ownedPaths!) {
        for (const pb of b.ownedPaths!) {
          if (pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) {
            problems.push(`节点 ${a.id} 与 ${b.id} 领地重叠: ${pa} ↔ ${pb}`);
          }
        }
      }
    }
  }
  return problems;
}

/**
 * 算当前就绪集。
 *   all_of (默认) — 全部前驱 done
 *   any_of — 任一前驱 done
 * 前驱 failed 时: all_of 的后继标 skipped (跑不了), any_of 只要还有别的前驱可能成就继续等。
 */
export function computeReadySet({ nodes, status }: ReadySetInput): {
  ready: NodeSpec[];
  skip: string[];
} {
  const ready: NodeSpec[] = [];
  const skip: string[] = [];

  for (const n of nodes) {
    if ((status.get(n.id) ?? 'pending') !== 'pending') continue;
    const deps = n.dependsOn ?? [];
    if (deps.length === 0) { ready.push(n); continue; }

    const states = deps.map((d) => status.get(d) ?? 'pending');
    const done = states.filter((s) => s === 'done').length;
    const failed = states.filter((s) => s === 'failed' || s === 'skipped').length;

    if ((n.join ?? 'all_of') === 'any_of') {
      if (done > 0) ready.push(n);
      else if (failed === deps.length) skip.push(n.id);      // 全挂了, 没指望
    } else {
      if (failed > 0) skip.push(n.id);                        // all_of 缺一不可
      else if (done === deps.length) ready.push(n);
    }
  }
  return { ready, skip };
}

/** 拓扑层 —— 仅用于展示/预估, 真实调度按就绪集动态取 */
export function topoLayers(nodes: NodeSpec[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;                               // 环, 由 validateGraph 报
    seen.add(id);
    const deps = byId.get(id)?.dependsOn ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => visit(x, seen) + 1));
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) visit(n.id, new Set());
  const max = Math.max(0, ...depth.values());
  const layers: string[][] = Array.from({ length: max + 1 }, () => []);
  for (const n of nodes) layers[depth.get(n.id) ?? 0].push(n.id);
  return layers;
}
