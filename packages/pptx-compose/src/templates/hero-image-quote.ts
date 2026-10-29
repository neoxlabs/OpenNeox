import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Image, Shape, Spacer } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { dividerMotif, heroBackdropLayers } from './motif-bits.js';

export interface HeroImageQuoteSlots {
  image?: any;
  quote: string;
  attribution?: string;
  kicker?: string;
}

export function heroImageQuote(slide: Slide, slots: HeroImageQuoteSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;

  const hasImage = !!slots.image;
  const imageW = 512; /* 40% of 1280 */

  const leftSide = hasImage
    ? Image(slots.image, { width: imageW, height: 720, fit: 'cover', bleed: true,
        filter: { lum: { brightness: -0.1, contrast: 0.05 } } })
    : ZStack({ align: 'start', width: imageW, height: 720 }, [
        heroBackdropLayers({ slideW: imageW, slideH: 720, tone: 'onDark' }),
      ]);

  const rightSide = VStack({
    flex: 1, gap: 16, padding: 72, height: 720, justify: 'center', align: 'stretch',
  }, [
    slots.kicker
      ? Text(slots.kicker, {
          fontSize: 14, bold: true, color: t.accent,
          letterSpacingPt: 2.4, uppercase: true,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    Text(`"${slots.quote}"`, {
      /* 中文没有真斜体, 渲染端只能几何倾斜 —— 出来是歪黑体, 一眼廉价 */
      fontSize: 32, color: t.ink,
      fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
    }),
    slots.attribution
      ? Text(`— ${slots.attribution}`, {
          fontSize: 14, color: t.muted, letterSpacingPt: 0.3,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    /* 裸的 48×3 直线换成风格记号 —— 同 quote-page, 一份 deck 里分隔符要同一个形状 */
    dividerMotif(48, 14, t.accent),
  ]);

  render(slide,
    HStack({ align: 'stretch', width: 1280, height: 720 }, [
      leftSide,
      rightSide,
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
