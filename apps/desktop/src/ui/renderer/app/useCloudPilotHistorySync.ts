import { useEffect, useRef } from 'react';
import { flushPendingWrites, markTimelineExternallyDirty } from '../../state/timelineStore';

const POLL_MS = 45_000;

export function useCloudPilotHistorySync(
  sessionId: string | null | undefined,
  isPilot: boolean,
  running: boolean,
  reload: (sessionId: string) => Promise<unknown>,
): void {
  const live = useRef({ sessionId, running });
  live.current = { sessionId, running };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!sessionId || !isPilot || running) return;
    const api = (window as { neox?: { pilotSyncHistory?: (sid: string) => Promise<{ ok: boolean; added: number }> } }).neox;
    if (!api?.pilotSyncHistory) return;
    let stopped = false;
    const sync = async () => {
      if (stopped || document.visibilityState === 'hidden') return;
      try {
        await flushPendingWrites();
        const r = await api.pilotSyncHistory!(sessionId);
        if (stopped || !r?.added || live.current.sessionId !== sessionId || live.current.running) return;
        markTimelineExternallyDirty(sessionId);
        await reloadRef.current(sessionId);
      } catch { /* 断网 / 没登录: 下一拍再来 */ }
    };
    /* 刚打开 / 刚跑完: 等本地这轮落盘再比 */
    const first = window.setTimeout(() => { void sync(); }, 1500);
    const timer = window.setInterval(() => { void sync(); }, POLL_MS);
    return () => { stopped = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, [sessionId, isPilot, running]);
}
