import type { MonitorState } from '../types';
import { delta, type HistoryBundle, type MetricKey } from '../history';
import { Sparkline } from './Sparkline';
import { fmtMs, fmtNum, fmtPct, rateColor } from '../util';

type Unit = 'pct' | 'count' | 'tokens' | 'ms';

interface KpiDef {
  label: string; value: string; color?: string;
  series: MetricKey; spark: string; max?: number; unit: Unit;
  /** 同比时:下降是否算"坏"(成功率下降坏;错误上升坏) */
  downIsGood?: boolean;
  gap?: boolean;
}

function fmtDelta(arr: number[], unit: Unit): { txt: string; dir: 'up' | 'down' | 'flat' } {
  const { diff, pct } = delta(arr);
  if (Math.abs(diff) < 1e-9) return { txt: '0', dir: 'flat' };
  const dir = diff > 0 ? 'up' : 'down';
  let txt = '';
  if (unit === 'pct') txt = `${Math.abs(diff * 100).toFixed(1)}%`;
  else if (unit === 'tokens') txt = fmtNum(Math.abs(diff));
  else if (unit === 'ms') txt = fmtMs(Math.abs(diff));
  else txt = String(Math.round(Math.abs(diff)));
  return { txt, dir };
}

export function KpiStrip({ state, history }: { state: MonitorState; history: HistoryBundle }) {
  const m = state.metrics;
  const k = history.kpi;
  const defs: KpiDef[] = [
    { label: 'Active Agents', value: String(m.activeAgents), series: 'activeAgents', spark: 'var(--accent)', unit: 'count', downIsGood: false },
    { label: 'Tool Success %', value: fmtPct(m.toolSuccessRate), color: rateColor(m.toolSuccessRate), series: 'toolSuccessRate', spark: rateColor(m.toolSuccessRate), max: 1, unit: 'pct', downIsGood: false },
    { label: 'Cache Hit %', value: fmtPct(m.cacheHitRate), color: rateColor(m.cacheHitRate), series: 'cacheHitRate', spark: 'var(--cyan)', max: 1, unit: 'pct', downIsGood: false },
    { label: 'Tokens / min', value: fmtNum(m.tokensPerMin), series: 'tokensPerMin', spark: 'var(--purple)', unit: 'tokens', downIsGood: true },
    { label: 'Tool p95 Latency', value: fmtMs(m.toolLatencyP95), series: 'toolLatencyP95', spark: 'var(--cyan)', unit: 'ms', downIsGood: true, gap: true },
    { label: 'High-Risk Count', value: String(m.highRiskToolCalls), color: m.highRiskToolCalls ? 'var(--red)' : undefined, series: 'highRiskToolCalls', spark: 'var(--red)', unit: 'count', downIsGood: true },
    { label: 'Retries', value: String(m.streamRetries), color: m.streamRetries ? 'var(--amber)' : undefined, series: 'streamRetries', spark: 'var(--amber)', unit: 'count', downIsGood: true },
    { label: 'In-Flight Stalls', value: state.controlPlane.available ? String(state.controlPlane.inflightStalls.length) : '—', color: state.controlPlane.inflightStalls.length ? 'var(--amber)' : undefined, series: 'inflightStalls', spark: 'var(--amber)', unit: 'count', downIsGood: true },
  ];

  return (
    <div className="kpis">
      {defs.map((d) => {
        const arr = k[d.series];
        const dl = fmtDelta(arr, d.unit);
        const good = dl.dir === 'flat' ? false : (dl.dir === 'up' ? !d.downIsGood : d.downIsGood);
        const cls = dl.dir === 'flat' ? '' : good ? 'up' : 'down';
        const arrow = dl.dir === 'up' ? '↗' : dl.dir === 'down' ? '↘' : '→';
        return (
          <div className={`kpi ${d.gap ? 'gap' : ''}`} key={d.label}>
            <div className="k">{d.label}</div>
            <div className="v tnum" style={d.color ? { color: d.color } : undefined}>{d.value}</div>
            <div className="spark-wrap"><Sparkline data={arr} color={d.spark} max={d.max} width={130} height={30} /></div>
            <div className="delta">
              <span className={cls}>{arrow} {dl.txt}</span>
              <span>vs 2m ago</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
