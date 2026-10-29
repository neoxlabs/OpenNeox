/**
 * Pilot · 身体 (稿 pl3)。手表 / 手机同步进 pilot-data 的数: 体重、睡眠、步数。
 *
 *   头: 身体 · 今天多少步
 *   上: 一张猫在瑜伽垫上伸懒腰的房间 + 三个大数 (体重和上月比 / 这周平均睡眠 / 今天步数)
 *   中: 体重 90 天折线 · 这周睡眠柱子 (虚线 = 7 小时)
 *   下: 它的建议 —— 身体相关里最要紧那条洞察, 一个能直接办的按钮
 */
import React, { useMemo } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { usePilotMetricSeries, usePilotMetricToday, usePilotOverview } from './pilotData';
import { useInsightRunner } from './useInsightRunner';
import roomBody from '../../../media/pilot/room-body.webp';

const SLEEP_GOAL_MIN = 420;
const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 体重折线: 纵轴取整到 2 公斤, 横轴标月份; 最后一个点挂一枚蓝签 */
const WeightChart: React.FC<{ points: Array<{ day: string; value: number }>; zh: boolean }> = ({ points: raw, zh }) => {
  const W = 520; const H = 200; const L = 34; const R = 14; const T = 14; const B = 26;
  /* 天天称的话一天一跳全是锯齿 —— 线画 7 天滑动平均看趋势, 蓝签那个点仍是最后一次真称的 */
  const points = raw.map((p, i) => {
    const win = raw.slice(Math.max(0, i - 6), i + 1);
    return { day: p.day, value: win.reduce((s, x) => s + x.value, 0) / win.length };
  });
  if (points.length < 2) return <p className="pv3-box__empty">{zh ? '记过两次以上体重才画得出来' : 'Needs at least two weigh-ins'}</p>;
  const vs = points.map((p) => p.value);
  const lo = Math.floor((Math.min(...vs) - 1) / 2) * 2;
  const hi = Math.ceil((Math.max(...vs) + 1) / 2) * 2;
  const t0 = Date.parse(points[0].day); const t1 = Date.parse(points[points.length - 1].day);
  const x = (day: string) => L + ((Date.parse(day) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points[points.length - 1].day).toFixed(1)},${H - B} L${L},${H - B} Z`;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 2) ticks.push(v);
  const months: Array<{ x: number; label: string }> = [];
  const d = new Date(t0); d.setDate(1); d.setMonth(d.getMonth() + 1);
  for (; d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) {
    months.push({ x: x(d.toISOString().slice(0, 10)), label: zh ? `${d.getMonth() + 1}月` : d.toLocaleDateString('en-US', { month: 'short' }) });
  }
  const last = { day: raw[raw.length - 1].day, value: raw[raw.length - 1].value };
  return (
    <svg className="pv3-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={zh ? '体重 90 天' : 'Weight, 90 days'}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="pv3-chart__grid" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" className="pv3-chart__tick">{v}</text>
        </g>
      ))}
      {months.map((m) => <text key={m.label} x={m.x} y={H - 6} textAnchor="middle" className="pv3-chart__tick">{m.label}</text>)}
      <path d={area} className="pv3-chart__area" />
      <path d={line} className="pv3-chart__line" />
      <circle cx={x(last.day)} cy={y(last.value)} r="5" className="pv3-chart__dot" />
      <g transform={`translate(${x(last.day)},${y(last.value) - 14})`}>
        <rect x="-22" y="-20" width="44" height="20" rx="6" className="pv3-chart__tag" />
        <text y="-6" textAnchor="middle" className="pv3-chart__tagtext">{last.value.toFixed(1)}</text>
      </g>
    </svg>
  );
};

/** 这周睡眠: 一天一根陶土柱, 虚线是 7 小时 */
const SleepChart: React.FC<{ days: Array<{ day: string; min: number }>; zh: boolean }> = ({ days, zh }) => {
  const W = 480; const H = 200; const L = 34; const R = 10; const T = 18; const B = 26;
  const max = 600;
  const y = (m: number) => T + (1 - Math.min(m, max) / max) * (H - T - B);
  const slot = (W - L - R) / 7;
  const today = new Date();
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { key, label: (zh ? WEEK_ZH : WEEK_EN)[d.getDay()], min: days.find((x) => x.day === key)?.min ?? 0 };
  });
  return (
    <svg className="pv3-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={zh ? '这周睡眠' : 'Sleep this week'}>
      {[0, 240, 420, 600].map((m) => (
        <g key={m}>
          {m !== SLEEP_GOAL_MIN && <line x1={L} x2={W - R} y1={y(m)} y2={y(m)} className="pv3-chart__grid" />}
          <text x={L - 8} y={y(m) + 4} textAnchor="end" className="pv3-chart__tick">{m / 60}h</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={y(SLEEP_GOAL_MIN)} y2={y(SLEEP_GOAL_MIN)} className="pv3-chart__goal" />
      <text x={W - R} y={y(SLEEP_GOAL_MIN) - 6} textAnchor="end" className="pv3-chart__tick">{zh ? '目标 7 小时' : 'Goal 7h'}</text>
      {week.map((d, i) => {
        const cx = L + slot * i + slot / 2;
        return (
          <g key={d.key}>
            {d.min > 0 && <rect x={cx - 13} y={y(d.min)} width="26" height={H - B - y(d.min)} rx="7" className="pv3-chart__bar" />}
            <text x={cx} y={H - 6} textAnchor="middle" className="pv3-chart__tick">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
};

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
}

export const PilotBodyPage: React.FC<Props> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const { data } = usePilotOverview();
  const steps = usePilotMetricToday('health.steps');
  const weights = usePilotMetricSeries('health.weight', 90);
  const { run, ask, done } = useInsightRunner(sessionId, onGoChat);
  const b = data?.rooms.body;
  const sleep7 = b?.scene?.sleep7 ?? [];
  const sleepAvg = useMemo(() => {
    const xs = sleep7.filter((d) => d.min > 0);
    return xs.length ? xs.reduce((s, d) => s + d.min, 0) / xs.length : null;
  }, [sleep7]);
  const tip = (data?.insights ?? []).find((i) => i.domain === 'body' && !done[i.id] && i.tone !== 'good')
    ?? (data?.insights ?? []).find((i) => i.domain === 'body' && !done[i.id]);
  const stepsText = steps == null ? '—' : Math.round(steps).toLocaleString('en-US');

  return (
    <div className="pv3-room" data-loading={data ? undefined : ''}>
      <header className="pv3-room__head">
        <div>
          <h1 className="pv3-pagehead">{isZh ? '身体' : 'Body'}</h1>
          <p className="pv3-pagesub">
            {isZh ? '手表和手机自动同步' : 'Synced from your watch and phone'}
            {steps != null ? (isZh ? ` · 今天 ${stepsText} 步` : ` · ${stepsText} steps today`) : ''}
          </p>
        </div>
      </header>

      <section className="pv3-box pv3-bodyhero">
        <div className="pv3-bodyhero__art" style={{ backgroundImage: `url(${roomBody})` }} />
        <div className="pv3-bodyhero__nums">
          <div className="pv3-bignum">
            <b>{b?.weight != null ? b.weight.toFixed(1) : '—'}<small>{isZh ? '公斤' : 'kg'}</small></b>
            <span>{b?.weightDelta30 != null ? (isZh ? `比上月 ${b.weightDelta30 > 0 ? '+' : '−'}${Math.abs(b.weightDelta30).toFixed(1)}` : `${b.weightDelta30 > 0 ? '+' : '−'}${Math.abs(b.weightDelta30).toFixed(1)} vs last month`) : (isZh ? '体重' : 'Weight')}</span>
          </div>
          <div className="pv3-bignum">
            <b>{sleepAvg != null ? (sleepAvg / 60).toFixed(1) : '—'}<small>{isZh ? '小时' : 'h'}</small></b>
            <span>{isZh ? '平均睡眠' : 'Avg sleep'}</span>
            {sleepAvg != null && sleepAvg < SLEEP_GOAL_MIN - 30 && <em>{isZh ? '偏少' : 'Short'}</em>}
          </div>
          <div className="pv3-bignum">
            <b>{stepsText}{steps != null && <small>{isZh ? '步' : 'steps'}</small>}</b>
            <span>{isZh ? '今天' : 'Today'}</span>
          </div>
        </div>
      </section>

      <div className="pv3-room__cols pv3-room__cols--even">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '体重' : 'Weight'}<span className="pv3-box__sub"> · {isZh ? '90 天' : '90 days'}</span></h2>
          <WeightChart points={weights} zh={isZh} />
        </section>
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '睡眠' : 'Sleep'}<span className="pv3-box__sub"> · {isZh ? '这周' : 'This week'}</span></h2>
          <SleepChart days={sleep7} zh={isZh} />
        </section>
      </div>

      {tip && (
        <section className="pv3-box pv3-advice">
          <span className="pv3-advice__ic" aria-hidden>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" /></svg>
          </span>
          <div className="pv3-advice__text">
            <b>{isZh ? '它的建议' : 'Suggestion'}</b>
            <span>{tip.suggestion ? `${tip.title}，${tip.suggestion}` : tip.title}</span>
          </div>
          {tip.action && <button type="button" className="pv3-pill" onClick={() => void run(tip, tip.action!)}>{tip.action.label}</button>}
          <button type="button" className="pv3-pill pv3-pill--soft" onClick={() => void ask(isZh ? `关于「${tip.title}」，我们聊聊怎么办` : `About "${tip.title}" — let's talk it through`)}>
            {isZh ? '跟它聊聊' : 'Talk it over'}
          </button>
        </section>
      )}
    </div>
  );
};

export default PilotBodyPage;
