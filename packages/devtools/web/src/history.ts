import { useRef } from 'react';
import type { MonitorState } from './types';

export type MetricKey =
  | 'activeAgents' | 'activeSessions' | 'toolSuccessRate' | 'cacheHitRate'
  | 'tokensPerMin' | 'toolLatencyP95' | 'toolErrors' | 'highRiskToolCalls'
  | 'streamRetries' | 'inflightStalls';

export type MetricHistory = Record<MetricKey, number[]>;

export type EffKey =
  | 'totalTokens' | 'cacheHitRate' | 'toolSuccessRate' | 'avgIterationMs'
  | 'thinkRatio' | 'repeatToolCalls' | 'compactions' | 'toolFailure';
export type EffSeries = Record<EffKey, number[]>;

const CAP = 120;        // ~2min @ 1Hz (KPI)
const EFF_CAP = 40;     // 每 session 效率趋势点数
const MAX_SESS = 40;

export interface HistoryBundle {
  kpi: MetricHistory;
  effFor(sessionId: string): EffSeries;
}

function emptyKpi(): MetricHistory {
  return {
    activeAgents: [], activeSessions: [], toolSuccessRate: [], cacheHitRate: [],
    tokensPerMin: [], toolLatencyP95: [], toolErrors: [], highRiskToolCalls: [],
    streamRetries: [], inflightStalls: [],
  };
}
function emptyEff(): EffSeries {
  return { totalTokens: [], cacheHitRate: [], toolSuccessRate: [], avgIterationMs: [], thinkRatio: [], repeatToolCalls: [], compactions: [], toolFailure: [] };
}

export function useMetricHistory(state: MonitorState | null): HistoryBundle {
  const kpiRef = useRef<MetricHistory>(emptyKpi());
  const effRef = useRef<Map<string, EffSeries>>(new Map());
  const lastTs = useRef(0);

  if (state && state.lastUpdatedAt !== lastTs.current) {
    lastTs.current = state.lastUpdatedAt;
    const m = state.metrics; const h = kpiRef.current;
    push(h.activeAgents, m.activeAgents); push(h.activeSessions, m.activeSessions);
    push(h.toolSuccessRate, m.toolSuccessRate); push(h.cacheHitRate, m.cacheHitRate);
    push(h.tokensPerMin, m.tokensPerMin); push(h.toolLatencyP95, m.toolLatencyP95);
    push(h.toolErrors, m.toolErrors); push(h.highRiskToolCalls, m.highRiskToolCalls);
    push(h.streamRetries, m.streamRetries);
    push(h.inflightStalls, state.controlPlane.available ? state.controlPlane.inflightStalls.length : 0);

    const seen = new Set<string>();
    for (const s of state.sessions) {
      seen.add(s.sessionId);
      let e = effRef.current.get(s.sessionId);
      if (!e) { e = emptyEff(); effRef.current.set(s.sessionId, e); }
      const ef = s.efficiency;
      push(e.totalTokens, ef.totalTokens, EFF_CAP); push(e.cacheHitRate, ef.cacheHitRate, EFF_CAP);
      push(e.toolSuccessRate, ef.toolSuccessRate, EFF_CAP); push(e.avgIterationMs, ef.avgIterationMs, EFF_CAP);
      push(e.thinkRatio, ef.thinkRatio, EFF_CAP); push(e.repeatToolCalls, ef.repeatToolCalls, EFF_CAP);
      push(e.compactions, ef.compactions, EFF_CAP); push(e.toolFailure, ef.toolFailure, EFF_CAP);
    }
    // 回收消失的 session, 控制 Map 体量
    if (effRef.current.size > MAX_SESS) {
      for (const k of effRef.current.keys()) { if (!seen.has(k)) effRef.current.delete(k); }
    }
  }

  return {
    kpi: kpiRef.current,
    effFor: (sid: string) => effRef.current.get(sid) ?? emptyEff(),
  };
}

/** KPI 同比: 当前值 vs 窗口内最早值 */
export function delta(arr: number[]): { diff: number; pct: number } {
  if (arr.length < 2) return { diff: 0, pct: 0 };
  const first = arr[0]; const last = arr[arr.length - 1];
  const diff = last - first;
  const pct = first !== 0 ? (diff / Math.abs(first)) * 100 : (diff !== 0 ? 100 : 0);
  return { diff, pct };
}

function push(arr: number[], v: number, cap = CAP): void {
  arr.push(v);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}
