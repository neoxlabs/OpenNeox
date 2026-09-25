
import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { dividerMotif, nothing , titleSizeForBox } from './motif-bits.js';
import { halfPanelFrame } from './page-frame.js';

export interface BulletListSlots {
  kicker?: string;
  title?: string;
  items: string[];
  footerText?: string;
}

export function bulletList(slide: Slide, slots: BulletListSlots) {
  const t = activeTheme();
  const { panel, main } = halfPanelFrame(slide);

  /* 左: 标识区 —— 只放 kicker + 标题, 深底上不放长文 */
  render(slide,
    VStack({ gap: 18, align: 'stretch', width: panel.bounds.width }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: panel.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      slots.title
        ? Text(slots.title, {
            fontSize: titleSizeForBox(slots.title, panel.bounds.width, { max: 36, min: 22, maxLines: 5 }),
            bold: true, color: panel.ink,
            letterSpacingPt: -0.2,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : nothing(),
      slots.title ? dividerMotif(64, 16, panel.accent) : nothing(),
    ]),
    { bounds: panel.bounds },
  );

  /* 右: 内容区 */
  const items = slots.items.map((item) =>
    HStack({ gap: 16, align: 'start' }, [
      Shape({ geometry: 'ellipse', width: 8, height: 8, fill: main.accent,
        padding: { top: 12, left: 0, right: 0, bottom: 0 } }),
      Text(item, {
        fontSize: 18, color: main.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        flex: 1,
      }),
    ]),
  );

  render(slide,
    VStack({ gap: 14, align: 'stretch', width: main.bounds.width }, items),
    { bounds: main.bounds },
  );
}
