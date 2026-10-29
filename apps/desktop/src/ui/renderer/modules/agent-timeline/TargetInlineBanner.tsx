
import React, { useEffect, useMemo, useState } from 'react';
import { syncTargetFromSession, useTargetIndicator, type TargetIndicatorState } from './targetIndicatorStore';
import { useI18n } from '../../hooks/useI18n';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import type { DockPill } from './dock/dockTypes';
import {
  buildTargetPillModel,
  isTerminalTargetStatus as isTerminalStatus,
  shouldShowTarget,
  TARGET_TERMINAL_AUTO_FADE_MS as TERMINAL_AUTO_FADE_MS,
  type TargetPillModel,
} from './targetPill';

// ==================== 终态跟踪 (session-scoped) ====================

interface TerminalRecord {
  status: 'satisfied' | 'abandoned' | 'expired';
  atMs: number;       // 首次观察到该终态的时间
  dismissed: boolean; // 用户是否点 X 关闭
}

const sessionScopedTerminalRecords = new Map<string, TerminalRecord>();

// ==================== 图标 ====================

const TargetIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="8" cy="8" r="1" fill="currentColor" />
  </svg>
);

const PauseIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <rect x="4" y="3" width="3" height="10" rx="0.6" fill="currentColor" />
    <rect x="9" y="3" width="3" height="10" rx="0.6" fill="currentColor" />
  </svg>
);

const CheckIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 8.5l2 2 4-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const AbandonIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const ExpiredIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 4.5V8l2.5 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const StopIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
    <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
  </svg>
);

// ==================== 工具 ====================

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

interface TargetMissionView {
  snap: TargetIndicatorState;
  model: TargetPillModel;
  isPaused: boolean;
  stillWorking: boolean;
  stalled: boolean;
  label: string;
  hint: string | null;
  stepText: string | null;
  elapsed: string | null;
  runTargetCommand: (cmd: 'stop') => void;
  onDismiss: () => void;
}

function useTargetMissionView(activeSessionId?: string | null): TargetMissionView | null {
  const snap = useTargetIndicator();
  const { isZh } = useI18n();
  const { streaming, runningSessionIds } = useNeoxRuntime();
  const [now, setNow] = useState(() => Date.now());
  const lastBusyAtRef = React.useRef<{ sid: string | null; at: number }>({ sid: null, at: Date.now() });
  const [dismissTick, setDismissTick] = useState(0);

  useEffect(() => {
    if (snap.status !== 'active' && snap.status !== 'paused') return;
    if (!snap.target || !snap.createdAt) return;
    const id = window.setInterval(() => {
      const next = Date.now();
      setNow((prev) => (next - prev >= 900 ? next : prev));
    }, 1000);
    return () => window.clearInterval(id);
  }, [snap.status, snap.target, snap.createdAt]);

  const busyNow = snap.sessionId ? runningSessionIds.has(snap.sessionId) : streaming;
  useEffect(() => {
    const sid = snap.sessionId ?? null;
    const prev = lastBusyAtRef.current;
    if (prev.sid !== sid) { lastBusyAtRef.current = { sid, at: Date.now() }; return; }
    if (busyNow) lastBusyAtRef.current = { sid, at: Date.now() };
  }, [busyNow, snap.sessionId]);
  const idleMs = busyNow ? 0 : now - lastBusyAtRef.current.at;

  useEffect(() => {
    const sid = snap.sessionId;
    if (!sid) return;
    if (!isTerminalStatus(snap.status)) {
      sessionScopedTerminalRecords.delete(sid);
      return;
    }
    const existing = sessionScopedTerminalRecords.get(sid);
    if (existing && existing.status === snap.status) return;
    sessionScopedTerminalRecords.set(sid, {
      status: snap.status,
      atMs: Date.now(),
      dismissed: false,
    });
    setNow(Date.now());
  }, [snap.sessionId, snap.status]);

  const shouldShow = useMemo(() => {
    if (isTerminalStatus(snap.status) && !snap.sessionId) return false;
    const rec = snap.sessionId ? sessionScopedTerminalRecords.get(snap.sessionId) : undefined;
    return shouldShowTarget({
      status: snap.status,
      target: snap.target,
      terminalReachedAtMs: rec?.atMs ?? null,
      dismissed: !!rec?.dismissed,
      now,
    });
  }, [snap.status, snap.target, snap.sessionId, now, dismissTick]);

  useEffect(() => {
    if (!shouldShow) return;
    if (!isTerminalStatus(snap.status)) return;
    const sid = snap.sessionId;
    if (!sid) return;
    const rec = sessionScopedTerminalRecords.get(sid);
    if (!rec || rec.dismissed) return;
    const remaining = TERMINAL_AUTO_FADE_MS - (Date.now() - rec.atMs);
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const id = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(id);
  }, [snap.status, snap.sessionId, now, shouldShow]);

  const runTargetCommand = (cmd: 'stop'): void => {
    const sid = snap.sessionId;
    if (!sid) return;
    void (async () => {
      try {
        await (window as any).neox?.targetCommand?.(sid, cmd);
      } catch { /* IPC 失败无害, 状态以后端为准 */ }
      try { await syncTargetFromSession(sid); } catch { /* noop */ }
    })();
  };

  const onDismiss = (): void => {
    const sid = snap.sessionId;
    if (!sid) return;
    const rec = sessionScopedTerminalRecords.get(sid);
    if (rec) {
      sessionScopedTerminalRecords.set(sid, { ...rec, dismissed: true });
    } else {
      sessionScopedTerminalRecords.set(sid, {
        status: isTerminalStatus(snap.status) ? snap.status : 'satisfied',
        atMs: Date.now(),
        dismissed: true,
      });
    }
    setDismissTick(t => t + 1);
  };

  if (activeSessionId && snap.sessionId && snap.sessionId !== activeSessionId) return null;
  if (!shouldShow) return null;

  const model = buildTargetPillModel({
    status: snap.status,
    target: snap.target,
    abandonReason: snap.abandonReason,
    phase: snap.phase,
    subMissionCount: snap.subMissionCount,
    completedSubMissions: snap.completedSubMissions,
    busy: busyNow,
    idleMs,
    isZh,
  });

  return {
    snap,
    model,
    isPaused: snap.status === 'paused',
    stillWorking: model.stillWorking,
    stalled: model.stalled,
    label: model.label,
    hint: model.hint,
    stepText: model.progress,
    elapsed: snap.createdAt ? formatElapsed(now - snap.createdAt) : null,
    runTargetCommand,
    onDismiss,
  };
}

