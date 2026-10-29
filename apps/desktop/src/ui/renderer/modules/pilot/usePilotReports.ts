import { useEffect, useState } from 'react';

export interface PilotReport {
  id: string;
  sessionId: string | null;
  status: 'done' | 'blocked' | 'failed' | 'progress';
  title: string;
  summary: string;
  options?: string[];
  urgency: 'fyi' | 'attention' | 'urgent';
  at: number;
  readAt?: number;
  answer?: string;
  calledAt?: number;
  callOutcome?: string;
  /** 同一件事又报了几次 (主进程合并), 板上显示 ×(repeats+1) */
  repeats?: number;
  lastAt?: number;
}

interface ReportsApi {
  pilotReports?: () => Promise<PilotReport[]>;
  pilotReportsRead?: (sessionId: string) => Promise<unknown>;
  pilotReportAnswer?: (id: string, answer: string) => Promise<unknown>;
  onPilotReportsChanged?: (cb: () => void) => () => void;
}
export const reportsApi = (): ReportsApi => ((window as unknown as { neox?: ReportsApi }).neox ?? {});

export function usePilotReports(): PilotReport[] {
  const [list, setList] = useState<PilotReport[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { void reportsApi().pilotReports?.().then((r) => { if (alive) setList(Array.isArray(r) ? r : []); }).catch(() => {}); };
    load();
    const off = reportsApi().onPilotReportsChanged?.(load);
    return () => { alive = false; off?.(); };
  }, []);
  return list;
}

/** 这个 Pilot 的任务板正摆在你眼前 (窗口在前台、页面可见) → 它的汇报算你看过了, 升级阶梯停 */
export function useMarkReportsSeen(sessionId: string | null, reports: PilotReport[]): void {
  const unread = !!sessionId && reports.some((r) => r.sessionId === sessionId && !r.readAt);
  useEffect(() => {
    if (!sessionId || !unread) return undefined;
    let t = 0;
    const check = () => {
      window.clearTimeout(t);
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      /* 停留一会儿才算看到, 切会话一闪而过不算 */
      t = window.setTimeout(() => { void reportsApi().pilotReportsRead?.(sessionId); }, 1500);
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [sessionId, unread]);
}
