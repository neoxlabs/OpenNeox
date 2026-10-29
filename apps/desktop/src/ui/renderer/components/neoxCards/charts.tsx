
import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { numOf, normTone, NCardHead, type Tone } from './primitives';


interface ChartPoint { label?: string; value?: number | string; tone?: string }
interface ChartData {
  title?: string;
  type?: string;
  series?: ChartPoint[];
  unit?: string;
  /** stacked: 每组由多段构成 */
  groups?: Array<{ label?: string; parts?: ChartPoint[] }>;
  /**
   * 多系列 (分组柱 / 多条折线): series 里的 label 当横轴类别, 每条 multi 是一个系列。
   * 给了它颜色才有意义 —— 一个系列一个色; 单系列时不要给, 单色渐变才是对的。
   */
  multi?: Array<{ name?: string; values?: Array<number | string> }>;
  /** heatmap: 列头 + 行 */
  columns?: string[];
  rows?: Array<{ label?: string; values?: Array<number | string> }>;
  /** gauge 的分母; 不给就按 100 */
  max?: number | string;
  size?: string;
}

const CHART_COLORS = [
  'var(--nchart-c1)', 'var(--nchart-c2)', 'var(--nchart-c3)',
  'var(--nchart-c4)', 'var(--nchart-c5)', 'var(--nchart-c6)',
];

const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--neox-success-500, #22c55e)',
  warn: 'var(--neox-warning-500, #f59e0b)',
  bad:  'var(--neox-danger-500, #ef4444)',
  info: 'var(--neox-primary-500, #4f7cff)',
};

/**
 * **分类**取色 —— 只给"每一项各代表一个类别"的图形用: 饼 / 环 / 堆叠的分段。
 * 有 tone 就吃 tone (PASS 绿 / FAIL 红), 否则按固定顺序发, 发完为止不循环。
 */
const colorAt = (i: number, tone?: string): string =>
  (tone ? TONE_COLOR[normTone(tone)] : CHART_COLORS[Math.min(i, CHART_COLORS.length - 1)]);

/**
 * **单系列**取色 —— 柱状 / 横条 / 折线用这个。
 *
 * 这些图里每一根柱子是**同一个系列的不同取值**, 不是不同类别: "各模型 token 消耗"
 * 的四根柱共同回答一个问题, 颜色在这里不编码任何信息。给它们四种颜色 = 让读者
 * 去找一个不存在的含义 (规范: 单系列不需要图例, 因为标题就说明了它是什么)。
 * 只有显式给了 tone 的那一根才换色 —— 那时颜色是真的在说"这根是失败的"。
 */
const reportRamp = (i: number, n: number): string => {
  const pct = n <= 1 ? 100 : Math.round(100 - (i / (n - 1)) * 62);   /* 100% → 38% */
  return `color-mix(in srgb, var(--nchart-c1) ${pct}%, var(--neox-bg-card, #fff))`;
};

const seriesColor = (tone?: string): string =>
  (tone ? TONE_COLOR[normTone(tone)] : CHART_COLORS[0]);

/** 数字压缩显示: 12800 → 12.8k, 保证轴标签不撑爆 */
const fmtNum = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n * 100) / 100);
};

const NICE_STEPS = [1, 1.2, 1.5, 2, 3, 4, 5, 6, 8, 10];
const niceMax = (v: number): number => {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const step = NICE_STEPS.find((s) => f <= s + 1e-9) ?? 10;
  return step * base;
};

/** 折线/面积图的 y 轴定义域: 数据离零远 (最小值 > 0 且波动幅度 < 最大值的 60%) 就贴着数据,
 *  上下各留 15% 的呼吸, 端点取整到"好看的刻度"; 否则回到零基线。导出给闸用。 */
export const niceDomain = (vals: number[]): [number, number] => {
  const clean = vals.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return [0, 1];
  const mx = Math.max(...clean);
  const mn = Math.min(...clean);
  if (!(mn > 0) || mx <= 0) return [Math.min(mn, 0), niceMax(mx || 1)];
  const range = mx - mn;
  if (mx > 0 && range / mx >= 0.6) return [0, niceMax(mx)];
  const step = niceMax(Math.max(range, mx * 0.05) / 4);
  const lo = Math.max(0, Math.floor((mn - range * 0.15) / step) * step);
  const hi = Math.ceil((mx + range * 0.15) / step) * step;
  return [lo, hi > lo ? hi : lo + step];
};

