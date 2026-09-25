import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif, valueWithUnit, valueEmWidth } from './motif-bits.js';

export interface NumbersHeroSlots {
  kicker?: string;
  headline?: string;
  numbers: Array<{ value: string; label: string }>;
}

export function numbersHero(slide: Slide, slots: NumbersHeroSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const count = slots.numbers.length;
  const GAP = 32;
  const colW = (b.width - GAP * Math.max(0, count - 1)) / Math.max(1, count);

  /* 单位按小号折算 (valueWithUnit 把单位缩到 0.36 倍), 否则会为了一个"万元"把数字压小 */
  const widest = Math.max(...slots.numbers.map((n) => valueEmWidth(n.value)), 1);
  const valueSize = Math.max(40, Math.min(128, Math.floor((colW * 0.84) / (widest * (96 / 72)))));

  const cards = slots.numbers.map((n) =>
    /* spaceBetween: 帽条钉在列顶 · 数字落在列中 · 标签压在列底 ——
     * 一列就是一根撑满版心的"柱", 空白被分配成三段间距, 不再堆在版面下半。 */
    VStack({ flex: 1, align: 'stretch', justify: 'center', gap: 18 }, [
      dividerMotif(72, 14, t.accent),
      valueWithUnit(n.value, {
        size: valueSize, color: t.accent, letterSpacingPt: -1.5,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
      }),
      Text(n.label, {
        fontSize: 15, color: t.muted,
        letterSpacingPt: 0.3,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }),
    ])
  );

  render(slide,
    VStack({ gap: 32, align: 'stretch', width: b.width, height: b.height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: t.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      slots.headline
        ? Text(slots.headline, {
            fontSize: 24, color: t.ink,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      HStack({ gap: GAP, align: 'stretch', flex: 1, justify: 'spaceBetween' }, cards),
    ]),
    { bounds: b },
  );
}
