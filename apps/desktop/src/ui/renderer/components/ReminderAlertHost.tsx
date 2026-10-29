
import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './reminder-alert.css';
import { defaultIsZh } from '../hooks/useI18n';

const STORAGE_KEY = 'neox-life-reminder-alerts-v1';

interface PendingAlert {
  id: string;            // event id
  sessionId: string | null;
  title: string;
  context?: string;
  firedAt: number;
  /** 迟到说明 ("本该在 X 点提醒你…"); 关机/休眠错过 tick 时由 main 带下来. */
  lateNote?: string;
}

function loadAll(): PendingAlert[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is PendingAlert =>
      x && typeof x === 'object' && typeof x.id === 'string' && typeof x.title === 'string'
    );
  } catch { return []; }
}

function saveAll(list: PendingAlert[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
  catch { /* quota — silently drop */ }
}

const CHANGE_EVENT = 'neox:reminder-alerts-changed';

function formatFiredTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const ReminderAlertHost: React.FC<{ isZh?: boolean }> = ({ isZh = defaultIsZh() }) => {
  const [alerts, setAlerts] = useState<PendingAlert[]>(() => loadAll());

  /* 监听 renderer fired 事件 (main 广播 life-reminder:fired 后, AppShell 已监听.
   * 我们直接监听 preload 侧的 onReminderFired 即可, 避免依赖 dispatchHint 时序). */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const lifeApi = (window as { neox?: { lifeEvents?: {
      onReminderFired?: (cb: (p: { eventId: string; sessionId: string | null; title: string; context?: string; firedAt?: number; lateNote?: string }) => void) => () => void;
    } } }).neox?.lifeEvents;
    const offs: Array<() => void> = [];
    if (typeof lifeApi?.onReminderFired === 'function') {
      const off = lifeApi.onReminderFired((p) => {
        const list = loadAll();
        /* 幂等: 同 eventId 已存在跳过 */
        if (list.some((x) => x.id === p.eventId)) return;
        const trimmed: PendingAlert = {
          id: p.eventId,
          sessionId: p.sessionId ?? null,
          title: p.title,
          context: p.context,
          firedAt: p.firedAt ?? Date.now(),
          lateNote: p.lateNote,
        };
        /* FIFO 上限 5, 超了砍最老 */
        const next = [...list, trimmed].slice(-5);
        saveAll(next);
        setAlerts(next);
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
      });
      offs.push(off);
    }
    /* 跨窗口 storage 同步 (多窗口场景) */
    const sync = () => setAlerts(loadAll());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) sync(); });
    return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } window.removeEventListener(CHANGE_EVENT, sync); };
  }, []);

  const dismiss = useCallback((id: string) => {
    const next = loadAll().filter((x) => x.id !== id);
    saveAll(next);
    setAlerts(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  const openSession = useCallback((a: PendingAlert) => {
    if (a.sessionId) {
      try { window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: a.sessionId } })); }
      catch { /* ignore */ }
      /* 稍延后填 composer, 让 selectSession 落定 */
      const hint = isZh
        ? (a.context
            ? `[提醒] ${a.title}\n${a.context}\n\n要不要现在办?`
            : `[提醒] ${a.title}\n\n要不要现在办?`)
        : (a.context
            ? `[Reminder] ${a.title}\n${a.context}\n\nWant to handle it now?`
            : `[Reminder] ${a.title}\n\nWant to handle it now?`);
      setTimeout(() => {
        try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: hint, focus: true } })); }
        catch { /* ignore */ }
      }, 300);
    }
    dismiss(a.id);
  }, [dismiss, isZh]);

  const snooze = useCallback(async (a: PendingAlert) => {
    /* 10 分钟后再响: 建条新 reminder, 关掉本条 */
    try {
      const api = (window as any).neox?.lifeEvents;
      if (typeof api?.create === 'function') {
        await api.create({
          kind: 'reminder',
          sessionId: a.sessionId,
          title: a.title,
          payload: { context: a.context, recurrence: undefined },
          scheduledAt: Date.now() + 10 * 60 * 1000,
        });
      }
    } catch { /* ignore */ }
    dismiss(a.id);
  }, [dismiss]);

  if (alerts.length === 0) return null;
  return createPortal(
    <div className="neox-reminder-alerts" role="region" aria-label={isZh ? '提醒通知' : 'Reminders'}>
      {alerts.map((a) => (
        <div key={a.id} className="neox-reminder-alert" role="alertdialog" aria-labelledby={`alert-title-${a.id}`}>
          <div className="neox-reminder-alert__head">
            <span className="neox-reminder-alert__icon" aria-hidden="true">⏰</span>
            <div className="neox-reminder-alert__body">
              <div id={`alert-title-${a.id}`} className="neox-reminder-alert__title">{a.title}</div>
              {a.context && <div className="neox-reminder-alert__context">{a.context}</div>}
              {/* 迟到的提醒必须自报, 不能装作准点响的 */}
              {a.lateNote && <div className="neox-reminder-alert__context">{a.lateNote}</div>}
              <div className="neox-reminder-alert__time">{formatFiredTime(a.firedAt)}{isZh ? ' 到点' : ' fired'}</div>
            </div>
            <button
              type="button"
              className="neox-reminder-alert__close"
              onClick={() => dismiss(a.id)}
              title={isZh ? '关闭' : 'Close'}
              aria-label={isZh ? '关闭' : 'Close'}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <div className="neox-reminder-alert__actions">
            {a.sessionId && (
              <button
                type="button"
                className="neox-reminder-alert__btn neox-reminder-alert__btn--primary"
                onClick={() => openSession(a)}
              >
                {isZh ? '打开会话' : 'Open chat'}
              </button>
            )}
            <button
              type="button"
              className="neox-reminder-alert__btn"
              onClick={() => void snooze(a)}
              title={isZh ? '10 分钟后再响' : 'Snooze 10 min'}
            >
              {isZh ? '稍后再提醒' : 'Snooze'}
            </button>
            <button
              type="button"
              className="neox-reminder-alert__btn neox-reminder-alert__btn--ghost"
              onClick={() => dismiss(a.id)}
            >
              {isZh ? '好了' : 'Done'}
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
};

export default ReminderAlertHost;
