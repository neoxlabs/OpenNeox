
import React, { useEffect, useMemo, useState } from 'react';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { useI18n } from '../../hooks/useI18n';
import DockRail from './dock/DockRail';
import type { DockPill } from './dock/dockTypes';
import { mergePlanSteps, usePlanEdits, type PlanUserEdit } from '../../state/planEdits';
import PlanStepRow from './PlanStepRow';
import {
  computePlanStepTimings,
  elapsedSeconds,
  isOverEstimate,
  stepsMissingPhase,
} from './planTiming';

interface PlanStep {
  id?: string;
  content?: string;
  status?: string;
  /** 标准阶段 (Q-09) 与预计耗时 (Q-07) */
  phase?: string;
  estimateSec?: number;
}

const DONE = new Set(['completed', 'done']);
const ACTIVE = new Set(['in_progress', 'verifying']);
const BAD = new Set(['failed', 'blocked']);
const SKIPPED = new Set(['skipped']);

/** 计划药丸的可选接线 —— 不传就是只读 (旧行为不变) */
export interface PlanPillOptions {
  sessionId?: string | null;
  /** 用户点了跳过/先做/改名。UI 自己已先合并本地修改, 这里只负责告诉 agent。 */
  onEditPlan?: (edit: PlanUserEdit, step: { content?: string }) => void;
}

/** 取最后一条**非 frozen** 的 plan — frozen 表示已被新计划替换, 显示它会误导。 */
export function latestPlan(timeline: TimelineEntry[]): { steps: PlanStep[]; title?: string; explanation?: string } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i] as any;
    if (e?.type !== 'plan' && e?.type !== 'plan_update') continue;
    if (e.planFrozen) continue;
    const steps = Array.isArray(e.planSteps) ? (e.planSteps as PlanStep[]) : [];
    if (steps.length) return { steps, title: e.planTitle, explanation: typeof e.detail === 'string' ? e.detail : undefined };
  }
  return null;
}

/** 计划说明够短就当活名 (Pilot 开工时写的「摄氏转华氏工具」); 长的是说明文字, 不当标题 */
export function planName(plan: { explanation?: string } | null | undefined): string {
  const x = (plan?.explanation ?? '').trim().replace(/[。.]$/, '');
  return x && x.length <= 16 && !x.includes('\n') ? x : '';
}

/* 这一轮多久没有任何新 entry 就认为它其实已经结束了 —— 见下方 shouldHidePlanBar 说明 */
export const PLAN_BAR_STALE_MS = 60_000;

export function shouldHidePlanBar(input: {
  running?: boolean;
  allDone: boolean;
  /** 已完成步数 —— 区分"没开始过的计划"和"做到一半停住" */
  doneCount?: number;
  lastEntryTs: number;
  now: number;
  staleMs?: number;
}): boolean {
  /* 做完了就没有存在意义 —— 一条 "N/N 计划已完成" 常驻只是白占一行还挡 feed */
  if (input.allDone) return true;

  if (!input.running) {
    /* 停下来了: 只有"一步都没走过"的计划才收起来。 */
    return (input.doneCount ?? 0) === 0;
  }

  /* 还在跑: running 单信号可能收敛不了, 用"很久没有新 entry"兜底。
   * 注意这条只在 running 时生效 —— 中断态如果也按陈旧退场, 用户去充个值回来条子就没了。 */
  const staleMs = input.staleMs ?? PLAN_BAR_STALE_MS;
  return input.lastEntryTs > 0 && input.now - input.lastEntryTs > staleMs;
}

