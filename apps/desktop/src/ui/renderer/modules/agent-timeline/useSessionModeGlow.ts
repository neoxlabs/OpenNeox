import { useEffect, useState } from 'react';
import { useTeamPlan, useTeamExec } from '../../state/teamPlanStore';
import { useTargetIndicator } from './targetIndicatorStore';

export type ModeKind = 'team' | 'target';
/** planning=有事等你(琥珀) · running=在跑(琥珀呼吸) · done=收工(绿) · idle=牌留着但不发光 */
export type ModePhase = 'planning' | 'running' | 'done' | 'idle';

export interface SessionMode {
  kind: ModeKind;
  phase: ModePhase;
  /** 光要不要亮 —— 牌永远显示, 光只在活跃期和刚收工那几秒 */
  glow: boolean;
  label: string;
}

/** 收工后光留多久 */
const DONE_GLOW_MS = 6000;
/** 多久之前收工的算"历史" —— 切进一个昨天跑完的会话不该闪一下 */
const DONE_FRESH_MS = 90_000;

export interface TargetModeChipInput {
  sessionId?: string | null;
  targetSessionId: string | null;
  status: string;
  intentSessionId?: string | null;
  intentAt?: number;
  updatedAt: number;
}

/** 输入框 Target 牌: 只在真的还在目标模式 (或刚下了 /target) 时亮。终态必须是 null。 */
export function targetModeChip(input: TargetModeChipInput): SessionMode | null {
  const { sessionId } = input;
  if (
    input.targetSessionId === sessionId
    && (input.status === 'active' || input.status === 'paused')
  ) {
    return { kind: 'target', phase: 'running', glow: true, label: 'TARGET' };
  }
  const intentAt = input.intentAt ?? 0;
  const intentPending = intentAt > 0
    && input.intentSessionId === sessionId
    && intentAt >= (input.targetSessionId === sessionId ? input.updatedAt : 0);
  if (intentPending) {
    return { kind: 'target', phase: 'planning', glow: true, label: 'TARGET' };
  }
  return null;
}

export function useSessionModeGlow(sessionId?: string | null): SessionMode | null {
  const plan = useTeamPlan(sessionId);
  const exec = useTeamExec(sessionId);
  const target = useTargetIndicator();
  const [doneExpired, setDoneExpired] = useState(false);

  const execRunning = exec?.status === 'running' || exec?.status === 'paused';
  const execFinished = exec?.status === 'done' || exec?.status === 'failed';
  const finishedAt = execFinished ? (exec!.updatedAt ?? 0) : 0;
  const doneFresh = finishedAt > 0 && Date.now() - finishedAt < DONE_FRESH_MS;
  const doneKey = doneFresh ? `${sessionId}:${finishedAt}` : '';
  useEffect(() => {
    if (!doneKey) { setDoneExpired(false); return; }
    setDoneExpired(false);
    const t = window.setTimeout(() => setDoneExpired(true), DONE_GLOW_MS);
    return () => window.clearTimeout(t);
  }, [doneKey]);

  /* team 优先: 团队会话里 target 通常也没开; 两个都在时以团队为主 (它是更大的语境) */
  if (plan) {
    const phase: ModePhase = execRunning ? 'running'
      : execFinished ? (doneFresh && !doneExpired ? 'done' : 'idle')
        : 'planning';
    return {
      kind: 'team', phase,
      glow: phase === 'running' || phase === 'planning' || phase === 'done',
      label: 'TEAM',
    };
  }
  return targetModeChip({
    sessionId,
    targetSessionId: target.sessionId,
    status: target.status,
    intentSessionId: target.intentSessionId,
    intentAt: target.intentAt,
    updatedAt: target.updatedAt,
  });
}
