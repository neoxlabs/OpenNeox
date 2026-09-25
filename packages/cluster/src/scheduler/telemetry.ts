/**
 * 集群埋点 —— 每个指标都对应一个具体决策, 不是"埋得越多越好"。
 *
 * 【设计原则】节点状态是**观测出来的**, 不是**汇报出来的**。
 *   调度器直接从 runtime 事件流观测状态，不要求节点额外汇报，也不打断节点执行。
 */

import type { NodeStatus } from '../types.js';

/** 单节点的观测数据 —— 全部从事件流推出, 节点不需要主动说 */
export interface NodeTelemetry {
  id: string;
  status: NodeStatus;
  startedAt?: number;
  finishedAt?: number;
  /** 最近一次工具调用 —— "它在干什么"的答案 */
  lastTool?: string;
  lastToolAt?: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** 改动的文件 (路径 → 写入次数) —— "它在碰哪块"的答案 */
  changedFiles: Map<string, number>;
  /** 最近一次活动时间 —— 静默判定只看进度，不看总运行时长 */
  lastActivityAt: number;
}

export function emptyTelemetry(id: string): NodeTelemetry {
  return {
    id, status: 'pending', turns: 0, inputTokens: 0, outputTokens: 0,
    toolCalls: 0, changedFiles: new Map(), lastActivityAt: Date.now(),
  };
}

/** 节点主动上报 —— 只有这三类, 固定 schema, 不接受自由文本 */
export type NodeReport =
  /** 遇到需要跨节点决策的事, 自己解不了 */
  | { kind: 'blocker'; nodeId: string; summary: string; needs?: string[] }
  /** 发现领地划错了 (要碰不属于自己的路径) */
  | { kind: 'scope_conflict'; nodeId: string; path: string; reason: string }
  /** 完成时的结构化产出 */
  | { kind: 'artifacts'; nodeId: string; data: Record<string, unknown> };

/** 掉队者判定结果 */
export interface StragglerAlert {
  nodeId: string;
  elapsedMs: number;
  /** 同批节点的中位耗时 */
  medianMs: number;
  /** 偏离倍数 */
  ratio: number;
}

