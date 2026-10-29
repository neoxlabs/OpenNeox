import { rowStepLegacyStep, type Row, type RowStep } from './timelineRows';

export interface FoldDelegations {
  /** 派出去几个子 Agent */
  count: number;
  /** 模型 → 派了几个, 按次数从多到少 */
  models: Array<{ model: string; count: number }>;
  /** 子 Agent 一共做了多少步 (工具调用) */
  steps: number;
  running: number;
  failed: number;
}

/** 子 Agent 一条的两种形态: HistoryCell (background_task, 现行) / 旧 StepContent (type: delegation) */
type Delegation = { model?: string; status?: string; steps: number };

function asDelegation(step: RowStep): Delegation | null {
  const cell = (step as { kind?: string; cell?: Record<string, any> }).kind === 'cell' ? (step as { cell: Record<string, any> }).cell : null;
  if (cell) {
    if (cell.kind !== 'background_task' || !['delegation', 'worker', 'external'].includes(cell.variant)) return null;
    return { model: cell.model, status: cell.status, steps: Math.max(cell.toolUseCount ?? 0, cell.toolRecords?.length ?? 0) };
  }
  const c = rowStepLegacyStep(step)?.content as { type?: string; model?: string; status?: string; toolCount?: number; toolRecords?: unknown[] } | undefined;
  if (c?.type !== 'delegation') return null;
  return { model: c.model, status: c.status, steps: Math.max(c.toolCount ?? 0, c.toolRecords?.length ?? 0) };
}

export function foldDelegations(rows: Row[]): FoldDelegations | null {
  let count = 0, steps = 0, running = 0, failed = 0;
  const byModel = new Map<string, number>();
  const visit = (step: RowStep) => {
    const d = asDelegation(step);
    if (!d) return;
    count += 1;
    /* 后台 agent 的计数字段常年是 0 (只有工具记录在涨), 取两者大的那个 —— asDelegation 里已取 */
    steps += d.steps;
    if (d.status === 'running') running += 1;
    else if (d.status === 'error' || d.status === 'failed') failed += 1;
    const m = (d.model ?? '').trim();
    if (m) byModel.set(m, (byModel.get(m) ?? 0) + 1);
  };
  const walk = (list: Row[]) => {
    for (const r of list) {
      if (r.kind === 'single') visit(r.step);
      else if (r.kind === 'group' || r.kind === 'cluster') r.items.forEach(visit);
      else if (r.kind === 'activity' || r.kind === 'turn_fold') walk(r.rows);
    }
  };
  walk(rows);
  if (count === 0) return null;
  const models = [...byModel.entries()].map(([model, n]) => ({ model, count: n })).sort((a, b) => b.count - a.count);
  return { count, models, steps, running, failed };
}
