import type { Slide } from '@neoxlabs/pptx-renderer';
import type { ComposeNode } from '../compose/types.js';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif, readableAccent, withAlpha, nothing, softInk, valueWithUnit } from './motif-bits.js';
import { sparkline, bulletBar, progressRing, ratingDots } from './dataviz-bits.js';

export interface KpiCardsSlots {
  kicker?: string;
  title?: string;
  cards: Array<{
    value: string;
    label: string;
    subLabel?: string;
    /**
     * 迷你趋势线的数据。给了它, "82%" 才有参照系 —— 光一个数回答不了
     * "这是好是坏、在往哪走"。缺数据传 null 不要传 0 (0 是"这期是零")。
     */
    spark?: Array<number | null>;
    /**
     * 目标条: 实绩 vs 目标。KPI 最常被问的就是"离目标还差多少"。
     *
     * `lowerIsBetter` 在指标**越小越好**时必须传 (换乘距离/成本/时长/损失率)。
     * 不传的话 "214 米 · 目标 200" 会被画成达标色 —— 图形和数字反着说,
     * 而这个方向无法从数值本身推断出来。
     */
    progress?: { value: number; target: number; max?: number; lowerIsBetter?: boolean };
    /**
     * 进度环 (0~1, 传 0.82 不是 82)。环心默认显示百分比。
     * 适合本身就是**比例**的指标 (完成度/覆盖率/达成率) —— 环走了多少一眼就懂。
     */
    ring?: number;
    /**
     * 评分点阵。适合有**上限刻度**的指标 (满意度 4.6/5, 评级 3/5)。
     * 点数只到整颗 —— 5 颗点的分辨率本来就只有整颗, 精确值交给旁边的数字。
     */
    rating?: { value: number; max?: number };
  }>;
}

/** 每行几张 —— 5~6 张走两行三列, 视觉上比一行六张稳得多。
 * 单独抽出来是因为**卡宽**也要用这个数 (趋势线/目标条需要显式宽度):
 * 分行一套算法、算宽另一套, 迟早漂移成"图形比卡片宽"。 */
export function kpiPerRow(n: number): number {
  if (n <= 4) return n;
  return n <= 6 ? 3 : 4;
}

function kpiRows(cards: ComposeNode[]): ComposeNode[] {
  const n = cards.length;
  if (n <= 4) return [HStack({ gap: 24, align: 'stretch', flex: 1 }, cards)];
  const perRow = kpiPerRow(n);
  const rows: ComposeNode[] = [];
  for (let i = 0; i < n; i += perRow) {
    const slice = cards.slice(i, i + perRow);
    /* 最后一行不足时补空位, 保证各卡宽度和上一行对齐 —— 否则末行的卡会被拉宽, 一眼歪 */
    while (slice.length < perRow) {
      slice.push(VStack({ flex: 1 }, []));
    }
    rows.push(HStack({ gap: 24, align: 'stretch', flex: 1 }, slice));
  }
  return rows;
}

export function kpiCards(slide: Slide, slots: KpiCardsSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  /* 卡内图形要显式宽度 (flex 的宽度到不了组件手里), 按同一个 perRow 反解。
   * 24 是卡间距, 24*2 是卡内左右 padding。 */
  const perRow = kpiPerRow(slots.cards.length);
  const cardInnerW = Math.max(60, Math.round((b.width - 24 * (perRow - 1)) / perRow) - 48);

  const cards = slots.cards.map((c, i) => {
    const lead = i === 0;
    const ground = lead ? t.ink : t.surface;
    const valueColor = lead ? readableAccent(t.ink) : t.accent;
    const labelColor = lead ? t.onInk : t.ink;
    const subColor = lead ? softInk(0.7) : t.muted;

    return VStack({
      flex: 1, gap: 10, align: 'start', justify: 'spaceBetween',
      background: ground, cornerRadius: 12,
      padding: 24,
      effects: lead
        ? undefined
        : { outerShadow: { blur: 30000, distance: 40000, angle: 90, color: t.ink, alpha: 0.1 } },
    }, [
      dividerMotif(44, 11, valueColor),
      /* 数字大、单位小且贴基线 —— 原来整串一个字号, "万元"比数字还抢眼 */
      valueWithUnit(c.value, {
        size: 52, color: valueColor, letterSpacingPt: -1,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
      }),
      /* 数值的形状。一张卡**只画一个** —— 两个参照系并存, 观众不知道该看哪个。
       * 优先级: 趋势线 > 目标条 > 进度环 > 评分点阵 (信息量从多到少)。
       * 都没给就什么都不画, 不硬凑一个图形。 */
      c.spark && c.spark.length >= 2
        ? sparkline({ values: c.spark, width: cardInnerW, height: 46, onDark: lead })
        : c.progress
          ? bulletBar({
              value: c.progress.value, target: c.progress.target, max: c.progress.max,
              lowerIsBetter: c.progress.lowerIsBetter,
              width: cardInnerW, height: 14, onDark: lead,
            })
          : typeof c.ring === 'number'
            ? progressRing({ value: c.ring, size: Math.min(96, cardInnerW), onDark: lead })
            : c.rating
              ? ratingDots({ value: c.rating.value, max: c.rating.max, onDark: lead })
              : nothing(),
      /* 标签和副标签打包成一组压在卡底 —— 分开放会被 spaceBetween 拆到三个位置,
       * 而它们本来就是一句话的两半。 */
      VStack({ gap: 6, align: 'start' }, [
        Text(c.label, {
          fontSize: 18, color: labelColor,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        }),
        c.subLabel
          ? Text(c.subLabel, {
              fontSize: 14, color: subColor,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            })
          : nothing(),
      ]),
    ]);
  });

  render(slide,
    VStack({ gap: 24, align: 'stretch', width: b.width, height: b.height, justify: 'center' }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: t.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      slots.title
        ? Text(slots.title, {
            fontSize: 36, bold: true, color: t.ink,
            letterSpacingPt: -0.2,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      slots.title
        ? dividerMotif(64, 16)
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      ...kpiRows(cards).map((row) => ({ ...row, layoutParams: { ...(row.layoutParams ?? {}), height: Math.min(340, Math.round(b.height * 0.78)) } })),
    ]),
    { bounds: b },
  );
}
