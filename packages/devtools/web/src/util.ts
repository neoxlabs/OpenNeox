export function fmtMs(ms?: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function fmtPct(v?: number): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

export function fmtNum(n?: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB');
}

export function ago(ts: number): string {
  return fmtMs(Date.now() - ts);
}

/** 0~1 → 颜色(成功率/命中率:高绿低红) */
export function rateColor(v: number): string {
  if (v >= 0.8) return 'var(--green)';
  if (v >= 0.5) return 'var(--yellow)';
  return 'var(--red)';
}
