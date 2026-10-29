import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text, Image, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif } from './motif-bits.js';

export interface ImageGallerySlots {
  kicker?: string;
  title?: string;
  images: any[];
  captions?: string[];
}

export function imageGallery(slide: Slide, slots: ImageGallerySlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const n = slots.images.length;
  const cols = n <= 3 ? n : n <= 4 ? 2 : 3;

  const items = slots.images.map((img, i) =>
    VStack({ align: 'stretch', gap: 8, flex: 1 }, [
      Image(img, { fit: 'cover', flex: 1 }),
      slots.captions && slots.captions[i]
        ? Text(slots.captions[i]!, {
            fontSize: 12, color: t.muted, letterSpacingPt: 0.3,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    ])
  );

  render(slide,
    VStack({ gap: 24, align: 'stretch', width: b.width }, [
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
      VStack({ align: 'stretch', gap: 16, flex: 1 },
        Array.from({ length: Math.ceil(n / cols) }, (_, r) =>
          HStack({ align: 'stretch', gap: 16, flex: 1 }, items.slice(r * cols, r * cols + cols)))),
    ]),
    { bounds: b },
  );
}
