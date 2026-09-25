import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Table, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif } from './motif-bits.js';

export interface DataTableSlots {
  kicker?: string;
  title?: string;
  headers: string[];
  rows: string[][];
  columnAlign?: Array<'l' | 'ctr' | 'r'>;
  columnWidths?: number[];
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
        headerFill: t.ink,
        zebraFill: t.surface,
        flex: 1,
      }),
    ]),
    { bounds: b },
  );
}
