import { useEffect, useSyncExternalStore } from 'react';

export interface MonitorWire {
  id: string;
  sessionId: string;
  label: string;
  trigger:
    | { type: 'output'; pid: number; pattern: string }
    | { type: 'poll'; command: string; intervalSeconds: number; until: string; pattern?: string }
    | { type: 'file'; path: string };
  fires: number;
  maxFires: number;
  createdAt: number;
  expiresAt: number;
}

const EMPTY: MonitorWire[] = [];
const bySession = new Map<string, MonitorWire[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

export function ingestMonitors(sessionId: string, list: unknown): void {
  if (!sessionId || !Array.isArray(list)) return;
  if (list.length === 0) bySession.delete(sessionId);
  else bySession.set(sessionId, list as MonitorWire[]);
  emit();
}

async function refresh(sessionId: string): Promise<void> {
  try {
    const list = await (window as any).neox?.monitorList?.(sessionId);
    ingestMonitors(sessionId, Array.isArray(list) ? list : []);
  } catch { /* 拉不到就保持现状 —— 失败不等于"没有监控" */ }
}

export async function stopMonitor(sessionId: string, id: string): Promise<void> {
  const ok = await (window as any).neox?.monitorStop?.({ sessionId, id }).catch(() => false);
  if (ok) ingestMonitors(sessionId, (bySession.get(sessionId) ?? []).filter((m) => m.id !== id));
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

export function useMonitors(sessionId: string | null | undefined): MonitorWire[] {
  useEffect(() => { if (sessionId) void refresh(sessionId); }, [sessionId]);
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? bySession.get(sessionId) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
}

export function _resetMonitorsStoreForTest(): void {
  bySession.clear();
}
