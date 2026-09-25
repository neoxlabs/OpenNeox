import type { Slide } from '@neoxlabs/pptx-renderer';
import type { ComposeNode } from '../compose/types.js';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, activeSpec, contentBounds } from './theme.js';
import { mixHex, nothing, withAlpha, seriesPalette, dividerMotif } from './motif-bits.js';

const FLOOR_Y = 596;

function thousands(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const [i, d] = String(Number(v.toFixed(2))).split('.');
  return i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? `.${d}` : '');
}

function editorialColumns(slide: Slide, slots: ChartFocusSlots) {
  const t = activeTheme();
  const W = 1280;
  const H = 720;
  const data = (slots.data ?? []).map((d) => ({
    label: d.label,
    value: d.value == null || Number.isNaN(Number(d.value)) ? null : Number(d.value),
    note: (d as { note?: string }).note,
  }));
  const max = Math.max(1, ...data.map((d) => d.value ?? 0));

  /* 地面带: 通栏出血, 从柱底一直铺到页底 —— 柱子"站"在它上面, 页脚也落在它里面 */
  render(slide, ZStack({ align: 'start', width: W, height: H }, [
    Shape({ geometry: 'rect', width: W, height: H - FLOOR_Y, fill: t.surface, padding: { top: FLOOR_Y, left: 0, right: 0, bottom: 0 } }),
  ]), { bounds: { x: 0, y: 0, width: W, height: H }, assertNoOverlap: false, fit: false });

  const b = { x: 72, y: 56, width: W - 144, height: FLOOR_Y - 56 };
  const LEFT_W = 330;
  const GAP = 48;
  const n = data.length;
  const plotW = b.width - LEFT_W - GAP;
  const barW = Math.max(56, Math.min(128, Math.floor(plotW / Math.max(1, n))));
  const dark = t.accent;
  const light = mixHex(t.accent, t.paper, 0.58);

  const bars = data.map((d, i) => {
    if (d.value == null) return VStack({ width: barW }, []);
    const f = Math.max(0.015, d.value / (max * 1.22));
    const ann = VStack({ gap: 3, align: 'center' }, [
      Text(`${thousands(d.value)}${slots.unit ?? ''}`, {
        fontSize: 17, bold: true, color: t.ink, singleLine: true, textAlign: 'ctr',
        fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      }),
      Text(d.label, {
        fontSize: 11, color: t.muted, singleLine: true, textAlign: 'ctr', letterSpacingPt: 0.3,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }),
      d.note
        ? Text(d.note, {
            fontSize: 10, color: mixHex(t.muted, t.paper, 0.3), singleLine: true, textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
    ]);
    return VStack({ width: barW, align: 'stretch' }, [
      VStack({ flex: 1 - f, align: 'center', justify: 'end', padding: { top: 0, left: 0, right: 0, bottom: 12 } }, [ann]),
      /* 深浅交替: 相邻两根一深一浅, 柱子并排不留缝也分得清边界 */
      Shape({ geometry: 'rect', flex: f, fill: i % 2 === 0 ? dark : light, alignSelf: 'stretch' }),
    ]);
  });

  const left = VStack({ width: LEFT_W, gap: 16, align: 'start' }, [
    slots.kicker
      ? Text(slots.kicker, {
          fontSize: 13, bold: true, color: t.accent, letterSpacingPt: 2.4, uppercase: true,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : nothing(),
    slots.title
      ? Text(slots.title, {
          fontSize: 38, bold: true, color: t.ink, letterSpacingPt: -0.3,
          fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        })
      : nothing(),
    slots.title ? dividerMotif(64, 16) : nothing(),
    slots.note
      ? Text(slots.note, {
          /* 16pt: 这是正文段落, 自检的正文下限就是 16 (15 会被判必修) */
          fontSize: 16, color: t.muted, lineHeightPt: 27,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          padding: { top: 8, left: 0, right: 0, bottom: 0 },
        })
      : nothing(),
    slots.unit
      ? Text(`(${slots.unit})`, {
          fontSize: 11, color: t.muted,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : nothing(),
  ]);

  render(slide,
    HStack({ width: b.width, height: b.height, align: 'stretch', gap: GAP }, [
      left,
      HStack({ flex: 1, align: 'stretch', justify: 'center', gap: 0 }, bars),
    ]),
    { bounds: b },
  );
}

export interface ChartFocusSlots {
  kicker?: string;
  title?: string;
  chartType?: 'bar' | 'column' | 'line' | 'stacked';
  /** 单系列 (最常见)。多系列时忽略, 改用 categories + series */
  data?: Array<{ label: string; value: number | null }>;
  /** 多系列的类目轴 (X 轴上的那些名字) */
  categories?: string[];
  /**
   * 多系列。values 按 categories 顺序对齐。
   * **缺数据用 null, 不要用 0** —— 0 是"这一格的值是零", null 是"这一格没有数据",
   * 画法完全不同 (见下面 toNum 的注释)。长度不足的尾部按缺失处理。
   */
  series?: Array<{ name: string; values: Array<number | null> }>;
  unit?: string;
  variant?: 'standard' | 'editorial';
  /** editorial 左栏标题下的一句结论 (图讲"是什么", 这句讲"所以呢") */
  note?: string;
}


/** "好看的"步长: 1 / 2 / 2.5 / 5 × 10^k —— 轴上出现 37.5 这种数就是没做完 */
function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

/* 柱顶数值标签需要的净空, 按轴跨度的比例算。
 * 标签是 14pt 粗体 (~24px) + 6px 间距 ≈ 30px, 而绘图区高度在 300~380px 之间,
 * 所以 0.11 ≈ 刚好放得下一行标签。 */
const LABEL_HEADROOM = 0.11;

function niceTicks(min: number, max: number, target = 4, labelHeadroom = false): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === 0 && hi === 0) return [0, 1];
  const step = niceStep(hi - lo || Math.abs(hi) || 1, target);
  let bottom = Math.floor(lo / step) * step;
  let top = Math.ceil(hi / step) * step;
  if (hi > 0 && hi === top) top += step;
  if (lo < 0 && lo === bottom) bottom -= step;
  if (labelHeadroom) {
    const span0 = () => (top - bottom) || 1;
    if (hi > 0 && (top - hi) / span0() < LABEL_HEADROOM) top += step;
    if (lo < 0 && (lo - bottom) / span0() < LABEL_HEADROOM) bottom -= step;
  }
  const out: number[] = [];
  for (let v = bottom; v <= top + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const TICK_PT = 12;
/* 刻度行的高度 = 字号 × 行高系数, 换算成 px。用它做绘图区的上下内缩:
 * 网格线在自己那一行里垂直居中, 所以首/末两条线各自离绘图区边缘半行 —— 柱子
 * 必须缩同样多才能压在零线上。这是算出来的, 不是试出来的魔数。 */
const TICK_ROW_HALF = Math.round((TICK_PT * 1.4 * (96 / 72)) / 2);
const AXIS_W = 56;
const AXIS_GAP = 10;

export function chartFocus(slide: Slide, slots: ChartFocusSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const chartType = slots.chartType ?? 'column';

  /* editorial 只接得住"单系列 · 柱状 · 全非负": 负值需要零线在中间, 多系列需要图例和分组 ——
   * 那两种场合刻度轴不是多余的, 硬套杂志画法就是在丢信息。不满足就走标准画法, 不报错。 */
  const single = !(Array.isArray(slots.series) && slots.series.length > 0);
  const nonNeg = (slots.data ?? []).every((d) => d.value == null || Number(d.value) >= 0);
  const wantEditorial = slots.variant === 'editorial'
    || (slots.variant == null && !!activeSpec()?.ornament);
  if (wantEditorial && single && chartType === 'column' && nonNeg && (slots.data ?? []).length > 0) {
    editorialColumns(slide, slots);
    return;
  }

  /* ── 归一化: 单系列是多系列的特例 ──────────────────────────────
   * 与其为多系列另写一套, 不如把单系列 data 也折成 "1 个 series" ——
   * 一条代码路径, 单系列的行为就不会在加多系列时被改坏 (这是这轮最大的风险:
   * 单系列已经验证过刻度/负值/面积闭合, 不能因为加功能而回退)。 */
  /* 缺失 = null。**不能拿 0 冒充** —— 折线上 0 会画成"这一期掉到零", 柱状图上
   * 会画成"这一项是零"。跟当初把负值压成零是同一类错: 图形在陈述一个事实,
   * 而那个事实是假的。缺失就该断开/不画, 让人看见"这里没有数据"。 */
  const toNum = (v: unknown): number | null =>
    (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
  const isMulti = Array.isArray(slots.series) && slots.series.length > 0;
  const cats: string[] = isMulti
    ? (slots.categories ?? [])
    : (slots.data ?? []).map((d) => d.label);
  const seriesList: Array<{ name: string; values: Array<number | null> }> = isMulti
    ? slots.series!.map((s) => ({
        name: s.name,
        /* 按 categories 对齐, 缺的补 0 —— 系列长度不齐是最常见的输入错误,
         * 与其抛异常不如画出来, 让人一眼看见"这一格没有数据"。 */
        values: cats.map((_, i) => toNum(s.values?.[i])),
      }))
    : [{ name: '', values: (slots.data ?? []).map((d) => toNum(d.value)) }];
  const stacked = chartType === 'stacked';
  const seriesColors = seriesList.length > 1 ? seriesPalette(seriesList.length) : [t.accent];

  /* 堆叠图的轴要容纳**每个类目的正数之和 / 负数之和**, 不是单个值的极值 */
  const axisSamples: number[] = stacked
    ? cats.flatMap((_, i) => {
        let pos = 0, neg = 0;
        for (const s of seriesList) { const v = s.values[i]; if (v == null) continue; if (v >= 0) pos += v; else neg += v; }
        return [pos, neg];
      })
    : seriesList.flatMap((s) => s.values.filter((v): v is number => v != null));
  const values = axisSamples.length ? axisSamples : [0];
  /* 单系列才画柱顶数值标签 (见 oneBar 的 showLabel), 也只有它需要给标签留净空 */
  const ticks = niceTicks(Math.min(...values, 0), Math.max(...values, 0), 4, !isMulti);
  const axisTop = ticks[ticks.length - 1]!;
  const axisBottom = ticks[0]!;
  const axisSpan = (axisTop - axisBottom) || 1;
  const hasNegative = axisBottom < 0;
  /* 一个值在轴上占的比例 (0~1, 从轴底算起) */
  const frac = (v: number) => (v - axisBottom) / axisSpan;
  const zeroFrac = frac(0);

  const gridColor = mixHex(t.paper, t.ink, 0.14);
  const zeroColor = mixHex(t.paper, t.ink, 0.42);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

  /* ── 网格层 ────────────────────────────────────────────────
   * 刻度值和网格线放在**同一个 HStack 行**里, 于是两者天然对齐 ——
   * 分成两列各自 spaceBetween 的话, 文字和线永远差半行, 越到两端差得越明显。 */
  const gridRows = [...ticks].reverse().map((v) => {
    /* 零线要比网格线重 —— 它是所有柱子的基准, 和"参考线"不是一个身份。
     * 有负值时零线不在最底下, 所以判据是"这条刻度是不是 0", 不是"是不是最后一条"。 */
    const isZero = Math.abs(v) < 1e-9;
    return HStack({ align: 'center', gap: AXIS_GAP }, [
      Text(fmt(v), {
        fontSize: TICK_PT, color: t.muted, width: AXIS_W, textAlign: 'r', singleLine: true,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      }),
      Shape({
        geometry: 'rect', height: isZero ? 2 : 1, flex: 1,
        fill: isZero ? zeroColor : gridColor,
      }),
    ]);
  });

  const grid = VStack({ align: 'stretch', justify: 'spaceBetween', flex: 1 }, gridRows);

  /* ── 柱层 ──────────────────────────────────────────────────
   * 高度按 flex 分配: 一根柱子 = VStack{ 空白 flex:(1-r) · 实体 flex:r },
   * 于是柱高严格等于绘图区高度 × 比例, 版面给多少高度就用多少 —— 不再写死 320。
   * 比例用 axisTop (刻度顶) 而不是 maxVal: 最高的柱子顶到刻度顶而不是顶到天花板,
   * 读数才对得上轴。 */
  const EPS = 0.0005;
  const seg = (f: number) => Math.max(EPS, f);
  /* 负值用比 accent 深一档的色 —— 正负同色的话, 观众得先找零线才知道方向。
   * 不用红/绿: 那是涨跌语义, 这里的负可能是"成本下降"这种好事。 */
  const negColor = mixHex(t.accent, t.ink, 0.45);

  /** 一根柱子 —— 四段结构, 正负同构。多系列时不标数值 (见下方注释)。 */
  const oneBar = (raw: number | null, color: string, showLabel: boolean, width?: number): ComposeNode => {
    /* 缺失: 整格留空, 不画柱也不标 0 —— "没有数据"和"数据是零"必须看得出区别 */
    if (raw == null) return VStack({ flex: 1 }, []);
    const v = raw;
    const topBlank = 1 - frac(Math.max(v, 0));
    const posBar = frac(Math.max(v, 0)) - zeroFrac;
    const negBar = zeroFrac - frac(Math.min(v, 0));
    const botBlank = frac(Math.min(v, 0));
    const label = Text(`${fmt(v)}${slots.unit ?? ''}`, {
      fontSize: 14, bold: true, color: t.ink, textAlign: 'ctr', singleLine: true,
      fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
      padding: v >= 0
        ? { top: 0, left: 0, right: 0, bottom: 6 }
        : { top: 6, left: 0, right: 0, bottom: 0 },
    });
    const shapeOf = (flex: number, fill: string) => (width != null
      ? Shape({ geometry: 'rect', width, flex, fill, cornerRadius: 4, alignSelf: 'center' })
      : Shape({ geometry: 'rect', flex, fill, cornerRadius: 4, alignSelf: 'stretch' }));
    return VStack({ flex: 1, align: 'center' }, [
      /* 数值标签跟着柱子的方向走: 正柱标在上方, 负柱标在下方 —— 标签压在柱子里
       * 会被柱色吃掉, 标在反方向又读不出是谁的。 */
      VStack({ flex: seg(topBlank), align: 'center', justify: 'end' }, showLabel && v >= 0 ? [label] : []),
      /* 值**正好是 0** 时留一条 3px 的桩。零高度的柱子等于什么都不画, 于是
       * "这一项是零"和"这一项没数据"在图上长得一模一样 —— 补 null 之后才暴露出来的
       * 第二重歧义。留个桩, 零就有了自己的形状。 */
      v === 0
        ? Shape({ geometry: 'rect', width: width ?? 40, height: 3, fill: color, alignSelf: 'center' })
        : nothing(),
      posBar > EPS ? shapeOf(posBar, color) : nothing(),
      negBar > EPS ? shapeOf(negBar, showLabel ? negColor : mixHex(color, t.ink, 0.4)) : nothing(),
      VStack({ flex: seg(botBlank), align: 'center', justify: 'start' }, showLabel && v < 0 ? [label] : []),
    ]);
  };

  /** 堆叠柱: 一个类目里各系列首尾相接。正的往上垒, 负的往下垒。 */
  const stackedCell = (ci: number): ComposeNode => {
    const posSegs: ComposeNode[] = [];
    const negSegs: ComposeNode[] = [];
    let posSum = 0, negSum = 0;
    seriesList.forEach((s, si) => {
      const v = s.values[ci];
      if (v == null) return;             /* 缺失: 这一段不堆 */
      const f = Math.abs(v) / axisSpan;
      if (f <= EPS) return;
      const node = Shape({ geometry: 'rect', width: 96, flex: f, fill: seriesColors[si]!, alignSelf: 'center' });
      if (v >= 0) { posSegs.unshift(node); posSum += v; } else { negSegs.push(node); negSum += v; }
    });
    /* 合计标在柱顶 —— **"合计也有意义"正是选堆叠而不是分组的唯一理由**,
     * 不把合计显示出来, 这个选择就白做了 (观众得自己把几段加起来)。
     * 有负值时同时有正负两个和, 只标正的那侧, 免得一根柱子挂两个数反而糊。 */
    const totalText = Math.abs(posSum) > EPS
      ? Text(`${fmt(Number(posSum.toFixed(2)))}${slots.unit ?? ''}`, {
          fontSize: 14, bold: true, color: t.ink, textAlign: 'ctr', singleLine: true,
          fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
          padding: { top: 0, left: 0, right: 0, bottom: 6 },
        })
      : nothing();
    return VStack({ flex: 1, align: 'stretch' }, [
      VStack({ flex: seg(1 - frac(posSum)), align: 'center', justify: 'end' }, [totalText]),
      ...posSegs,
      ...negSegs,
      VStack({ flex: seg(frac(negSum)) }, []),
    ]);
  };

  /* 多系列不标每根柱子的数值: k 个系列 × m 个类目, 数字会糊成一片, 而且
   * 图例 + 刻度轴已经够读了。单系列才标 —— 那时候空间足够, 标了更快。 */
  const columns = cats.map((_, ci) => {
    if (stacked) return stackedCell(ci);
    if (!isMulti) return oneBar(seriesList[0]!.values[ci] ?? null, t.accent, true, 64);
    /* 分组柱: 同一类目里各系列并排, 柱宽交给 flex —— 系列多了自动变窄,
     * 不需要知道格子有多宽 (和折线用同一套"不算像素"的思路)。 */
    return HStack({ flex: 1, align: 'stretch', gap: 6, padding: { top: 0, left: 10, right: 10, bottom: 0 } },
      seriesList.map((s, si) => oneBar(s.values[ci] ?? null, seriesColors[si]!, false)));
  });

  const barLayer = HStack({
    align: 'stretch', justify: 'spaceEvenly', flex: 1,
    /* 左边让开刻度列; 上下各缩半行, 让柱底正好压在零线上 (见 TICK_ROW_HALF) */
    padding: { top: TICK_ROW_HALF, left: AXIS_W + AXIS_GAP, right: 0, bottom: TICK_ROW_HALF },
  }, columns);

  /* 类目标签单独一行 —— 放进柱子里的话, 标签一换行整根柱子就跟着变矮, 柱高
   * 就不再只由数值决定 (图表最不能容忍的事)。 */
  const catRow = HStack({
    align: 'start', justify: 'spaceEvenly',
    padding: { top: 10, left: AXIS_W + AXIS_GAP, right: 0, bottom: 0 },
  }, cats.map((c) => Text(c, {
    fontSize: 12, color: t.muted, textAlign: 'ctr', flex: 1,
    fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
  })));

  /* ── 折线层 ────────────────────────────────────────────────
   * 【为什么必须有折线】趋势类内容 (逐月、逐季) 用柱子表达是**语义错误**:
   * 柱子表达"离散类目之间的比较", 折线表达"同一个量随时间怎么走"。
   * 一份汇报里最常见的就是趋势, 而这个引擎之前只能画柱子。
   *
   * 实现上的关键: 折线要精确落在绘图区里, 但模板拿不到绘图区的像素尺寸。
   * 解法是把路径画在**数据坐标系** (1000×1000 viewBox) 里, 交给 custGeom 缩放 ——
   * viewBox 本来就会被拉伸到形状框, 而折线图正是可以非等比缩放的东西
   * (它是坐标图, 不是图标)。描边宽度走 <a:ln w>, 是绝对值, 不跟着拉伸变形。
   *
   * x 取每格中心 (i+0.5)/n —— 和下面用 spaceEvenly 排的数据点、类目标签同一个
   * 位置公式, 三者才对得齐。 */
  const n = cats.length;
  const VB = 1000;
  const px = (i: number) => ((i + 0.5) / Math.max(1, n)) * VB;
  const py = (v: number) => (1 - frac(v)) * VB;
  const zeroY = (py(0)).toFixed(1);
  /* 缺失处**断开折线**, 不要连过去 —— 连过去等于声称"中间是线性变化的",
   * 而我们并不知道。把一条线切成若干段, 每段是一条独立的 M...L... 子路径。 */
  const segsOf = (vals: Array<number | null>): string[][] => {
    const out: string[][] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v == null) { if (cur.length) out.push(cur); cur = []; return; }
      cur.push(`${px(i).toFixed(1)} ${py(v).toFixed(1)}`);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const pathOf = (vals: Array<number | null>) =>
    segsOf(vals).filter((sgs) => sgs.length > 1).map((sgs) => `M${sgs.join(' L')}`).join(' ');

  const plotInset = { top: TICK_ROW_HALF, left: AXIS_W + AXIS_GAP, right: 0, bottom: TICK_ROW_HALF };

  const lineLayers: ComposeNode[] = n === 0 ? [] : [
    /* 面积只在单系列时铺 —— 多条半透明面积叠在一起会糊成一团, 反而看不出哪条是哪条。
     * 面积回落到**零线**而不是版底: 有负值时零线在中间, 落到版底会把负值那段
     * 也涂成"正的面积", 面积图的语义是"和零线之间的量", 这一步错了图就在骗人。 */
    ...(seriesList.length === 1 ? [Shape({
      geometry: 'custom', alignSelf: 'stretch',
      fill: withAlpha(t.accent, 0.14),
      customPath: {
        /* 面积也按段闭合: 每一段各自落到零线, 缺失处不铺 */
        d: segsOf(seriesList[0]!.values).filter((sgs) => sgs.length > 1).map((sgs) => {
          const first = sgs[0]!.split(' ')[0]!;
          const last = sgs[sgs.length - 1]!.split(' ')[0]!;
          return `M${first} ${zeroY} L${sgs.join(' L')} L${last} ${zeroY} Z`;
        }).join(' '),
        viewBox: { width: VB, height: VB },
      },
      padding: plotInset,
    })] : []),
    ...seriesList.map((s, si) => Shape({
      geometry: 'custom', alignSelf: 'stretch',
      customPath: { d: pathOf(s.values), viewBox: { width: VB, height: VB }, strokeOnly: true },
      border: { color: seriesColors[si]!, width: 3 },
      padding: plotInset,
    })),
    /* 数据点 + 数值 —— 用和柱子一样的 flex 分段定位, 不需要知道像素尺寸 */
    ...seriesList.map((s, si) => HStack(
      { align: 'stretch', justify: 'spaceEvenly', alignSelf: 'stretch', padding: plotInset },
      s.values.map((v) => v == null ? VStack({ flex: 1 }, []) : VStack({ flex: 1, align: 'center' }, [
        VStack({ flex: seg(1 - frac(v)), align: 'center', justify: 'end' },
          /* 多系列不标数值: 几条线的数字挤在一起谁也读不清, 图例+刻度已经够了 */
          seriesList.length === 1 ? [Text(`${fmt(v)}${slots.unit ?? ''}`, {
            fontSize: 13, bold: true, color: t.ink, textAlign: 'ctr', singleLine: true,
            fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
            padding: { top: 0, left: 0, right: 0, bottom: 8 },
          })] : []),
        /* 圆点必须锁宽高比 —— 显式 width/height 而不是让 flex 拉伸
         * (flex 会把它拽成椭圆, 明康点过两次这个问题)。 */
        Shape({ geometry: 'ellipse', width: 11, height: 11, fill: seriesColors[si]!, alignSelf: 'center' }),
        VStack({ flex: seg(frac(v)) }, []),
      ])),
    )),
  ];

  /* 图例 —— 多系列没有图例等于没画。色块用和柱子同一个 seriesColors, 顺序也一致。 */
  const legend = isMulti
    ? HStack({ align: 'center', gap: 22, justify: 'start', padding: { top: 0, left: AXIS_W + AXIS_GAP, right: 0, bottom: 2 } },
        seriesList.map((s, si) => HStack({ align: 'center', gap: 8 }, [
          Shape({ geometry: 'rect', width: 14, height: 14, fill: seriesColors[si]!, cornerRadius: 3 }),
          Text(s.name, {
            fontSize: 13, color: t.ink, singleLine: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          }),
        ])))
    : nothing();

  const plot: ComposeNode = chartType === 'line'
    ? VStack({ align: 'stretch', flex: 1 }, [
        ZStack({ align: 'start', alignSelf: 'stretch', flex: 1 }, [grid, ...lineLayers]),
        catRow,
      ])
    : (chartType === 'column' || stacked)
    ? VStack({ align: 'stretch', flex: 1 }, [
        ZStack({ align: 'start', alignSelf: 'stretch', flex: 1 }, [grid, barLayer]),
        catRow,
      ])
    : /* 横向条形: 类目在左, 值轴在下。竖网格线压在条的下面 —— 只有刻度数字没有线,
       * 眼睛没法从条的末端垂直找到刻度, "大概在 8 和 10 之间"就只能靠猜。 */
      VStack({ align: 'stretch', flex: 1, gap: 14 }, [
        ZStack({ align: 'start', alignSelf: 'stretch', flex: 1 }, [
        /* 网格层: 左边让开类目名, 右边按刻度均分竖线; 零线加重 */
        HStack({ align: 'stretch', alignSelf: 'stretch', gap: 12 }, [
          Shape({ geometry: 'rect', width: 140, fill: 'rgba(0,0,0,0)' }),
          HStack({ align: 'stretch', flex: 1, justify: 'spaceBetween' },
            ticks.map((v) => Shape({
              geometry: 'rect', width: Math.abs(v) < 1e-9 ? 2 : 1,
              alignSelf: 'stretch',
              fill: Math.abs(v) < 1e-9 ? zeroColor : gridColor,
            }))),
        ]),
        VStack({ align: 'stretch', alignSelf: 'stretch', flex: 1, justify: 'spaceEvenly' }, cats.flatMap((cat, ci) => seriesList.map((sr, si) => {
          const v = sr.values[ci];
          const barColor = isMulti ? seriesColors[si]! : t.accent;
          if (v == null) return HStack({ align: 'center', gap: 12 }, []);
          /* 横向同样是四段, 只是主轴换成水平: 零点左侧空白 · 负条 · 正条 · 右侧空白。
           * 负条往左长, 所以它排在正条前面。 */
          const leftBlank = frac(Math.min(v, 0));
          const negBar = zeroFrac - frac(Math.min(v, 0));
          const posBar = frac(Math.max(v, 0)) - zeroFrac;
          const rightBlank = 1 - frac(Math.max(v, 0));
          const valueText = Text(`${fmt(v)}${slots.unit ?? ''}`, {
            fontSize: 14, bold: true, color: t.ink, singleLine: true,
            fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
            padding: v >= 0 ? { top: 0, left: 10, right: 0, bottom: 0 } : { top: 0, left: 0, right: 10, bottom: 0 },
            textAlign: v >= 0 ? 'l' : 'r',
          });
          return HStack({ align: 'center', gap: 12 }, [
            /* 分组横条: 同一类目的第 2 条起不再重复类目名, 只靠颜色 + 图例区分 ——
             * 重复三遍"华东"比不写还乱。 */
            Text(si === 0 ? cat : '', {
              fontSize: 14, color: t.ink, width: 140, textAlign: 'r', singleLine: true,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            }),
            HStack({ align: 'center', flex: 1 }, [
              /* 数值标在条的外侧: 正条标右边, 负条标左边 —— 标在里面会被条色吃掉 */
              HStack({ flex: seg(leftBlank), align: 'center', justify: 'end' }, v < 0 ? [valueText] : []),
              negBar > EPS
                ? Shape({ geometry: 'rect', height: isMulti ? 18 : 26, flex: negBar, fill: isMulti ? mixHex(barColor, t.ink, 0.4) : negColor, cornerRadius: 4 })
                : nothing(),
              posBar > EPS
                ? Shape({ geometry: 'rect', height: isMulti ? 18 : 26, flex: posBar, fill: barColor, cornerRadius: 4 })
                : nothing(),
              HStack({ flex: seg(rightBlank), align: 'center', justify: 'start' }, v >= 0 ? [valueText] : []),
            ]),
          ]);
        })))]),
        /* 值轴刻度条 —— 横条图没有它就完全读不出量级 */
        HStack({ align: 'center', gap: 12 }, [
          Shape({ geometry: 'rect', width: 140, height: 1, fill: 'rgba(0,0,0,0)' }),
          HStack({ align: 'center', flex: 1, justify: 'spaceBetween' },
            ticks.map((v) => Text(fmt(v), {
              fontSize: TICK_PT, color: t.muted, singleLine: true,
              fontLatin: t.fonts.numeric, fontEast: t.fonts.textEast,
            }))),
        ]),
      ]);

  render(slide,
    VStack({ gap: 28, align: 'stretch', width: b.width, height: b.height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: t.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      slots.title
        ? Text(slots.title, {
            fontSize: 36, bold: true, color: t.ink,
            letterSpacingPt: -0.2,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : nothing(),
      slots.title ? dividerMotif(64, 16) : nothing(),
      slots.unit
        ? Text(`(${slots.unit})`, {
            fontSize: 12, color: t.muted,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      /* 图例放在图上方而不是下方: 观众的阅读顺序是标题→图例→图形, 先知道
       * "有哪几组"再看形状才读得懂; 放在下面等于看完再回头对照。 */
      legend,
      plot,
    ]),
    { bounds: b },
  );
}
