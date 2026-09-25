import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Image, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { dividerMotif, heroBackdropLayers } from './motif-bits.js';

export interface EditorialSplitSlots {
  kicker?: string;
  title: string;
  body: string | string[];
  image?: any;
  imageSide?: 'left' | 'right';
}

export function editorialSplit(slide: Slide, slots: EditorialSplitSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;

  const paragraphs = Array.isArray(slots.body) ? slots.body : [slots.body];
  const imageW = 512;
  const onLeft = slots.imageSide !== 'right';

  const imageSide = slots.image
    ? Image(slots.image, { width: imageW, height: 720, fit: 'cover', bleed: true })
    : ZStack({ align: 'start', width: imageW, height: 720 }, [
        heroBackdropLayers({ slideW: imageW, slideH: 720, tone: 'onDark' }),
      ]);

  const textSide = VStack({
    flex: 1, gap: 20, padding: 72, height: 720, justify: 'center', align: 'stretch',
  }, [
    slots.kicker
      ? Text(slots.kicker, {
          fontSize: 14, bold: true, color: t.accent,
          letterSpacingPt: 2.4, uppercase: true,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    Text(slots.title, {
      fontSize: 36, bold: true, color: t.ink,
      letterSpacingPt: -0.2,
      fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
    }),
    dividerMotif(64, 16),
    VStack({ gap: 12, align: 'stretch' },
      paragraphs.map((p) => Text(p, {
        fontSize: 18, color: t.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }))
    ),
  ]);

  render(slide,
    HStack({ align: 'stretch', width: 1280, height: 720 },
      onLeft ? [imageSide, textSide] : [textSide, imageSide]
    ),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
