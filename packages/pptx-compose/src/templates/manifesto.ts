import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text, Shape, Spacer } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { displaySizeForLength, dividerMotif } from './motif-bits.js';

export interface ManifestoSlots {
  text: string;
  kicker?: string;
  attribution?: string;
}

export function manifesto(slide: Slide, slots: ManifestoSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  render(slide,
    VStack({ gap: 24, align: 'stretch', width: b.width, height: b.height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: t.accent,
            letterSpacingPt: 2.4, uppercase: true, textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      Spacer({}),
      Text(slots.text, {
        fontSize: displaySizeForLength(slots.text, 80), bold: true, color: t.ink,
        letterSpacingPt: -1, textAlign: 'ctr',
        fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
      }),
      dividerMotif(84, 20),
      Spacer({}),
      slots.attribution
        ? Text(`— ${slots.attribution}`, {
            fontSize: 14, color: t.muted,
            letterSpacingPt: 0.3, textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    ]),
    { bounds: b },
  );
}
