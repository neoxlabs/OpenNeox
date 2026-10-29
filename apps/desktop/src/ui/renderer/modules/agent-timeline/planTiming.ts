
import type { TimelineEntry } from '../../utils/workspaceUtils';

/** 某一步的时间线: 什么时候开始做 / 什么时候做完 (ms epoch) */
export interface PlanStepTiming {
  startedAt?: number;
  endedAt?: number;
}

interface PlanLikeStep {
  content?: string;
  status?: string;
}

interface PlanLikeEntry {
  type?: string;
  planSteps?: PlanLikeStep[];
  planFrozen?: boolean;
  timestamp?: number;
}

/** 四阶段的中英显示名 —— 数据里存中文, 英文界面翻译 */
const PHASE_LABELS_EN: Record<string, string> = {
  '读材料': 'Read',
  '核对': 'Check',
  '产出': 'Produce',
  '自检': 'Verify',
};

export const PLAN_PHASE_ORDER = ['读材料', '核对', '产出', '自检'] as const;

export function phaseLabel(phase: string | undefined, isZh: boolean): string {
  if (!phase) return '';
  if (isZh) return phase;
  return PHASE_LABELS_EN[phase] ?? phase;
}

function isPlanEntry(e: PlanLikeEntry): boolean {
  return (e.type === 'plan' || e.type === 'plan_update')
    && Array.isArray(e.planSteps)
    && e.planSteps.length > 0;
}

/**
 * 当前计划的那一串 plan entry (按时间正序)。
 * 从最后一条非 frozen 的计划往回走, 只要相邻两次计划还共享至少一步同名文本,
 * 就认为属于同一条计划血脉; 一旦完全不共享 (换了任务 / 整份重写), 停。
 */
export function planLineage(timeline: TimelineEntry[]): PlanLikeEntry[] {
  const entries = (timeline as unknown as PlanLikeEntry[]).filter(isPlanEntry);
  let current = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].planFrozen) { current = i; break; }
  }
  if (current < 0) return [];

  const lineage: PlanLikeEntry[] = [entries[current]];
  const curSteps = entries[current].planSteps ?? [];
  for (let i = current - 1; i >= 0; i--) {
    const prev = entries[i];
    const sharesStep = (prev.planSteps ?? []).some(
      (s, j) => !!s.content && s.content === curSteps[j]?.content,
    );
    if (!sharesStep) break;
    lineage.unshift(prev);
  }
  return lineage;
}

/**
 * 逐步算出开始 / 完成时刻。返回值与传入 steps 一一对应。
 * 没有任何时间信息的步骤返回空对象 (UI 就不显示「已用」)。
 */
export function computePlanStepTimings(
  timeline: TimelineEntry[],
  steps: Array<{ content?: string }>,
): PlanStepTiming[] {
  const lineage = planLineage(timeline);
  return steps.map((_, index) => {
    const timing: PlanStepTiming = {};
    for (const entry of lineage) {
      const step = entry.planSteps?.[index];
      if (!step) continue;
      const ts = typeof entry.timestamp === 'number' && entry.timestamp > 0 ? entry.timestamp : undefined;
      if (ts === undefined) continue;
      if (step.status === 'in_progress' && timing.startedAt === undefined) {
        timing.startedAt = ts;
      } else if ((step.status === 'completed' || step.status === 'skipped')
        && timing.startedAt !== undefined && timing.endedAt === undefined) {
        timing.endedAt = ts;
      }
    }
    return timing;
  });
}

/** 已用秒数: 做完的步骤用结束时刻, 还在跑的用 now; 从没开始过 → undefined */
export function elapsedSeconds(timing: PlanStepTiming | undefined, nowMs: number): number | undefined {
  if (!timing || timing.startedAt === undefined) return undefined;
  const end = timing.endedAt ?? nowMs;
  return Math.max(0, Math.round((end - timing.startedAt) / 1000));
}

/** 偏差 >2x 才算超时 —— 预计 30s 实际 61s 才提醒, 58s 不提醒 */
export function isOverEstimate(elapsedSec: number | undefined, estimateSec: number | undefined): boolean {
  if (elapsedSec === undefined || !estimateSec || estimateSec <= 0) return false;
  return elapsedSec > estimateSec * 2;
}

/** 「45s」/「2m5s」/「1h5m」 */
export function formatPlanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}m${rest}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

/** 有几步没标阶段 (Q-09) —— >0 时计划面板提示模型重写 */
export function stepsMissingPhase(steps: Array<{ phase?: string }>): number {
  return steps.filter((s) => !s.phase || !s.phase.trim()).length;
}
