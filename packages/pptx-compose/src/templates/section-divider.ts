import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, panelColor, onPanelColor } from './theme.js';
import { heroBackdropLayers, dividerMotif, readableAccent, nothing, titleSizeForBox } from './motif-bits.js';
import { pageBackground, type BackgroundSource } from './page-backgrounds.js';

export interface SectionDividerSlots {
  sectionNumber: string;
  title: string;
  subtitle?: string;
  artBackground?: BackgroundSource;
}

/* 艺术底章节页: 巨号章节号 (accent) + 深色标题, 都在左侧留白里 */
function artSection(slide: Slide, slots: SectionDividerSlots, art: BackgroundSource) {
  const t = activeTheme();
  const acc = readableAccent(t.paper);
  /* 背景单独一层画 (同 cover-hero: 放进同一个 ZStack 会被排版推下去) */
  pageBackground(slide, art);
  render(slide,
    ZStack({ align: 'start' }, [
      VStack({
        gap: 18, align: 'start', justify: 'center',
        width: 1280, height: 720,
        padding: { top: 64, left: 88, right: 0, bottom: 64 },
      }, [
        Text(slots.sectionNumber, {
          fontSize: 150, bold: true, color: acc, letterSpacingPt: -2, singleLine: true,
          fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        }),
        dividerMotif(76, 20, acc),
        Text(slots.title, {
          fontSize: titleSizeForBox(slots.title, 720, { max: 44, min: 36, maxLines: 2 }),
          bold: true, color: t.ink, letterSpacingPt: -0.4, width: 720,
          fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        }),
        slots.subtitle
          ? Text(slots.subtitle, {
              fontSize: 18, color: t.muted, width: 680,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            })
          : nothing(),
      ]),
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}

export function sectionDivider(slide: Slide, slots: SectionDividerSlots) {
  if (slots.artBackground) return artSection(slide, slots, slots.artBackground);
  const t = activeTheme();
  const panel = panelColor(t);
  /* 深底上的 accent 必须提亮 —— 同 cover-hero 的坑 (深红章节号压在深棕底上) */
  const acc = readableAccent(panel);
  render(slide,
    ZStack({ align: 'start' }, [
      Shape({ geometry: 'rect', width: 1280, height: 720, fill: panel }),
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
          fontSize: 40, bold: true, color: onPanelColor(t),
          letterSpacingPt: -0.4,
          fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        }),
        slots.subtitle
          ? Text(slots.subtitle, {
              fontSize: 18, color: onPanelColor(t),
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            })
          : nothing(),
      ]),
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