export const ChartCard: React.FC<{ data: ChartData }> = ({ data }) => {
  const { isZh } = useI18n();
  const series = (Array.isArray(data.series) ? data.series : [])
    .map((s) => ({ label: String(s.label ?? ''), value: numOf(s.value), tone: s.tone }));
  const rawType = String(data.type ?? '').toLowerCase().trim();
  const unit = data.unit ? String(data.unit) : '';
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const multi = (Array.isArray(data.multi) ? data.multi : [])
    .map((s) => ({
      name: String(s?.name ?? ''),
      values: (Array.isArray(s?.values) ? s.values : []).map(numOf),
    }))
    .filter((s) => s.name && s.values.length > 0);
  const rows = Array.isArray(data.rows) ? data.rows : [];

  /* 类型归一 — 模型写法五花八门, 别因为写了 "column"/"barh" 就掉回默认 */
  const type =
    /^(pie)$/.test(rawType) ? 'pie'
    : /^(donut|doughnut|ring)$/.test(rawType) ? 'donut'
    : /^(gauge|radial|progress|percent)$/.test(rawType) ? 'gauge'
    : /^(line|trend)$/.test(rawType) ? 'line'
    : /^(area|areaspline)$/.test(rawType) ? 'area'
    : /^(stack|stacked|composition)$/.test(rawType) || groups.length ? 'stacked'
    : /^(heat|heatmap|matrix)$/.test(rawType) || rows.length ? 'heatmap'
    : /^(hbar|barh|horizontal)$/.test(rawType) ? 'hbar'
    : /^(cloud|wordcloud|word-cloud|keywords|tags)$/.test(rawType) ? 'cloud'
    : /^(pyramid|mountain|山峰|金字塔)$/.test(rawType) ? 'pyramid'
    : /^(funnel|漏斗)$/.test(rawType) ? 'funnel'
    : /^(target|bullseye|靶心|同心圆)$/.test(rawType) ? 'target'
    : /^(river|stream|河流)$/.test(rawType) ? 'river'
    : 'column';

  const empty = !series.length && !groups.length && !rows.length;
  const head = (
    <NCardHead glyph="chart" title={data.title || (isZh ? '图表' : 'Chart')} />
  );

  if (empty) {
    return (
      <div className="ncard ncard--chart nchart">
        {head}
        <div className="nchart__empty">{isZh ? '暂无数据' : 'No data'}</div>
      </div>
    );
  }

  /* 报告画幅: 图本来就是这一页的主角, 给足高度和内边距, 标签换行不截断 */
  const isReport = String(data.size ?? '').toLowerCase() === 'report';
  /* 标签太长或条目太多 → 竖列图会挤成一团, 自动降级横条 */
  const longLabels = series.some((s) => s.label.length > 6);
  const effective = type === 'column' && (series.length > (isReport ? 10 : 8) || (longLabels && !isReport))
    ? 'hbar' : type;
  /* pie / donut / gauge 是一块能被文字绕的插图; 柱/线/热力需要通栏才读得清坐标。
   * 没标题就没有可绕的文字, 图形自己拉满, 别空出一截。 */
  const compact = !!data.title && (effective === 'pie' || effective === 'donut' || effective === 'gauge');
  const plot =
    /* 多系列优先: 给了 multi 就画分组柱, 颜色这才编码了"哪个系列"这个信息 */
    multi.length > 1 && (effective === 'column' || effective === 'hbar')
      ? <GroupedColumnChart labels={series.map((s) => s.label)} multi={multi} unit={unit} report={isReport} />
      : multi.length > 1 && (effective === 'line' || effective === 'area')
      ? <MultiLineChart labels={series.map((s) => s.label)} multi={multi} unit={unit} report={isReport} />
      : effective === 'pie' || effective === 'donut'
      ? <PieChart series={series} donut={effective === 'donut'} unit={unit} report={isReport} />
      : effective === 'gauge'
        ? <GaugeChart series={series} unit={unit} max={numOf(data.max) || 100} />
        : effective === 'line' || effective === 'area'
          ? <LineChart series={series} unit={unit} area={effective === 'area'} report={isReport} />
          : effective === 'stacked'
            ? <StackedChart groups={groups} unit={unit} />
            : effective === 'heatmap'
              ? <HeatmapChart columns={Array.isArray(data.columns) ? data.columns.map(String) : []} rows={rows} unit={unit} />
              : effective === 'pyramid' || effective === 'funnel'
                ? <StackChart series={series} unit={unit} report={isReport} shape={effective} />
                : effective === 'target'
                  ? <TargetChart series={series} unit={unit} report={isReport} />
                  : effective === 'river'
                    ? <RiverChart series={series} unit={unit} report={isReport} />
                    : effective === 'cloud'
                      ? <CloudChart series={series} unit={unit} report={isReport} />
                : effective === 'hbar'
                  ? <HBarChart series={series} unit={unit} report={isReport} />
                  : <ColumnChart series={series} unit={unit} report={isReport} />;
  const figure = (
    <div className={`ncard__figure${compact ? '' : ' ncard__figure--wide'}`}>{plot}</div>
  );

  return (
    <div className={`ncard ncard--chart nchart${isReport ? ' nchart--report' : ''}`}>
      {/* 紧凑图: 图形在前, 标题作为行框绕过去。宽图: 标题在上, 图通栏在下。 */}
      {compact ? <>{figure}{data.title ? head : null}</> : <>{data.title ? head : null}{figure}</>}
    </div>
  );
};

function usePlotWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [w, setW] = React.useState(fallback);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setW(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* 竖列图 — 带 y 轴刻度 + 网格线 + 柱顶数值. 这是"看起来像图表"的主力形态 */
const ColumnChart: React.FC<{
  series: Array<{ label: string; value: number; tone?: string }>;
  unit: string;
  /** 报告画幅 —— 见 ChartData.size 的说明 */
  report?: boolean;
}> = ({ series, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = Math.max(report ? 300 : 240, measuredW);
  const H = report ? Math.min(330, Math.max(200, Math.round(W / 2.4))) : 112;
  const PAD_L = report ? 42 : 30;
  const PAD_R = report ? 10 : 4;
  const PAD_B = report ? 46 : 22;
  const peak = Math.max(...series.map((s) => Math.abs(s.value)), 0);
  const max = niceMax(peak || 1);
  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / Math.max(series.length, 1);
  const valFs = report ? 12 : 10;
  const fitsSlot = (texts: string[]) => texts.every((t) => measureText(t, valFs, 500) <= slot - 6);
  const bareVals = series.map((s) => fmtNum(s.value));
  const unitVals = unit ? series.map((_, i) => `${bareVals[i]} ${unit}`) : bareVals;
  const inlineUnit = !!unit && fitsSlot(unitVals);
  const valTexts = inlineUnit ? unitVals : bareVals;
  const showVals = fitsSlot(bareVals);
  const asideUnit = unit && !inlineUnit ? unit : '';
  const unitH = asideUnit ? (report ? 20 : 14) : 0;
  const PAD_T = (report ? 22 : 14) + unitH;
  const plotH = H - PAD_T - PAD_B;
  /* 柱子要窄: 报告里封顶 34px (1 unit = 1 px, 这就是屏幕上的真实宽度), 占槽 0.28 */
  const barW = Math.min(report ? 34 : 22, Math.max(8, slot * (report ? 0.28 : 0.3)));
  /* 报告里网格线加密到 5 条 —— 少了读不出中间值, 多了就成格子纸 */
  const ticks = [0, 0.5, 1].map((f) => ({ f, v: max * f }));
  const gradId = `nx-bar-${React.useId().replace(/[:]/g, '')}`;
  const hasTone = series.some((s) => !!s.tone);
  /* 类别标签: 报告画幅换行 (每行约 7 个字符), 最多两行, 再长才加省略号 */
  const catLines = (label: string): string[] => {
    if (!report) return [label.length > 11 ? label.slice(0, 10) + '…' : label];
    if (label.length <= 9) return [label];
    const sp = label.indexOf(' ');
    if (sp > 0) {
      let best = sp;
      for (let i = sp; i >= 0; i = label.indexOf(' ', i + 1)) {
        if (i < 0) break;
        if (Math.abs(i - label.length / 2) < Math.abs(best - label.length / 2)) best = i;
      }
      const head = label.slice(0, best);
      const tail = label.slice(best + 1);
      return [head, tail.length > 11 ? tail.slice(0, 10) + '…' : tail];
    }
    if (/^[\x00-\x7F]+$/.test(label)) return [label.length > 12 ? label.slice(0, 11) + '…' : label];
    const head = label.slice(0, 9);
    const tail = label.slice(9);
    return [head, tail.length > 10 ? tail.slice(0, 9) + '…' : tail];
  };
  return (
    <div className="nchart__plot" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="column chart" preserveAspectRatio="xMidYMid meet">
        {asideUnit && (
          <text className="nchart__unit" x={2} y={report ? 13 : 10} textAnchor="start">{asideUnit}</text>
        )}
        {ticks.map((t, i) => {
          const y = PAD_T + (1 - t.f) * plotH;
          return (
            <g key={i}>
              <line className="nchart__grid" x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} />
              <text className="nchart__tick" x={PAD_L - 5} y={y + 3} textAnchor="end">{fmtNum(t.v)}</text>
            </g>
          );
        })}
        {/* 柱身一道很浅的竖向渐变 —— 平涂的实心色块是"Excel 感"的另一半来源 (4.0.1 起正文里的图也用, 不只报告) */}
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--nchart-c1)" />
            <stop offset="100%" stopColor="color-mix(in srgb, var(--nchart-c1) 74%, var(--neox-bg-card, #fff))" />
          </linearGradient>
        </defs>
        {series.map((s, i) => {
          const h = max > 0 ? (Math.abs(s.value) / max) * plotH : 0;
          const x = PAD_L + i * slot + (slot - barW) / 2;
          const y = PAD_T + plotH - h;
          /* 只圆**顶部**两角, 底边贴着基线是平的 —— 四角全圆会让柱子"浮"起来,
           * Apple 的柱状图 (Health / Screen Time) 也都是顶圆底平。 */
          const r = Math.min(report ? 7 : 5, barW / 2, Math.max(h, 1));
          const hh = Math.max(h, 1.5);
          const d = `M${x},${y + hh} L${x},${y + r} Q${x},${y} ${x + r},${y}`
            + ` L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + hh} Z`;
          /* 有重点项 (给了 tone 的那几根) 时, 其余退成暖灰: 一张图只说一件事, 「甜啦啦在这里」一眼看见 */
          const fill = s.tone ? seriesColor(s.tone) : hasTone ? 'var(--nchart-muted)' : `url(#${gradId})`;
          return (
            <g key={i} className={s.tone ? 'is-focus' : hasTone ? 'is-muted' : undefined}>
              <path className="nchart__col" d={d} fill={fill} />
              {showVals && (
                <text className="nchart__col-val" x={x + barW / 2} y={y - (report ? 9 : 5)} textAnchor="middle">{valTexts[i]}</text>
              )}
              <title>{`${s.label}: ${s.value}${unit ? ' ' + unit : ''}`}</title>
            </g>
          );
        })}
        {/* 报告里**不画坐标轴线**: 最底那条网格线已经是基线, 再来一条黑线就是 Excel 皮 */}
        {!report && <line className="nchart__axis" x1={PAD_L} y1={PAD_T + plotH} x2={W - PAD_R} y2={PAD_T + plotH} />}
        {series.map((s, i) => {
          const lines = catLines(s.label);
          return (
            <text
              key={i} className="nchart__cat"
              x={PAD_L + i * slot + slot / 2} y={report ? PAD_T + plotH + 16 : H - 7} textAnchor="middle"
            >
              {lines.map((ln, j) => (
                <tspan key={j} x={PAD_L + i * slot + slot / 2} dy={j === 0 ? 0 : 13}>{ln}</tspan>
              ))}
            </text>
          );
        })}
      </svg>
    </div>
  );
};

