
import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text } from '../compose/dsl.js';
import type { LayoutNode } from '../compose/types.js';
import { activeTheme } from './theme.js';
import { dividerMotif, nothing } from './motif-bits.js';
import { bleedBandFrame } from './page-frame.js';

export interface TitleBodySlots {
  kicker?: string;
  title: string;
  body: string | string[];
  footerText?: string;
}

export function titleBody(slide: Slide, slots: TitleBodySlots) {
  const t = activeTheme();
  const paragraphs = Array.isArray(slots.body) ? slots.body : [slots.body];
  const { band, main } = bleedBandFrame(slide);

  render(slide,
    VStack({ gap: 14, align: 'stretch', width: band.bounds.width }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: band.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      Text(slots.title, {
        fontSize: 36, bold: true, color: band.ink,
        letterSpacingPt: -0.2,
        fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
      }),
    ]),
    { bounds: band.bounds },
  );

  const bodyChildren: LayoutNode[] = [
    dividerMotif(64, 16),
    ...paragraphs.map((p) =>
      Text(p, {
        fontSize: 18, color: main.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      })
    ),
  ];

  render(slide,
    VStack({ gap: 16, align: 'stretch', width: main.bounds.width }, bodyChildren),
    { bounds: main.bounds },
  );
}
