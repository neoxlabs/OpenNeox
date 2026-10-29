import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Grid, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { bleedBandFrame } from './page-frame.js';
import { dividerMotif, stepNodeMotif, nothing } from './motif-bits.js';
import { iconMark, hasIcon, type IconName } from './icon-bits.js';
import { measureText, resolveLineHeightPt } from '../layout/text-metrics.js';


export interface FeatureItem {
  title: string;
  desc: string;
  /**
   * 语义图标名 (见 ICON_NAMES)。
   *
   * 【和上面那段注释不矛盾】那段禁的是**按下标随机发形状** —— 五角星和六边形之间
   * 的区别是编出来的, 观众会去找一个不存在的差别。语义图标反过来: "病虫预警"配
   * warning、"机收减损"配 truck, 六个图标各不相同**传达的正是事实**。
   * 判据始终是"这个区别在内容里存不存在"。
   *
   * 想不出该配哪个就**别传** —— 会退回统一记号, 那也是诚实的。硬凑一个图标
   * 等于告诉观众一个内容里没有的意思, 比没有图标糟。
   */
  icon?: IconName;
  iconColor?: string;
  stat?: string;
}
/* 网格的几何常数 —— 反解 desc 行数要用同一组数, 散在各处迟早对不上 */
const ROW_GAP = 24;
const COL_GAP = 24;
const ICON_H = 40;
const TITLE_PT = 22;
const DESC_PT = 16;
const STAT_PT = 26;
const CARD_PAD = 22;
/** 卡片里记号 / 标题 / 说明之间的间距 */
const CARD_GAP = 6;
/** 编号 01 占的宽度 (跟标题同一行) */
const NUM_W = 40;

export interface FeatureGridSlots {
  kicker?: string;
  title?: string;
  items: FeatureItem[];
}

export function featureGrid(slide: Slide, slots: FeatureGridSlots) {
  const t = activeTheme();
  /* kicker(26) + 间距(12) + 36pt 标题(67) + 间距(12) + 记号(16) ≈ 133, 给到 140。
   * 传内容高度而不是色带高度 —— 色带要多高由 bleedBandFrame 按各风格的斜切量反解,
   * 调用方不可能知道那个比例 (chevron 0.22 / ribbon 0.18 / capsule 0.30 / line 0)。 */
  const { band, main } = bleedBandFrame(slide, { contentHeight: 140 });

  const n = slots.items.length;
  const cols = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
  /* 图标要么全是语义图标, 要么全用统一记号 —— 混着来 (两个真图标 + 两个占位块) 一眼就是拼的 */
  const allIcons = slots.items.every((it) => it.icon && hasIcon(it.icon));

  const rows = Math.ceil(n / cols);
  const rowOf = (i: number) => Math.floor(i / cols);
  const countInRow = (r: number) => Math.min(cols, n - r * cols);
  const widthFor = (k: number) => (main.bounds.width - COL_GAP * (k - 1)) / k;
  const cellH = (main.bounds.height - ROW_GAP * (rows - 1)) / rows;
  const descLineH = resolveLineHeightPt(DESC_PT) * (96 / 72);

  const items = slots.items.map((it, i) => {
    const cellW = widthFor(countInRow(rowOf(i)));
    const innerW = cellW - CARD_PAD * 2;
    const titleText = (w: number) => Text(it.title, {
      fontSize: TITLE_PT, bold: true, color: t.ink,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      ...(w ? { flex: 1 } : {}),
    });
    const markW = allIcons ? ICON_H : NUM_W;
    const squash = (s: string) => s.replace(/[\s¥￥元]/g, '');
    const rawStat = String(it.stat ?? '').trim();
    const stat = rawStat && !squash(it.title).includes(squash(rawStat)) ? rawStat : '';
    const statW = stat ? Math.ceil(measureText(stat, STAT_PT, 9999, {
      bold: true, fontLatin: t.fonts.numeric ?? t.fonts.displayLatin, fontEast: t.fonts.displayEast,
    }).width) + 4 : 0;
    const inlineW = innerW - markW - 12 - (stat ? statW + 12 : 0);
    const statInline = !!stat && measureText(it.title, TITLE_PT, inlineW, { bold: true }).lines <= 1;
    const titleW = statInline ? inlineW : innerW - markW - 12;
    const statText = () => Text(stat, {
      fontSize: STAT_PT, bold: true, color: t.accent, singleLine: true, width: statW,
      fontLatin: t.fonts.numeric ?? t.fonts.displayLatin, fontEast: t.fonts.displayEast,
    });
    const statLineH = resolveLineHeightPt(STAT_PT) * (96 / 72);
    const head = [HStack({ gap: 12, align: 'center' }, [
      allIcons
        ? iconMark(it.icon!, { size: ICON_H })
        : Text(String(i + 1).padStart(2, '0'), {
            fontSize: TITLE_PT, bold: true, color: it.iconColor ?? t.accent, width: NUM_W,
            fontLatin: t.fonts.numeric ?? t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          }),
      titleText(titleW),
      statInline ? statText() : nothing(),
    ]), stat && !statInline ? statText() : nothing()];
    const headH = Math.max(allIcons ? ICON_H : 0,
      measureText(it.title, TITLE_PT, titleW, { bold: true }).height,
      statInline ? statLineH : 0)
      + (stat && !statInline ? statLineH + CARD_GAP + 4 : 0);
    /* 色带高的风格 (capsule 斜切 0.30) 卡片矮, 上下各 22 的内边距让说明只剩一行省略号;
     * 先保两行说明, 不够再压内边距 (下限 12) */
    const padV = Math.max(12, Math.min(CARD_PAD, (cellH - headH - CARD_GAP - 4 - 2 * descLineH) / 2));
    const innerHV = cellH - padV * 2;
    return ZStack({ width: cellW, height: cellH }, [
      Shape({ geometry: 'rect', width: cellW, height: cellH, fill: t.surface, cornerRadius: 14 }),
      VStack({ gap: CARD_GAP + 4, align: 'stretch', justify: 'center', width: cellW, height: cellH,
        padding: { top: padV, bottom: padV, left: CARD_PAD, right: CARD_PAD } }, [
        ...head,
        Text(it.desc, {
          fontSize: DESC_PT, color: t.muted,
          maxLines: Math.max(1, Math.floor((innerHV - headH - CARD_GAP - 4) / descLineH)),
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        }),
      ]),
    ]);
  });

  render(slide,
    VStack({ gap: 12, align: 'stretch', justify: 'center', width: band.bounds.width, height: band.bounds.height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: band.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      slots.title
        ? Text(slots.title, {
            fontSize: 36, bold: true, color: band.ink,
            letterSpacingPt: -0.2,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : nothing(),
      slots.title ? dividerMotif(64, 16, band.accent) : nothing(),
    ]),
    { bounds: band.bounds, assertNoOverlap: false },
  );

  render(slide,
    n % cols === 0
      ? Grid({ columns: cols, rowGap: ROW_GAP, colGap: COL_GAP, flex: 1, width: main.bounds.width, height: main.bounds.height }, items)
      : VStack({ gap: ROW_GAP, align: 'stretch', width: main.bounds.width, height: main.bounds.height },
          Array.from({ length: rows }, (_, r) =>
            HStack({ gap: COL_GAP, align: 'start' }, items.slice(r * cols, r * cols + countInRow(r))))),
    { bounds: main.bounds },
  );
}