/** 量一段文字在给定字号下的宽度 —— 复用一个 canvas, 不碰 DOM */
const measureText = (() => {
  let ctx: CanvasRenderingContext2D | null | undefined;
  return (text: string, size: number, weight: number): number => {
    if (ctx === undefined) {
      try { ctx = document.createElement('canvas').getContext('2d'); } catch { ctx = null; }
    }
    if (!ctx) {
      /* 没有 canvas (SSR / 测试环境) 时的估算: CJK 按一个字宽, 拉丁按 0.55 */
      let w = 0;
      for (const ch of text) w += /[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.55;
      return w * size;
    }
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    return ctx.measureText(text).width;
  };
})();

const GroupedColumnChart: React.FC<{
  labels: string[];
  multi: Array<{ name: string; values: number[] }>;
  unit: string;
  report?: boolean;
}> = ({ labels, multi, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = Math.max(report ? 300 : 240, measuredW);
  const H = report ? Math.min(330, Math.max(200, Math.round(W / 2.4))) : 116;
  const PAD_L = report ? 42 : 34;
  const PAD_R = report ? 10 : 6;
  const PAD_T = report ? 20 : 12;
  const PAD_B = report ? 40 : 22;
  const peak = Math.max(...multi.flatMap((s) => s.values.map(Math.abs)), 0);
  const max = niceMax(peak || 1);
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / Math.max(labels.length, 1);
  const n = Math.max(multi.length, 1);
  /* 组内柱子之间留一条细缝, 组与组之间留大缝 —— 一眼能看出"哪几根是一组" */
  const GAP = report ? 3 : 2;
  /* 柱子要窄 (用户在单系列那边说过两次「要窄要窄」, 分组柱同理): 单根封顶 20px,
   * 整组不超过槽宽的一半 —— 组之间的空白要明显大于组内的缝, 分组才读得出来。 */
  const groupW = Math.min(slot * 0.5, (report ? 20 : 14) * n + GAP * (n - 1));
  const barW = Math.max(4, (groupW - GAP * (n - 1)) / n);
  const ticks = [0, 0.5, 1].map((f) => ({ f, v: max * f }));
  return (
    <div className="nchart__plot" ref={plotRef}>
      <ul className="nchart__legend nchart__legend--top">
        {multi.map((s, i) => (
          <li key={i}>
            <i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="nchart__legend-lbl">{s.name}</span>
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="grouped column chart" preserveAspectRatio="xMidYMid meet">
        {ticks.map((t, i) => {
          const y = PAD_T + (1 - t.f) * plotH;
          return (
            <g key={i}>
              <line className="nchart__grid" x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} />
              <text className="nchart__tick" x={PAD_L - 5} y={y + 3} textAnchor="end">{fmtNum(t.v)}</text>
            </g>
          );
        })}
        {labels.map((_, gi) => {
          const gx = PAD_L + gi * slot + (slot - groupW) / 2;
          return multi.map((s, si) => {
            const v = s.values[gi];
            const h = max > 0 ? (Math.abs(v) / max) * plotH : 0;
            const x = gx + si * (barW + GAP);
            const y = PAD_T + plotH - h;
            const r = Math.min(report ? 5 : 2.5, barW / 2, Math.max(h, 1));
            const hh = Math.max(h, 1.5);
            const d = `M${x},${y + hh} L${x},${y + r} Q${x},${y} ${x + r},${y}`
              + ` L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + hh} Z`;
            return (
              <g key={`${gi}-${si}`}>
                <path className="nchart__col" d={d} fill={CHART_COLORS[si % CHART_COLORS.length]} />
                <title>{`${labels[gi]} · ${s.name}: ${v}${unit ? ` ${unit}` : ''}`}</title>
              </g>
            );
          });
        })}
        {labels.map((l, i) => (
          <text
            key={i} className="nchart__cat"
            x={PAD_L + i * slot + slot / 2} y={PAD_T + plotH + 16} textAnchor="middle"
          >
            {l.length <= 8 || (/^[\x00-\x7F]+$/.test(l) && l.indexOf(' ') < 0)
              ? (l.length > 11 ? `${l.slice(0, 10)}…` : l)
              : (() => {
              const sp = l.lastIndexOf(' ', 9);
              const cut = sp > 2 ? sp : 8;
              const tail = l.slice(sp > 2 ? sp + 1 : 8);
              return (
                <>
                  <tspan x={PAD_L + i * slot + slot / 2} dy={0}>{l.slice(0, cut)}</tspan>
                  <tspan x={PAD_L + i * slot + slot / 2} dy={13}>
                    {tail.length > 9 ? `${tail.slice(0, 8)}…` : tail}
                  </tspan>
                </>
              );
            })()}
          </text>
        ))}
      </svg>
    </div>
  );
};

const MultiLineChart: React.FC<{
  labels: string[];
  multi: Array<{ name: string; values: number[] }>;
  unit: string;
  report?: boolean;
}> = ({ labels, multi, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = Math.max(report ? 300 : 240, measuredW);
  const H = report ? Math.min(330, Math.max(200, Math.round(W / 2.4))) : 116;
  const PAD_L = report ? 46 : 34;
  const PAD_R = report ? 14 : 8;
  const PAD_T = report ? 18 : 12;
  const PAD_B = report ? 34 : 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const all = multi.flatMap((s) => s.values);
  const [min, max] = niceDomain(all);
  const span = max - min || 1;
  const step = labels.length > 1 ? plotW / (labels.length - 1) : 0;
  const ticks = report ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  const labelEvery = labels.length > 7 ? Math.ceil(labels.length / 5) : 1;
  return (
    <div className="nchart__plot" ref={plotRef}>
      <ul className="nchart__legend nchart__legend--top">
        {multi.map((s, i) => (
          <li key={i}>
            <i style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="nchart__legend-lbl">{s.name}</span>
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="multi line chart" preserveAspectRatio="xMidYMid meet">
        {ticks.map((f, i) => {
          const y = PAD_T + (1 - f) * plotH;
          return (
            <g key={i}>
              <line className="nchart__grid" x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} />
              <text className="nchart__tick" x={PAD_L - 5} y={y + 3} textAnchor="end">{fmtNum(min + span * f)}</text>
            </g>
          );
        })}
        {multi.map((s, si) => {
          const color = CHART_COLORS[si % CHART_COLORS.length];
          const pts = s.values.map((v, i): [number, number] => [
            PAD_L + i * step,
            PAD_T + (1 - (v - min) / span) * plotH,
          ]);
          const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
          return (
            <g key={si}>
              <path d={d} className="nchart__line-path" style={{ stroke: color }} />
              {pts.map(([x, y], i) => (
                <circle
                  key={i} cx={x} cy={y} r={report ? 3.2 : 2.4}
                  className="nchart__line-dot" style={{ fill: color }}
                >
                  <title>{`${labels[i]} · ${s.name}: ${s.values[i]}${unit ? ` ${unit}` : ''}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {labels.map((l, i) => (i % labelEvery === 0 || i === labels.length - 1) ? (
          <text
            key={i} className="nchart__cat" x={PAD_L + i * step} y={H - 7}
            textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
          >
            {l.length <= 9 ? l : (() => {
              /* 同分组柱: 断在空格上, 「2024 年 1-8 月」不许被截成「2024 年 1…」 */
              const sp = l.lastIndexOf(' ', 10);
              const x = PAD_L + i * step;
              const head = sp > 2 ? l.slice(0, sp) : l.slice(0, 9);
              const tail = sp > 2 ? l.slice(sp + 1) : l.slice(9);
              return (
                <>
                  <tspan x={x} dy={0}>{head}</tspan>
                  <tspan x={x} dy={13}>{tail.length > 9 ? `${tail.slice(0, 8)}…` : tail}</tspan>
                </>
              );
            })()}
          </text>
        ) : null)}
      </svg>
    </div>
  );
};

function wrapLabel(label: string, maxW: number, fs: number, weight = 400): string[] {
  if (measureText(label, fs, weight) <= maxW) return [label];
  /* 先找一个"越靠近中间越好"的断点: 中文在标点后断, 拉丁在空格处断 */
  const marks = /[，。、；：,;:）)】\]\s]/g;
  let best = -1;
  for (let m = marks.exec(label); m; m = marks.exec(label)) {
    const i = m.index + 1;
    if (measureText(label.slice(0, i), fs, weight) > maxW) break;
    best = i;
  }
  if (best < 2) {
    /* 没有可用断点: 按能塞下的字符数硬断 */
    best = label.length;
    while (best > 1 && measureText(label.slice(0, best), fs, weight) > maxW) best -= 1;
  }
  const head = label.slice(0, best).trim();
  let tail = label.slice(best).trim();
  if (measureText(tail, fs, weight) > maxW) {
    while (tail.length > 1 && measureText(`${tail}…`, fs, weight) > maxW) tail = tail.slice(0, -1);
    tail += '…';
  }
  return tail ? [head, tail] : [head];
}

interface CloudWord { text: string; x: number; y: number; size: number; rot: number; tier: 0 | 1 | 2; title: string }

function layoutCloud(
  series: Array<{ label: string; value: number }>,
  W: number, H: number, loFs: number, hiFs: number, unit: string,
  /** 允不允许竖排 —— 报告里一律不许 (见下面 rot 的注释) */
  rotate = true,
): CloudWord[] {
  const sorted = [...series]
    .filter((s) => s.label)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 40);
  if (sorted.length === 0) return [];
  const max = Math.max(...sorted.map((s) => Math.abs(s.value)));
  const min = Math.min(...sorted.map((s) => Math.abs(s.value)));
  const span = Math.max(max - min, 1e-9);
  const cx = W / 2;
  const cy = H / 2;
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const out: CloudWord[] = [];
  const PAD = 4;

  sorted.forEach((s, i) => {
    const f = max === min ? 1 : (Math.abs(s.value) - min) / span;
    /* 字号按 sqrt 映射: 线性映射会让最大词吃掉整个画幅, 而**面积**才是人眼读到的量 */
    const size = Math.max(loFs, Math.round(loFs + Math.sqrt(f) * (hiFs - loFs)));
    const tier: 0 | 1 | 2 = f > 0.62 ? 0 : f > 0.28 ? 1 : 2;
    const weight = tier === 0 ? 650 : tier === 1 ? 550 : 450;
    const rot = rotate && i > 2 && i % 4 === 3 ? 90 : 0;
    const tw = measureText(s.label, size, weight) + PAD * 2;
    const th = size * 1.18 + PAD * 2;
    const bw = rot ? th : tw;
    const bh = rot ? tw : th;

    for (let t = 0; t < 4000; t += 1) {
      const a = t * 0.18;
      const r = 1.9 * a;
      /* 横向拉伸 1.7 倍: 画幅是宽的, 正圆螺线会先把上下撑满, 两侧留大片空白 */
      const x = cx + r * Math.cos(a) * 1.7;
      const y = cy + r * Math.sin(a);
      const box = { x0: x - bw / 2, y0: y - bh / 2, x1: x + bw / 2, y1: y + bh / 2 };
      if (box.x0 < 1 || box.x1 > W - 1 || box.y0 < 1 || box.y1 > H - 1) continue;
      const hit = placed.some((p) => !(box.x1 <= p.x0 || box.x0 >= p.x1 || box.y1 <= p.y0 || box.y0 >= p.y1));
      if (hit) continue;
      placed.push(box);
      out.push({ text: s.label, x, y, size, rot, tier, title: `${s.label}: ${s.value}${unit ? ` ${unit}` : ''}` });
      break;
    }
    /* 放不下就丢掉这个词 —— 挤进去会压到别人身上, 那比少一个词难看得多 (d3-cloud 同策略) */
  });
  return out;
}

const CloudChart: React.FC<{
  series: Array<{ label: string; value: number; tone?: string }>;
  unit: string;
  report?: boolean;
}> = ({ series, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = report ? Math.max(300, measuredW) : 480;
  const H = report ? Math.min(320, Math.max(200, Math.round(W / 2.4))) : 150;
  const fsScale = Math.min(1.15, Math.max(1, 12 / Math.max(series.length, 1)));
  const words = React.useMemo(
    () => layoutCloud(
      series, W, H,
      Math.round((report ? 13 : 11) * fsScale),
      Math.round((report ? 34 : 26) * fsScale),
      unit,
      !report,
    ),
    [series, W, H, report, unit, fsScale],
  );
  return (
    <div className="nchart__plot nchart__cloud" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="word cloud" preserveAspectRatio="xMidYMid meet">
        {words.map((w, i) => (
          <text
            key={i}
            className={`nchart__cloud-w nchart__cloud-w--t${w.tier}`}
            x={w.x} y={w.y}
            fontSize={w.size}
            textAnchor="middle"
            dominantBaseline="central"
            transform={w.rot ? `rotate(${w.rot} ${w.x} ${w.y})` : undefined}
          >
            {w.text}
            <title>{w.title}</title>
          </text>
        ))}
      </svg>
    </div>
  );
};


/** 山峰 / 漏斗 —— 同一套梯形堆叠, 差别只在"哪头宽" */
const StackChart: React.FC<{
  series: Array<{ label: string; value: number }>;
  unit: string;
  report?: boolean;
  shape: 'pyramid' | 'funnel';
}> = ({ series, unit, report = false, shape }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = report ? Math.max(300, measuredW) : 480;
  const rows = series.slice(0, 6);
  const n = Math.max(rows.length, 1);
  const bandH = report ? 46 : 30;
  const gap = report ? 5 : 3;
  const H = n * bandH + (n - 1) * gap + 10;
  /* 文字列占右边 42%, 图形占左边 —— 图形自己不塞字, 中文在窄梯形里必然挤 */
  const figW = Math.min(W * 0.5, report ? 360 : 240);
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const min = Math.max(...rows.map(() => 0), figW * 0.18);
  /* 每层的宽度: 山峰按层数线性收窄 (它讲的是层级), 漏斗按数值收窄 (它讲的是流失) */
  const widthAt = (i: number) => (shape === 'pyramid'
    ? min + (figW - min) * ((i + 1) / n)
    : min + (figW - min) * (Math.abs(rows[i].value) / max));
  const cx = figW / 2 + 4;
  return (
    <div className="nchart__plot nchart__stackfig" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={shape} preserveAspectRatio="xMidYMid meet">
        {rows.map((r, i) => {
          const y = 5 + i * (bandH + gap);
          const wTop = widthAt(i);
          const wBot = i + 1 < n ? widthAt(i + 1) : (shape === 'pyramid' ? widthAt(i) : min * 0.72);
          /* 山峰顶层收成尖角, 漏斗底层收成细口 —— 这一笔决定了"像不像那个形状" */
          const top = shape === 'pyramid' && i === 0 ? 2 : wTop;
          const d = `M${cx - top / 2},${y} L${cx + top / 2},${y} L${cx + wBot / 2},${y + bandH} L${cx - wBot / 2},${y + bandH} Z`;
          return (
            <g key={i}>
              <path d={d} fill={reportRamp(i, n)} className="nchart__stackfig-band" />
              {wrapLabel(r.label, W - (figW + 24) - 12, report ? 12 : 11).map((ln, li) => (
                <text
                  key={li} className="nchart__cat" x={figW + 24}
                  y={y + bandH / 2 - 9 + li * 14} dominantBaseline="central"
                >
                  {ln}
                </text>
              ))}
              <text className="nchart__col-val" x={figW + 24} y={y + bandH / 2 + 19} dominantBaseline="central">
                {fmtNum(r.value)}{unit ? ` ${unit}` : ''}
              </text>
              <title>{`${r.label}: ${r.value}${unit ? ' ' + unit : ''}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/** 靶心 —— 同心圆, 外圈是最外层的范围, 圆心是最终目标 */
const TargetChart: React.FC<{
  series: Array<{ label: string; value: number }>;
  unit: string;
  report?: boolean;
}> = ({ series, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = report ? Math.max(300, measuredW) : 480;
  const rows = series.slice(0, 5);
  const n = Math.max(rows.length, 1);
  const H = report ? 230 : 150;
  const R = Math.min(H / 2 - 8, report ? 104 : 66);
  const cx = R + 12;
  const cy = H / 2;
  return (
    <div className="nchart__plot nchart__targetfig" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="target" preserveAspectRatio="xMidYMid meet">
        {rows.map((r, i) => {
          /* 半径按层等距收 —— 靶心图讲的是"由外到内的收敛", 不是面积比例 */
          const rad = R * (1 - i / n);
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={rad} fill={reportRamp(i, n)} className="nchart__targetfig-ring" />
              <title>{`${r.label}: ${r.value}${unit ? ' ' + unit : ''}`}</title>
            </g>
          );
        })}
        {(() => {
          const fs = report ? 12 : 11;
          const maxW = W - (cx + R + 38) - 12;
          const lines = rows.map((r) => wrapLabel(r.label, maxW, fs));
          const LINE_H = 15;
          const VAL_H = 17;
          const GAP = 10;
          const heights = lines.map((ls) => ls.length * LINE_H + VAL_H);
          const total = heights.reduce((a, b) => a + b, 0) + GAP * (rows.length - 1);
          let top = cy - total / 2;
          return rows.map((r, i) => {
            const y0 = top;
            top += heights[i] + GAP;
            return (
              <g key={`l${i}`}>
                <circle cx={cx + R + 26} cy={y0 + 6} r={4.5} fill={reportRamp(i, n)} />
                {lines[i].map((ln, li) => (
                  <text
                    key={li} className="nchart__cat" x={cx + R + 38}
                    y={y0 + 6 + li * LINE_H} dominantBaseline="central"
                  >
                    {ln}
                  </text>
                ))}
                <text
                  className="nchart__col-val" x={cx + R + 38}
                  y={y0 + 6 + lines[i].length * LINE_H} dominantBaseline="central"
                >
                  {fmtNum(r.value)}{unit ? ` ${unit}` : ''}
                </text>
              </g>
            );
          });
        })()}
      </svg>
    </div>
  );
};

/** 河流 —— 一条宽度随数值变化的带子, 讲"一路走下来剩下多少" */
const RiverChart: React.FC<{
  series: Array<{ label: string; value: number }>;
  unit: string;
  report?: boolean;
}> = ({ series, unit, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = report ? Math.max(300, measuredW) : 480;
  const H = report ? 210 : 130;
  const rows = series.slice(0, 8);
  const n = Math.max(rows.length, 1);
  const PAD_L = 16;
  const PAD_R = 16;
  const PAD_B = report ? 40 : 26;
  const plotW = W - PAD_L - PAD_R;
  const midY = (H - PAD_B) / 2 + 6;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const maxBand = (H - PAD_B) * 0.62;
  const step = n > 1 ? plotW / (n - 1) : 0;
  const pt = (i: number) => ({
    x: PAD_L + i * step,
    h: Math.max(4, (Math.abs(rows[i].value) / max) * maxBand),
  });
  /* 上下缘各走一条平滑曲线 (三次贝塞尔, 控制点取半步) —— 折线会让"河"看着像折纸 */
  const edge = (sign: 1 | -1) => rows.map((_, i) => {
    const { x, h } = pt(i);
    const y = midY + sign * (h / 2);
    if (i === 0) return `M${x},${y}`;
    const p0 = pt(i - 1);
    const y0 = midY + sign * (p0.h / 2);
    const cxm = (p0.x + x) / 2;
    return `C${cxm},${y0} ${cxm},${y} ${x},${y}`;
  }).join(' ');
  const back = [...rows].map((_, i) => n - 1 - i).map((i, k) => {
    const { x, h } = pt(i);
    const y = midY + (h / 2);
    if (k === 0) return `L${x},${y}`;
    const nx = pt(i + 1);
    const y0 = midY + (nx.h / 2);
    const cxm = (nx.x + x) / 2;
    return `C${cxm},${y0} ${cxm},${y} ${x},${y}`;
  }).join(' ');
  return (
    <div className="nchart__plot nchart__riverfig" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="river" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="nx-river" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--nchart-c1)" />
            <stop offset="100%" stopColor="color-mix(in srgb, var(--nchart-c1) 45%, var(--neox-bg-card, #fff))" />
          </linearGradient>
        </defs>
        <path d={`${edge(-1)} ${back} Z`} fill="url(#nx-river)" className="nchart__riverfig-band" />
        {rows.map((r, i) => {
          const { x, h } = pt(i);
          return (
            <g key={i}>
              <line className="nchart__grid" x1={x} y1={midY - h / 2 - 6} x2={x} y2={midY + h / 2 + 6} />
              <text className="nchart__col-val" x={x} y={midY + h / 2 + 18} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
                {fmtNum(r.value)}{unit ? ` ${unit}` : ''}
              </text>
              {wrapLabel(r.label, Math.max(60, step - 10), report ? 12 : 11).map((ln, li) => (
                <text
                  key={li} className="nchart__cat" x={x}
                  y={midY + h / 2 + 34 + li * 14}
                  textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                >
                  {ln}
                </text>
              ))}
              <title>{`${r.label}: ${r.value}${unit ? ' ' + unit : ''}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/* 横条图 — 长标签 / 多条目走这条. 条内嵌数值, 右侧不再单开一列 */
const HBarChart: React.FC<{
  series: Array<{ label: string; value: number; tone?: string }>;
  unit: string;
  report?: boolean;
}> = ({ series, unit, report = false }) => {
  const max = Math.max(1, ...series.map((s) => Math.abs(s.value)));
  const asideUnit = unit.length > 4 ? unit : '';
  const inlineUnit = asideUnit ? '' : unit;
  return (
    <div className={`nchart__bars${report ? ' nchart__bars--report' : ''}`}>
      {asideUnit && <div className="nchart__bars-unit">{asideUnit}</div>}
      {series.map((s, i) => {
        const pct = (Math.abs(s.value) / max) * 100;
        return (
          <div key={i} className="nchart__bar-row" title={`${s.label}: ${s.value}${unit ? ' ' + unit : ''}`}>
            <span className="nchart__bar-lbl">{s.label || '—'}</span>
            <span className="nchart__bar-track">
              <i className="nchart__bar-fill" style={{ width: `${Math.max(pct, 1.5)}%`, background: seriesColor(s.tone) }} />
            </span>
            <span className="nchart__bar-val">{fmtNum(s.value)}{inlineUnit ? ` ${inlineUnit}` : ''}</span>
          </div>
        );
      })}
    </div>
  );
};

const LineChart: React.FC<{
  series: Array<{ label: string; value: number }>;
  unit: string;
  area?: boolean;
  /** 报告画幅 —— 见 ChartData.size */
  report?: boolean;
}> = ({ series, unit, area = true, report = false }) => {
  const [plotRef, measuredW] = usePlotWidth(480);
  const W = report ? Math.max(300, measuredW) : 480;
  const H = report ? Math.min(330, Math.max(200, Math.round(W / 2.4))) : 104;
  const PAD_L = report ? 46 : 34;
  const PAD_R = report ? 14 : 8;
  const PAD_T = report ? 20 : 12;
  const PAD_B = report ? 34 : 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const vals = series.map((s) => s.value);
  const [min, max] = niceDomain(vals);
  const span = max - min || 1;
  const step = series.length > 1 ? plotW / (series.length - 1) : 0;
  const pts = vals.map((v, i): [number, number] => [
    PAD_L + i * step,
    PAD_T + (1 - (v - min) / span) * plotH,
  ]);
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaD = pts.length
    ? `${d} L${pts[pts.length - 1][0].toFixed(1)},${PAD_T + plotH} L${PAD_L},${PAD_T + plotH} Z`
    : '';
  const ticks = report ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  /* 标签太密就抽样, 只画首/中/尾 */
  const labelEvery = series.length > 7 ? Math.ceil(series.length / 5) : 1;
  const ptFs = report ? 12 : 10;
  const ptLabels = series.map((s) => fmtNum(s.value));
  const showPtVals = report && series.length > 1
    && ptLabels.every((t) => measureText(t, ptFs, 500) <= step - 8);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const deltaPct = report && vals.length > 1 && first !== 0
    ? Math.round(((last - first) / Math.abs(first)) * 100)
    : null;
  return (
    <div className="nchart__plot" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="line chart" preserveAspectRatio="xMidYMid meet">
        {deltaPct !== null && Math.abs(deltaPct) >= 1 && (
          <text className="nchart__delta" x={W - PAD_R} y={13} textAnchor="end">
            {`${deltaPct > 0 ? '+' : ''}${deltaPct}%`}
          </text>
        )}
        {ticks.map((f, i) => {
          const y = PAD_T + (1 - f) * plotH;
          return (
            <g key={i}>
              <line className="nchart__grid" x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} />
              <text className="nchart__tick" x={PAD_L - 5} y={y + 3} textAnchor="end">{fmtNum(min + span * f)}</text>
            </g>
          );
        })}
        {area && areaD && <path d={areaD} className="nchart__line-area" />}
        <path d={d} className="nchart__line-path" />
        {pts.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={report ? 3.6 : 2.6} className="nchart__line-dot" />
            {showPtVals && (
              /* 首尾两个点贴着画幅边缘, 居中对齐会被切掉半个数 —— 各自向内对齐 */
              <text
                className="nchart__col-val" x={x} y={y - 10}
                textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
              >
                {ptLabels[i]}
              </text>
            )}
            <title>{`${series[i].label}: ${series[i].value}${unit}`}</title>
          </g>
        ))}
        {series.map((s, i) => (i % labelEvery === 0 || i === series.length - 1) ? (
          <text key={i} className="nchart__cat" x={PAD_L + i * step} y={H - 7} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>
            {s.label.length > 8 ? s.label.slice(0, 7) + '…' : s.label}
          </text>
        ) : null)}
      </svg>
    </div>
  );
};

const PieChart: React.FC<{
  series: Array<{ label: string; value: number; tone?: string }>;
  donut: boolean;
  unit: string;
  /** 报告画幅: 同色系明暗 + 切片之间留缝 (见 reportRamp) */
  report?: boolean;
}> = ({ series, donut, unit, report = false }) => {
  const total = series.reduce((s, x) => s + Math.abs(x.value), 0) || 1;
  const R = 42, C = 50;
  let acc = 0;
  const arcs = series.map((s, i) => {
    const frac = Math.abs(s.value) / total;
    const a0 = acc * 2 * Math.PI - Math.PI / 2;
    acc += frac;
    const a1 = acc * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    /* 单值 100% 时起终点重合, path 画不出圆 — 退化成整圆 */
    const d = frac >= 0.999
      ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} Z`
      : `M${C},${C} L${(C + R * Math.cos(a0)).toFixed(2)},${(C + R * Math.sin(a0)).toFixed(2)} `
        + `A${R},${R} 0 ${large} 1 ${(C + R * Math.cos(a1)).toFixed(2)},${(C + R * Math.sin(a1)).toFixed(2)} Z`;
    return {
      d,
      color: s.tone ? colorAt(i, s.tone) : (report ? reportRamp(i, series.length) : colorAt(i)),
      frac,
      label: s.label,
      value: s.value,
    };
  });
  return (
    <div className="nchart__pie">
      <div className="nchart__pie-box">
        <svg viewBox="0 0 100 100" className="nchart__pie-svg" role="img" aria-label="pie chart">
          {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} className="nchart__pie-slice" />)}
          {donut && <circle cx={C} cy={C} r={R * 0.6} className="nchart__pie-hole" />}
        </svg>
        {donut && unit.replace(/\s/g, '') !== '%' && (
          <div className="nchart__pie-center">
            <span className="nchart__pie-total">{fmtNum(total)}</span>
            <span className="nchart__pie-total-lbl">{unit || '总计'}</span>
          </div>
        )}
      </div>
      <ul className="nchart__legend">
        {arcs.map((a, i) => (
          <li key={i}>
            <i style={{ background: a.color }} aria-hidden />
            <span className="nchart__legend-lbl" title={a.label}>{a.label || '—'}</span>
            <span className="nchart__legend-val">{fmtNum(a.value)}{unit} · {Math.round(a.frac * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* 环形完成度 — "36 个问题里修了 12 个" 这种最常见的报告数字 */
const GaugeChart: React.FC<{ series: Array<{ label: string; value: number; tone?: string }>; unit: string; max: number }> = ({ series, unit, max }) => {
  const items = series.slice(0, 4);
  return (
    <div className="nchart__gauges">
      {items.map((s, i) => {
        const denom = max || 100;
        const frac = Math.max(0, Math.min(1, Math.abs(s.value) / denom));
        const R = 26, C = 32, circ = 2 * Math.PI * R;
        /* 一排 gauge 是同一个度量的小多图, 不是不同类别 —— 各自带标签, 颜色不编码信息 */
        const color = seriesColor(s.tone);
        return (
          <div key={i} className="nchart__gauge" title={`${s.label}: ${s.value}${unit} / ${denom}`}>
            <svg viewBox="0 0 64 64" width="64" height="64" role="img" aria-label={`${s.label} gauge`}>
              <circle cx={C} cy={C} r={R} className="nchart__gauge-track" />
              <circle
                cx={C} cy={C} r={R}
                className="nchart__gauge-fill"
                stroke={color}
                strokeDasharray={`${(circ * frac).toFixed(2)} ${circ.toFixed(2)}`}
                transform={`rotate(-90 ${C} ${C})`}
              />
              <text x={C} y={C + 4} textAnchor="middle" className="nchart__gauge-val">{Math.round(frac * 100)}%</text>
            </svg>
            <span className="nchart__gauge-lbl">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
};

/* 构成条 — 每组一条, 内部按段着色 (P0/P1/P2 分布、PASS/FAIL 构成) */
const StackedChart: React.FC<{ groups: Array<{ label?: string; parts?: ChartPoint[] }>; unit: string }> = ({ groups, unit }) => {
  const norm = groups.map((g) => ({
    label: String(g.label ?? ''),
    parts: (Array.isArray(g.parts) ? g.parts : []).map((p) => ({ label: String(p.label ?? ''), value: Math.abs(numOf(p.value)), tone: p.tone })),
  }));
  const max = Math.max(1, ...norm.map((g) => g.parts.reduce((s, p) => s + p.value, 0)));
  const legend: Array<{ label: string; color: string }> = [];
  norm.forEach((g) => g.parts.forEach((p, i) => {
    if (!legend.some((l) => l.label === p.label)) legend.push({ label: p.label, color: colorAt(i, p.tone) });
  }));
  return (
    <div className="nchart__stack">
      {norm.map((g, i) => {
        const total = g.parts.reduce((s, p) => s + p.value, 0);
        return (
          <div key={i} className="nchart__stack-row">
            <span className="nchart__bar-lbl">{g.label || '—'}</span>
            <span className="nchart__stack-track">
              {g.parts.map((p, j) => (
                <i
                  key={j}
                  className="nchart__stack-seg"
                  style={{ width: `${(p.value / max) * 100}%`, background: colorAt(j, p.tone) }}
                  title={`${p.label}: ${p.value}${unit}`}
                />
              ))}
            </span>
            <span className="nchart__bar-val">{fmtNum(total)}{unit}</span>
          </div>
        );
      })}
      {legend.length > 1 && (
        <ul className="nchart__legend nchart__legend--inline">
          {legend.map((l, i) => (
            <li key={i}><i style={{ background: l.color }} aria-hidden /><span className="nchart__legend-lbl">{l.label || '—'}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
};

/* 热力矩阵 — "Agent × 场景" 这种二维密度. 值越大主色越浓 */
const HeatmapChart: React.FC<{ columns: string[]; rows: Array<{ label?: string; values?: Array<number | string> }>; unit: string }> = ({ columns, rows, unit }) => {
  const norm = rows.map((r) => ({
    label: String(r.label ?? ''),
    values: (Array.isArray(r.values) ? r.values : []).map(numOf),
  }));
  const max = Math.max(1, ...norm.flatMap((r) => r.values.map(Math.abs)));
  const cols = columns.length ? columns : norm[0]?.values.map((_, i) => `C${i + 1}`) ?? [];
  return (
    <div className="nchart__heat" style={{ ['--nheat-cols' as string]: cols.length }}>
      <div className="nchart__heat-row nchart__heat-row--head">
        <span className="nchart__heat-rlbl" />
        {cols.map((c, i) => <span key={i} className="nchart__heat-clbl" title={c}>{c}</span>)}
      </div>
      {norm.map((r, i) => (
        <div key={i} className="nchart__heat-row">
          <span className="nchart__heat-rlbl" title={r.label}>{r.label || '—'}</span>
          {cols.map((c, j) => {
            const v = r.values[j] ?? 0;
            const f = Math.abs(v) / max;
            return (
              <span
                key={j}
                className="nchart__heat-cell"
                /* 强度区间拉到 5%→92%: 有些主题包 (墨夜) 的 primary 是低彩度文字色,
                   区间窄了几档密度在暗底上肉眼分不出来 */
                style={{ background: `color-mix(in srgb, var(--neox-primary-500, #4f7cff) ${Math.round(5 + f * 87)}%, transparent)` }}
                title={`${r.label} · ${c}: ${v}${unit}`}
              >{f > 0.001 ? fmtNum(v) : ''}</span>
            );
          })}
        </div>
      ))}
    </div>
  );
};