export function usePlanPill(
  timeline: TimelineEntry[],
  running?: boolean,
  opts?: PlanPillOptions,
): DockPill | null {
  const { isZh } = useI18n();
  /* 手动关掉之后, 直到**下一个计划**出现才重新露面 (按步骤数+首步内容识别是不是新计划) */
  const [dismissedKey, setDismissed] = useState<string | null>(null);
  /* 用户对计划的修改 (Q-06) —— 本地先合并, 点下去立刻变; agent 那边由 onEditPlan 告知 */
  const edits = usePlanEdits(opts?.sessionId);
  const rawPlan = useMemo(() => latestPlan(timeline), [timeline]);
  const plan = useMemo(
    () => (rawPlan ? { ...rawPlan, steps: mergePlanSteps(rawPlan.steps, edits) } : null),
    [rawPlan, edits],
  );
  const planKey = plan ? `${plan.steps.length}:${plan.steps[0]?.content ?? ''}` : '';

  /* Q-07: 每步什么时候开始 / 做完 —— 从 timeline 上同一条计划的 entry 时间戳算, 不另存状态 */
  const timings = useMemo(
    () => (plan ? computePlanStepTimings(timeline, plan.steps) : []),
    [timeline, plan],
  );
  /* Q-09: 模型没给某一步标阶段时, 面板顶部提一句让它重写 */
  const missingPhase = plan ? stepsMissingPhase(plan.steps) : 0;

  /* timeline 最后一条 entry 的时间 — 用来交叉验证 running 是不是真的还成立 */
  const lastEntryTs = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const t = (timeline[i] as unknown as { timestamp?: number })?.timestamp;
      if (typeof t === 'number' && t > 0) return t;
    }
    return 0;
  }, [timeline]);

  /* running 期间定时重算, 让"陈旧"判定能自己到期 (否则没有新 entry 就不会 re-render,
   * 条子会一直停在最后那一帧) */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [running]);

  if (!plan) return null;
  if (dismissedKey === planKey) return null;

  const { steps } = plan;
  const done = steps.filter((s) => DONE.has(s.status ?? '')).length;
  const blocked = steps.find((s) => BAD.has(s.status ?? ''));
  const current = steps.find((s) => ACTIVE.has(s.status ?? '')) ?? steps.find((s) => (s.status ?? 'pending') === 'pending');
  /* 跳过也是"这一步不做了", 不该让条子永远停在 7/8 —— 但它不算 done (进度数字照实说) */
  const allDone = steps.every((s) => DONE.has(s.status ?? '') || SKIPPED.has(s.status ?? ''));

  if (shouldHidePlanBar({ running, allDone, doneCount: done, lastEntryTs, now })) return null;

  /* 一行摘要: 进度 + 当前在做什么 —— 跟折叠态的 plan 卡同一套口径 */
  /* allDone 已在上面退场, 这里不再有"计划已完成"分支。
   * 中断态 (!running 但走过步) 要换个说法: 还写"当前: X"会被当成仍在跑, 而这时候
   * 用户真正要知道的是"停在这一步, 可以从这儿续"。 */
  const paused = !running;
  const lead = blocked
    ? `${isZh ? '受阻' : 'Blocked'}: ${blocked.content ?? ''}`
    : current?.content
      ? `${isZh ? (paused ? '已暂停, 停在' : '当前') : (paused ? 'Paused at' : 'Now')}: ${current.content}`
      : (isZh ? (paused ? '计划已暂停' : '计划进行中') : (paused ? 'Plan paused' : 'Plan running'));

  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;

  return {
    id: 'plan',
    /* 受阻要抢注意力; 停在半路是"等你续", 也算; 正常推进就是普通运行态 */
    tone: blocked ? 'attention' : paused ? 'warn' : 'running',
    icon: <PlanIcon pct={pct} />,
    label: isZh ? '计划' : 'Plan',
    meta: `${done}/${steps.length}`,
    detail: lead,
    weight: blocked ? 12 : 30,
    attention: !!blocked,
    /* 计划本身没有事件时间戳; 用完成步数当版本号, 走一步就"更新"一次排到前面 */
    updatedAt: done,
    ariaLabel: `${isZh ? '计划' : 'Plan'} ${done}/${steps.length} · ${lead}`,
    actions: [{
      id: 'dismiss',
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
      title: isZh
        ? '关闭这一条 — 计划本身不受影响, 完整清单在时间线的计划卡里, 出现新计划时会再显示'
        : 'Dismiss — the plan itself is unaffected; the full checklist stays in the timeline card',
      onClick: () => setDismissed(planKey),
    }],
    panel: (
      <ol className="atl-planbar__list atl-planbar__list--dock">
        {missingPhase > 0 && (
          <li className="atl-planbar__hint" role="note">
            {isZh
              ? `有 ${missingPhase} 步没标阶段 (读材料 / 核对 / 产出 / 自检) —— 可以让 agent 用 update_plan 重写计划`
              : `${missingPhase} step(s) have no phase (Read / Check / Produce / Verify) — ask the agent to rewrite the plan with update_plan`}
          </li>
        )}
        {steps.map((s, i) => {
          const elapsed = elapsedSeconds(timings[i], now);
          return (
            <PlanStepRow
              key={s.id ?? i}
              index={i}
              step={s}
              elapsedSec={elapsed}
              overEstimate={isOverEstimate(elapsed, s.estimateSec)}
              onEdit={opts?.onEditPlan ? (edit) => opts.onEditPlan!(edit, s) : undefined}
            />
          );
        })}
      </ol>
    ),
  };
}

/** 进度环图标 —— 一眼看出走到哪, 不用读数字 (原来那根细进度条的药丸版) */
const PlanIcon: React.FC<{ pct: number }> = ({ pct }) => (
  <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
    <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".25" />
    <circle
      cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round"
      strokeDasharray={`${(pct / 100) * 2 * Math.PI * 5.2} 999`}
      transform="rotate(-90 7 7)"
    />
  </svg>
);

/** 独立组件形态 —— 仍然可以单独挂 (它内部就是一条只有计划药丸的 DockRail) */
export const PlanStatusBar: React.FC<{ timeline: TimelineEntry[]; running?: boolean }> = ({ timeline, running }) => {
  const pill = usePlanPill(timeline, running);
  return <DockRail pills={pill ? [pill] : []} />;
};

export default PlanStatusBar;