/** 静默告警 —— 判死按进展不按时长 (与 core 侧 长任务预算同口径) */
export interface SilenceAlert {
  nodeId: string;
  silentMs: number;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface ClusterSnapshot {
  nodes: NodeTelemetry[];
  /** 并发利用率 —— 集群化后并发是乘起来的 (3 节点 × 3 子agent = 12), 必须盯 */
  concurrency: { used: number; max: number };
  totalInputTokens: number;
  totalOutputTokens: number;
  elapsedMs: number;
  /** 掉队者 —— 墙钟 = max(节点), 它决定一切 */
  stragglers: StragglerAlert[];
  /** 静默 —— 可能卡死 */
  silent: SilenceAlert[];
  /** 越界 —— 节点碰了不属于自己领地的文件 */
  trespass: Array<{ nodeId: string; path: string }>;
}

export interface SnapshotOptions {
  /** 超过同批中位数这么多倍算掉队。默认 2.0 */
  stragglerRatio?: number;
  /** 静默这么久算可疑。默认 5 分钟 (与 core 侧 NO_PROGRESS_ABORT_MS 同口径) */
  silenceMs?: number;
  /** 节点 id → 它的领地 */
  ownedPaths?: Map<string, string[]>;
  now?: number;
}

/**
 * 聚合成集群快照 —— **纯函数**。
 *
 * 这是喂给协调 Agent 的东西: 已经聚合好的结构化摘要, 不是原始事件流。
 * 如果把每个节点的每次工具调用都塞进协调者上下文, 那是灾难。
 */
export function buildSnapshot(
  tel: NodeTelemetry[],
  concurrency: { used: number; max: number },
  startedAt: number,
  opts: SnapshotOptions = {},
): ClusterSnapshot {
  const now = opts.now ?? Date.now();
  const ratio = opts.stragglerRatio ?? 2.0;
  const silenceMs = opts.silenceMs ?? 5 * 60_000;

  const running = tel.filter((t) => t.status === 'running' && t.startedAt);
  /* 掉队判定的基线用**已完成节点**的耗时中位数 —— 用在跑的算会被自己拉高 */
  const doneDurations = tel
    .filter((t) => t.status === 'done' && t.startedAt && t.finishedAt)
    .map((t) => t.finishedAt! - t.startedAt!);
  const base = median(doneDurations.length > 0
    ? doneDurations
    : running.map((t) => now - t.startedAt!));

  const stragglers: StragglerAlert[] = [];
  if (base > 0) {
    for (const t of running) {
      const el = now - t.startedAt!;
      if (el > base * ratio) {
        stragglers.push({ nodeId: t.id, elapsedMs: el, medianMs: base, ratio: el / base });
      }
    }
  }

  const silent: SilenceAlert[] = running
    .filter((t) => now - t.lastActivityAt >= silenceMs)
    .map((t) => ({ nodeId: t.id, silentMs: now - t.lastActivityAt }));

  const trespass: Array<{ nodeId: string; path: string }> = [];
  if (opts.ownedPaths) {
    for (const t of tel) {
      const owned = opts.ownedPaths.get(t.id);
      if (!owned || owned.length === 0) continue;
      for (const p of t.changedFiles.keys()) {
        const norm = p.replace(/^\.\//, '');
        const ok = owned.some((o) => norm === o || norm.startsWith(o.replace(/\/$/, '') + '/'));
        if (!ok) trespass.push({ nodeId: t.id, path: p });
      }
    }
  }

  return {
    nodes: tel,
    concurrency,
    totalInputTokens: tel.reduce((s, t) => s + t.inputTokens, 0),
    totalOutputTokens: tel.reduce((s, t) => s + t.outputTokens, 0),
    elapsedMs: now - startedAt,
    stragglers,
    silent,
    trespass,
  };
}

/** 给协调 Agent 看的紧凑文本 —— 结构化快照的可读投影, 控制在几百 token */
export function renderSnapshotForAgent(s: ClusterSnapshot): string {
  const lines: string[] = [];
  lines.push(`集群状态 | 已跑 ${Math.round(s.elapsedMs / 1000)}s | 并发 ${s.concurrency.used}/${s.concurrency.max} | token 出 ${s.totalOutputTokens}`);
  lines.push('');
  lines.push('| 节点 | 状态 | 耗时 | 轮次 | 改动 | 最近动作 |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of s.nodes) {
    const el = t.startedAt ? Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000) + 's' : '-';
    lines.push(`| ${t.id} | ${t.status} | ${el} | ${t.turns} | ${t.changedFiles.size} | ${t.lastTool ?? '-'} |`);
  }
  if (s.stragglers.length) {
    lines.push('');
    lines.push('⚠ 掉队 (墙钟由最慢节点决定):');
    for (const g of s.stragglers) {
      lines.push(`  ${g.nodeId} 已跑 ${Math.round(g.elapsedMs / 1000)}s, 是同批中位 ${Math.round(g.medianMs / 1000)}s 的 ${g.ratio.toFixed(1)} 倍`);
    }
  }
  if (s.silent.length) {
    lines.push('');
    lines.push('⚠ 静默 (可能卡死):');
    for (const g of s.silent) lines.push(`  ${g.nodeId} 已静默 ${Math.round(g.silentMs / 1000)}s`);
  }
  if (s.trespass.length) {
    lines.push('');
    lines.push(`⚠ 越界 ${s.trespass.length} 处 (节点碰了别人的领地):`);
    for (const g of s.trespass.slice(0, 8)) lines.push(`  ${g.nodeId} → ${g.path}`);
  }
  return lines.join('\n');
}
