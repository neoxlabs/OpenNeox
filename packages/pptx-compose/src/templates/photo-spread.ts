import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Image, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { nothing } from './motif-bits.js';

export interface PhotoSpreadSlots {
  kicker?: string;
  title?: string;
  images: any[]; /* 3-4 张 · 第 1 张是大图 */
}

export function photoSpread(slide: Slide, slots: PhotoSpreadSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;

  const majorW = Math.round(1280 * 0.618); /* 黄金比例大图宽 */
  const minorW = 1280 - majorW;
  const subImages = slots.images.slice(1);

  const rightSide = VStack({ gap: 8, width: minorW, height: 720, padding: { top: 8, right: 8, bottom: 8, left: 0 } },
    subImages.map((img) => Image(img, { fit: 'cover', flex: 1 }))
  );

  const leftSide = ZStack({ align: 'start', width: majorW, height: 720 }, [
    Image(slots.images[0] ?? null, { width: majorW, height: 720, fit: 'cover', bleed: true }),
    /* 底部遮罩 —— 保护压在照片上的文字。无图时它压在占位框上, 略深但不影响判读 */
    Shape({
      geometry: 'rect', width: majorW, height: 300, fill: 'rgba(0,0,0,0.55)',
      padding: { top: 420, left: 0, right: 0, bottom: 0 },
    }),
    slots.title
      ? VStack({
          gap: 10, justify: 'end', align: 'start',
          width: majorW, height: 720,
          padding: { top: 0, left: 40, right: 40, bottom: 44 },
        }, [
          slots.kicker
            ? Text(slots.kicker, {
                fontSize: 14, bold: true, color: t.onInk,
                letterSpacingPt: 2.4, uppercase: true,
                fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
              })
            : nothing(),
          Text(slots.title, {
            fontSize: 36, bold: true, color: '#FFFFFF',
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          }),
        ])
      : nothing(),
  ]);

  render(slide,
    HStack({ align: 'stretch', width: 1280, height: 720 }, [
      leftSide,
      rightSide,
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
