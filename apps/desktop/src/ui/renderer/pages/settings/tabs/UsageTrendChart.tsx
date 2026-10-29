import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  parseDayKey, presetRange, rangeLabel, sliceToRange, toDayKey, type UsageRange,
} from './usageRange';

/** 区间起点距今多少天 —— 决定要向后端拉多深的数据才够画上期。 */
function daysFromTodayBack(r: UsageRange): number {
  const start = parseDayKey(r.startDay);
  if (!start) return r.days;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - start.getTime()) / 86_400_000));
}

export interface DailyUsagePoint {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

type MetricKey = 'totalTokens' | 'outputTokens' | 'requests';

const H = 148;                 /* 画布高 */
const PAD = { t: 12, r: 8, b: 22, l: 8 };

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return m && d ? `${Number(m)}/${Number(d)}` : day;
}

/** 把稀疏的天补齐成连续日期 —— 没请求的那天该是 0, 不是"这一天不存在"。
 *  缺了会让折线把两个远端点直接连起来, 视觉上假装中间一直在用。 */

export const UsageTrendChart: React.FC<{
  /** @deprecated 传 range —— days 只在没给 range 时当"到今天为止的 N 天"用 */
  days?: number;
  range?: UsageRange;
  zh: boolean;
  /** 序列算好后回抛给外层 (分享卡要用同一份数据, 不重复拉一遍) */
  onSeries?: (series: DailyUsagePoint[]) => void;
}> = ({ days: daysProp = 30, range, zh, onSeries }) => {
  const effRange = useMemo(() => range ?? presetRange(daysProp === 7 ? '7d' : '30d'), [range, daysProp]);
  const days = effRange.days;
  const [rows, setRows] = useState<DailyUsagePoint[] | null>(null);
  const [metric, setMetric] = useState<MetricKey>('totalTokens');
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(560);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        /* 拉两倍窗口 —— 后一半是本期, 前一半是上期, 用来算环比。
           一个孤零零的总数说明不了任何事, "比上个周期多/少" 才是人会看的。

           自定义区间时窗口不一定贴着今天, 所以要拉到"上期起点 → 今天"这么深,
           否则区间越靠前拉回来的数据越不够, 图会从中间开始空。 */
        const depth = daysFromTodayBack(effRange) + days;
        const r = await (window as any).neox?.getDailyUsage?.(depth);
        if (!cancelled) setRows(Array.isArray(r) ? r : []);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [days, effRange]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    });
    obs.observe(el);
    setWidth(el.clientWidth || 560);
    return () => obs.disconnect();
  }, []);

  /* 本期 = 区间本身; 上期 = 紧挨着它的等长一段。两段都用 sliceToRange 补齐缺失的天,
     不能靠"数组下标切一刀" —— 自定义区间不贴着今天时下标对不上。 */
  const emptyPoint = (day: string): DailyUsagePoint =>
    ({ day, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const series = useMemo(
    () => (rows ? sliceToRange(rows, effRange, emptyPoint) : []),
    [rows, effRange],
  );
  const prevSeries = useMemo(() => {
    if (!rows) return [];
    const start = parseDayKey(effRange.startDay);
    if (!start) return [];
    const prevEnd = new Date(start.getTime() - 86_400_000);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);
    return sliceToRange(rows, { ...effRange, kind: 'custom', startDay: toDayKey(prevStart), endDay: toDayKey(prevEnd) }, emptyPoint);
  }, [rows, effRange, days]);

  /* 序列回抛给外层 (分享卡复用同一份数据, 不重复拉一遍库) */
  useEffect(() => { if (series.length > 0) onSeries?.(series); }, [series, onSeries]);
  const values = useMemo(() => series.map(p => Number(p[metric] || 0)), [series, metric]);
  const peak = useMemo(() => Math.max(1, ...values), [values]);

  const innerW = Math.max(1, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const xAt = (i: number) => PAD.l + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const yAt = (v: number) => PAD.t + innerH - (v / peak) * innerH;

  const linePath = useMemo(() => {
    if (values.length === 0) return '';
    return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, width, peak]);

  const areaPath = useMemo(() => {
    if (!linePath) return '';
    return `${linePath} L${xAt(values.length - 1).toFixed(1)},${(PAD.t + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(PAD.t + innerH).toFixed(1)} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linePath, values.length, width]);

  const metricLabel: Record<MetricKey, string> = {
    totalTokens: zh ? '总 Token' : 'Total tokens',
    outputTokens: zh ? '输出 Token' : 'Output tokens',
    requests: zh ? '请求数' : 'Requests',
  };

  const total = values.reduce((a, b) => a + b, 0);
  const prevTotal = prevSeries.reduce((a, p) => a + Number(p[metric] || 0), 0);
  /* 上期为 0 时不显示"+∞%" —— 那是噪音, 直接不显示环比 */
  const deltaPct = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;
  const hasData = total > 0;
  const activeDays = values.filter(v => v > 0).length;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (series.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - PAD.l;
    const ratio = innerW > 0 ? x / innerW : 0;
    const idx = Math.round(ratio * (series.length - 1));
    setHover(Math.min(series.length - 1, Math.max(0, idx)));
  };

  const hovered = hover != null ? series[hover] : null;

  return (
    <section className="usg-soft-block">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        {/* Hero —— 进页面第一眼该看到的就是这个数, 而不是六个并列的小数字 */}
        <div>
          <div className="usg-soft-block__label" style={{ margin: 0 }}>
            {zh ? `${rangeLabel(effRange, true)} · ${metricLabel[metric]}` : `${metricLabel[metric]} · ${rangeLabel(effRange, false)}`}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.15, color: 'var(--neox-fg-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {hasData ? formatCompact(total) : '—'}
            </span>
            {hasData && deltaPct != null && (
              <span
                style={{
                  fontSize: 12, fontVariantNumeric: 'tabular-nums',
                  color: deltaPct >= 0 ? 'var(--neox-fg-secondary)' : 'var(--neox-fg-muted)',
                }}
                title={zh ? `上一个 ${days} 天: ${formatCompact(prevTotal)}` : `Previous ${days}d: ${formatCompact(prevTotal)}`}
              >
                {deltaPct >= 0 ? '↑' : '↓'} {Math.abs(deltaPct).toFixed(0)}%
                <span style={{ color: 'var(--neox-fg-hint)' }}> {zh ? '较上期' : 'vs prev'}</span>
              </span>
            )}
            {hasData && (
              <span style={{ fontSize: 12, color: 'var(--neox-fg-hint)' }}>
                · {zh ? `${activeDays} 天有活动` : `${activeDays} active days`}
              </span>
            )}
          </div>
        </div>
        {/* 指标切换 —— 一次只画一条线, 不做双 y 轴 */}
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {(['totalTokens', 'outputTokens', 'requests'] as MetricKey[]).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setMetric(k)}
              style={{
                border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                padding: '3px 9px', borderRadius: 6, fontSize: 11.5,
                background: metric === k
                  ? 'color-mix(in srgb, var(--neox-primary-600, #6c5cf2) 16%, transparent)'
                  : 'transparent',
                color: metric === k ? 'var(--neox-fg-primary)' : 'var(--neox-fg-muted)',
                fontWeight: metric === k ? 600 : 400,
              }}
            >
              {metricLabel[k]}
            </button>
          ))}
        </div>
      </div>

      <div ref={hostRef} style={{ position: 'relative', width: '100%' }}>
        {rows == null ? (
          <div className="neox-text-shimmer" style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--neox-fg-muted)' }}>
            {zh ? '读取中…' : 'Loading…'}
          </div>
        ) : !hasData ? (
          <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--neox-fg-muted)' }}>
            {zh ? `近 ${days} 天没有本地请求记录` : `No local requests in the last ${days} days`}
          </div>
        ) : (
          <svg width={width} height={H} role="img" aria-label={`${metricLabel[metric]} · ${zh ? '按天' : 'by day'}`} style={{ display: 'block', overflow: 'visible' }}>
            <defs>
              <linearGradient id="nxUsageArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--neox-primary-600, #6c5cf2)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--neox-primary-600, #6c5cf2)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* 基线 + 峰值线 — 退到很淡, 只作参考, 不跟数据抢 */}
            {[0, 0.5, 1].map(f => (
              <line
                key={f}
                x1={PAD.l} x2={PAD.l + innerW}
                y1={PAD.t + innerH * f} y2={PAD.t + innerH * f}
                stroke="var(--neox-fg-primary)" strokeOpacity={f === 1 ? 0.14 : 0.06} strokeWidth="1"
              />
            ))}
            <text x={PAD.l} y={PAD.t - 2} fontSize="10" fill="var(--neox-fg-muted)">{formatCompact(peak)}</text>

            <path d={areaPath} fill="url(#nxUsageArea)" />
            <path d={linePath} fill="none" stroke="var(--neox-primary-600, #6c5cf2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

            {/* 首尾日期 —— 每个点都标日期会糊成一团, 只锚两端, 具体日期交给悬停 */}
            <text x={PAD.l} y={H - 6} fontSize="10" fill="var(--neox-fg-muted)">{shortDay(series[0]?.day ?? '')}</text>
            <text x={PAD.l + innerW} y={H - 6} fontSize="10" textAnchor="end" fill="var(--neox-fg-muted)">
              {shortDay(series[series.length - 1]?.day ?? '')}
            </text>

            {/* 悬停: 竖线 + 圆点 */}
            {hover != null && (
              <g pointerEvents="none">
                <line
                  x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t} y2={PAD.t + innerH}
                  stroke="var(--neox-fg-primary)" strokeOpacity="0.22" strokeWidth="1"
                />
                <circle
                  cx={xAt(hover)} cy={yAt(values[hover])} r="4.5"
                  fill="var(--neox-primary-600, #6c5cf2)"
                  stroke="var(--neox-bg-card, var(--neox-bg-elevated))" strokeWidth="2"
                />
              </g>
            )}

            {/* 命中层 —— 覆盖整幅, 命中区比线本身宽得多, 不用精确指到线上 */}
            <rect
              x="0" y="0" width={width} height={H} fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}

        {/* 数值气泡 —— 跟着悬停点走, 贴边时自动翻到另一侧 */}
        {hovered && hover != null && (
          <div
            style={{
              position: 'absolute', top: 4, pointerEvents: 'none',
              left: xAt(hover) > width / 2 ? undefined : Math.min(width - 140, xAt(hover) + 10),
              right: xAt(hover) > width / 2 ? Math.min(width - 140, width - xAt(hover) + 10) : undefined,
              padding: '6px 9px', borderRadius: 8, minWidth: 118,
              background: 'var(--neox-bg-elevated, #1c1c22)',
              border: '1px solid var(--neox-line, color-mix(in srgb, var(--neox-fg-primary) 12%, transparent))',
              boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
              fontSize: 11.5, lineHeight: 1.6,
            }}
          >
            <div style={{ color: 'var(--neox-fg-muted)', marginBottom: 2 }}>{hovered.day}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--neox-fg-primary)' }}>
              <span>{zh ? '请求' : 'Requests'}</span><span>{hovered.requests}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--neox-fg-secondary)' }}>
              <span>{zh ? '输入' : 'Input'}</span><span>{formatCompact(hovered.inputTokens)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--neox-fg-secondary)' }}>
              <span>{zh ? '输出' : 'Output'}</span><span>{formatCompact(hovered.outputTokens)}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export default UsageTrendChart;
