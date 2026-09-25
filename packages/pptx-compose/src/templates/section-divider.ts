import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { heroBackdropLayers, dividerMotif, readableAccent, nothing } from './motif-bits.js';

export interface SectionDividerSlots {
  sectionNumber: string;
  title: string;
  subtitle?: string;
}

export function sectionDivider(slide: Slide, slots: SectionDividerSlots) {
  const t = activeTheme();
  /* 深底上的 accent 必须提亮 —— 同 cover-hero 的坑 (深红章节号压在深棕底上) */
  const acc = readableAccent(t.ink);
  render(slide,
    ZStack({ align: 'start' }, [
      Shape({ geometry: 'rect', width: 1280, height: 720, fill: t.ink }),
      heroBackdropLayers({ tone: 'onDark' }),
      /* 大号章节号 · 左上巨字 · accent 色 */
      Text(slots.sectionNumber, {
        fontSize: 160, bold: true, color: acc,
        letterSpacingPt: -2,
        fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        singleLine: true,
        padding: { top: 100, left: 72, right: 0, bottom: 0 },
      }),
      VStack({
        gap: 18, align: 'start',
        width: 1280, height: 720,
        padding: { top: 330, left: 72, right: 72, bottom: 56 },
      }, [
        dividerMotif(76, 20, acc),
        Text(slots.title, {
          fontSize: 40, bold: true, color: t.onInk,
          letterSpacingPt: -0.4,
          fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        }),
        slots.subtitle
          ? Text(slots.subtitle, {
              fontSize: 18, color: t.onInk,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            })
          : nothing(),
      ]),
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
