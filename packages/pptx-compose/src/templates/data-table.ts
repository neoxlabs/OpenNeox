import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Table, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds, panelColor, onPanelColor } from './theme.js';
import { dividerMotif, nothing } from './motif-bits.js';

export interface DataTableSlots {
  kicker?: string;
  title?: string;
  headers: string[];
  rows: string[][];
  columnAlign?: Array<'l' | 'ctr' | 'r'>;
  columnWidths?: number[];
  /** 高亮一行 (0 起, 不算表头): 通常是"我们自己"那一行, 让读者一眼找到对比对象 */
  highlightRow?: number;
  takeaway?: string;
}

export function dataTable(slide: Slide, slots: DataTableSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  render(slide,
    VStack({ gap: 24, align: 'stretch', width: b.width, height: b.height }, [
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
      Table(slots.headers, slots.rows, {
        columnAlign: slots.columnAlign,
        columnWidths: slots.columnWidths,
        zebra: true,
        borderColor: t.subtle,
        headerFill: panelColor(t),
        zebraFill: t.surface,
        /* 深色主题 (paper 是深底、ink 是浅字) 下, 表头底是 panel(浅) 而不是 ink(深字色)——
         * 渲染器里写死的「表头白字 + 正文墨色」会两头都看不见, 必须按主题给字色。
         *
         * 【只在主题显式给了 panel 时才传】浅色主题里 panel === ink, 传与不传**视觉等价**,
         * 但传了会把写死的 #FFFFFF / #1D2A2F 换成本主题的 onInk / ink —— 字节变了。
         * 十套已有风格的既有 PPT 要和改动前逐字节一致, 所以老路径原样保留。 */
        ...(t.panel
          ? { headerColor: onPanelColor(t), bodyColor: t.ink }
          : {}),
        highlightRow: slots.highlightRow,
        highlightFill: t.accentSoft,
        flex: 1,
      }),
      slots.takeaway
        ? HStack({ gap: 12, align: 'center' }, [
            Shape({ geometry: 'rect', width: 4, height: 24, fill: t.accent }),
            Text(slots.takeaway, {
              fontSize: 17, bold: true, color: t.ink, flex: 1,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            }),
          ])
        : nothing(),
    ]),
    { bounds: b },
  );
}