const CloseActionIcon = (): React.ReactElement => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/** 输入框上方 Dock 药丸 —— 简约胶囊输入框的目标激活指示。 */
export function useTargetPill(activeSessionId?: string | null): DockPill | null {
  const view = useTargetMissionView(activeSessionId);
  const { isZh } = useI18n();
  /* 团队会话: 面板顶部给一个"在右栏打开"的入口 —— 药丸里只放摘要, 完整规划面板在 Surface。
   *   team_run_start 时自动开过一次, 但模型随后打开的文档会把右栏顶掉, 得有路回去。 */
  return useMemo(() => {
    if (!view) return null;
    const { snap, model, isPaused, elapsed, runTargetCommand, onDismiss } = view;
    const { tone, label, hint, progress, weight, attention, terminal, primaryText: targetText } = model;
    /* 有战略块就报块进度, 没有就退回已跑时长 —— 药丸右侧那格不能空着 */
    const meta = progress ?? elapsed ?? undefined;
    const detail = hint || undefined;
    const actions = terminal
      ? [{
          id: 'dismiss',
          icon: <CloseActionIcon />,
          title: isZh ? '关闭' : 'Dismiss',
          onClick: onDismiss,
        }]
      : [
          {
            id: 'stop',
            icon: <StopIcon />,
            title: isZh ? '终止目标' : 'Stop target',
            danger: true,
            onClick: () => runTargetCommand('stop'),
          },
        ];
    const panel = (snap.subMissions.length > 0 || targetText)
      ? (
        <div className="nx-dock__goal">
          {targetText && <div className="nx-dock__goal-text">{targetText}</div>}
          {snap.subMissions.length > 0 && (
        <ol className="atl-planbar__list atl-planbar__list--dock">
          {snap.subMissions.map((m) => {
            const st = m.status ?? 'pending';
            const cls = st === 'completed' ? 'is-done' : st === 'in_progress' ? 'is-running' : 'is-pending';
            return (
              <li key={m.id} className={`atl-planbar__row ${cls}`}>
                <span className="atl-planbar__box" aria-hidden="true" />
                <span className="atl-planbar__text">{m.description}</span>
              </li>
            );
          })}
        </ol>
          )}
        </div>
      )
      : undefined;
    return {
      id: `target:${snap.sessionId ?? 'current'}`,
      tone,
      icon: snap.status === 'satisfied' ? <CheckIcon />
        : snap.status === 'abandoned' ? <AbandonIcon />
          : snap.status === 'expired' ? <ExpiredIcon />
            : isPaused ? <PauseIcon /> : <TargetIcon />,
      label,
      meta,
      detail,
      weight,
      attention,
      updatedAt: snap.updatedAt || Date.now(),
      actions,
      ariaLabel: [label, targetText, meta].filter(Boolean).join(' · '),
      panel,
    };
  }, [view, isZh]);
}

