import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif, mixHex } from './motif-bits.js';

export interface QuotePageSlots {
  quote: string;
  attribution?: string;
  kicker?: string;
}

export function quotePage(slide: Slide, slots: QuotePageSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;

  render(slide,
    VStack({ gap: 24, align: 'center', justify: 'center', width: contentBounds(1280, 720).width, height: contentBounds(1280, 720).height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: t.accent,
            letterSpacingPt: 2.4, uppercase: true, textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      Text('“', {
        fontSize: 120, color: mixHex(t.paper, t.accent, 0.32), singleLine: true, textAlign: 'ctr',
        fontLatin: 'Georgia', fontEast: 'Georgia', lineHeightPt: 96,
      }),
      Text(String(slots.quote).trim().replace(/^["“”'‘’「『]+|["“”'‘’」』]+$/g, ''), {
        fontSize: 32, color: t.ink,
        textAlign: 'ctr',
        fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
        maxWidth: 900,
      }),
      dividerMotif(60, 16, t.accent),
      slots.attribution
        ? Text(`— ${slots.attribution}`, {
            fontSize: 14, color: t.muted,
            letterSpacingPt: 0.3, textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
    ]),
    { bounds: contentBounds(1280, 720) },
  );
}
