
import React, { useMemo } from 'react';
import type { DockPill } from './dock/dockTypes';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { INTERRUPTED_NOTICE_ID_PREFIX } from './turnAnomaly';
import { latestPlan } from './PlanStatusBar';
import { mergePlanSteps, usePlanEdits } from '../../state/planEdits';
import { useI18n } from '../../hooks/useI18n';

const DONE = new Set(['completed', 'done']);
const GONE = new Set(['skipped', 'failed', 'blocked']);

export interface ResumeAnchor {
  /** 0-based 下标; 文案里是 index + 1 */
  index: number;
  text: string;
}

/** 从计划里找「该从哪一步接着做」: 先找 in_progress, 再找第一个还没做/没被跳过的。 */
export function resumeAnchor(steps: readonly { content?: string; status?: string }[]): ResumeAnchor | null {
  let firstPending = -1;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i].status ?? 'pending';
    if (st === 'in_progress' || st === 'verifying') return { index: i, text: steps[i].content ?? '' };
    if (firstPending < 0 && !DONE.has(st) && !GONE.has(st)) firstPending = i;
  }
  return firstPending >= 0 ? { index: firstPending, text: steps[firstPending].content ?? '' } : null;
}

/** 这一轮是不是被用户停掉的 —— 只认「已停止」那条 notice, 且只看最后一条用户消息之后。 */
export function isTurnInterrupted(entries: readonly TimelineEntry[]): boolean {
  if (!entries.length) return false;
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'user_message') { anchor = i; break; }
  }
  const scope = anchor >= 0 ? entries.slice(anchor + 1) : entries;
  return scope.some((e) => e?.type === 'log' && String(e.id ?? '').startsWith(INTERRUPTED_NOTICE_ID_PREFIX));
}

/** 纯函数形态 —— 测试直接用, 不用 jsdom。 */
export function buildResumePill(input: {
  isZh: boolean;
  interrupted: boolean;
  running?: boolean;
  anchor: ResumeAnchor | null;
  updatedAt: number;
  onResume: () => void;
}): DockPill | null {
  if (!input.interrupted || input.running) return null;
  const { isZh, anchor } = input;
  /* 没有计划步骤时不出 —— 那种中断已经由输入框上方的异常区那一行负责,
   * 同一件事（已停止 + 继续）说两遍只会在输入框上方堆两层。 */
  if (!anchor) return null;
  const label = isZh ? `停在第 ${anchor.index + 1} 步` : `Stopped at step ${anchor.index + 1}`;
  return {
    id: 'resume-turn',
    tone: 'warn',
    icon: (
      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a4 4 0 1 1 1.2 2.8" />
        <path d="M3 3.6V7h3.4" />
      </svg>
    ),
    label,
    meta: isZh ? '继续' : 'Resume',
    detail: anchor.text || undefined,
    weight: 20,
    updatedAt: input.updatedAt,
    ariaLabel: `${label} · ${isZh ? '继续这一轮' : 'resume this turn'}`,
    onActivate: input.onResume,
  };
}

export function useResumePill(input: {
  timeline: TimelineEntry[];
  running?: boolean;
  sessionId?: string | null;
  onResume: () => void;
}): DockPill | null {
  const { isZh } = useI18n();
  const edits = usePlanEdits(input.sessionId);
  const plan = useMemo(() => latestPlan(input.timeline), [input.timeline]);
  const steps = useMemo(
    () => (plan ? mergePlanSteps(plan.steps, edits) : []),
    [plan, edits],
  );
  const interrupted = useMemo(() => isTurnInterrupted(input.timeline), [input.timeline]);
  const updatedAt = useMemo(() => {
    const last = input.timeline[input.timeline.length - 1] as unknown as { timestamp?: number } | undefined;
    return typeof last?.timestamp === 'number' ? last.timestamp : Date.now();
  }, [input.timeline]);

  return buildResumePill({
    isZh,
    interrupted,
    running: input.running,
    anchor: resumeAnchor(steps),
    updatedAt,
    onResume: input.onResume,
  });
}

export default useResumePill;