// ==================== 主组件 ====================
// 标准输入框仍走整宽横幅; 简约胶囊走 Dock 药丸 (useTargetPill)。两者共用 useTargetMissionView。

export function TargetInlineBanner({
  activeSessionId = null,
}: {
  /** 当前 UI 正在看的会话 — 横幅只显示属于它的 target (session 隔离, 防长跑 target 跨会话泄漏). */
  activeSessionId?: string | null;
} = {}): React.ReactElement | null {
  const view = useTargetMissionView(activeSessionId);
  const { isZh } = useI18n();
  if (!view) return null;
  const { snap, isPaused, label, hint, stepText, elapsed, runTargetCommand, onDismiss } = view;

  const hintText = hint ? ` · ${hint}` : null;

  switch (snap.status) {
    case 'active':
    case 'paused':
      return (
        <div
          className={`target-inline-banner ${isPaused ? 'is-paused' : 'is-active'}`}
          role="status"
          aria-live="polite"
        >
          <span className="target-inline-banner__icon">
            {isPaused ? <PauseIcon /> : <TargetIcon />}
          </span>
          <span className="target-inline-banner__label">{label}</span>
          <span className="target-inline-banner__sep">·</span>
          <span className="target-inline-banner__target" title={snap.target ?? ''}>{snap.target}</span>
          {stepText && <span className="target-inline-banner__progress">{stepText}</span>}
          {elapsed && <span className="target-inline-banner__elapsed">{elapsed}</span>}
          {hintText && <span className="target-inline-banner__hint">{hintText}</span>}
          <span className="target-inline-banner__actions">
            <button
              className="target-inline-banner__action is-stop"
              onClick={() => runTargetCommand('stop')}
              title={isZh ? '终止目标' : 'Stop target'}
              aria-label="stop target"
            >
              <StopIcon />
            </button>
          </span>
        </div>
      );
    case 'satisfied': {
      const totalLabel = isZh ? '用时' : 'took';
      return (
        <div className="target-inline-banner is-satisfied" role="status">
          <span className="target-inline-banner__icon"><CheckIcon /></span>
          <span className="target-inline-banner__label">{label}</span>
          <span className="target-inline-banner__sep">·</span>
          <span className="target-inline-banner__target" title={snap.target ?? ''}>{snap.target}</span>
          {elapsed && <span className="target-inline-banner__elapsed">{totalLabel} {elapsed}</span>}
          <button className="target-inline-banner__close" onClick={onDismiss} aria-label="dismiss">
            <CloseIcon />
          </button>
        </div>
      );
    }
    case 'abandoned': {
      const reason = snap.abandonReason || (isZh ? '(无理由)' : '(no reason)');
      return (
        <div className="target-inline-banner is-abandoned" role="status">
          <span className="target-inline-banner__icon"><AbandonIcon /></span>
          <span className="target-inline-banner__label">{label}</span>
          <span className="target-inline-banner__sep">·</span>
          <span className="target-inline-banner__target" title={reason}>{reason}</span>
          <button className="target-inline-banner__close" onClick={onDismiss} aria-label="dismiss">
            <CloseIcon />
          </button>
        </div>
      );
    }
    case 'expired':
      return (
        <div className="target-inline-banner is-expired" role="status">
          <span className="target-inline-banner__icon"><ExpiredIcon /></span>
          <span className="target-inline-banner__label">{label}</span>
          <span className="target-inline-banner__sep">·</span>
          <span className="target-inline-banner__target" title={snap.target ?? ''}>{snap.target}</span>
          {elapsed && <span className="target-inline-banner__elapsed">{elapsed}</span>}
          {hintText && <span className="target-inline-banner__hint">{hintText}</span>}
          <button className="target-inline-banner__close" onClick={onDismiss} aria-label="dismiss">
            <CloseIcon />
          </button>
        </div>
      );
    default:
      return null;
  }
}
