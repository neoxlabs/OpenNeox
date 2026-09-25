import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Grid, Text, Shape } from '../compose/dsl.js';
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
}
/* 网格的几何常数 —— 反解 desc 行数要用同一组数, 散在各处迟早对不上 */
const ROW_GAP = 30;
const COL_GAP = 32;
const ICON_H = 54;
const DESC_PT = 14;

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
  const cols = n <= 3 ? n : 3;

  const rows = Math.ceil(n / cols);
  const cellW = (main.bounds.width - COL_GAP * (cols - 1)) / cols;
  const cellH = (main.bounds.height - ROW_GAP * (rows - 1)) / rows;
  const descLineH = resolveLineHeightPt(DESC_PT) * (96 / 72);

  const items = slots.items.map((it) =>
    VStack({ gap: 12, align: 'start' }, [
      /* iconColor 仍然尊重 —— 调用方真有语义分组时可以自己上色, 但默认不瞎分 */
      it.icon && hasIcon(it.icon)
        ? iconMark(it.icon, { size: ICON_H })
        : it.iconColor
          ? Shape({ geometry: 'rect', width: 72, height: ICON_H, fill: it.iconColor, cornerRadius: 8 })
          : stepNodeMotif({ width: 72, height: ICON_H }),
      Text(it.title, {
        fontSize: 20, bold: true, color: t.ink,
        padding: { top: 8, left: 0, right: 0, bottom: 0 },
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }),
      Text(it.desc, {
        fontSize: DESC_PT, color: t.muted,
        maxLines: Math.max(1, Math.floor(
          (cellH - ICON_H - 8 - measureText(it.title, 20, cellW, { bold: true }).height - 12)
          / descLineH)),
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }),
    ])
  );

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
    Grid({ columns: cols, rowGap: ROW_GAP, colGap: COL_GAP, flex: 1, width: main.bounds.width, height: main.bounds.height }, items),
    { bounds: main.bounds },
  );
}
