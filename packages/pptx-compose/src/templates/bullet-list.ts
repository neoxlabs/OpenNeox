
import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text } from '../compose/dsl.js';
import { measureText } from '../layout/text-metrics.js';
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

  const n = slots.items.length;
  const fontSize = n <= 3 ? 26 : n <= 5 ? 22 : n <= 7 ? 19 : 17;
  const NUM_W = 56;
  const textW = main.bounds.width - NUM_W - 16;
  const textH = slots.items.reduce((sum, item) => sum + measureText(item, fontSize, textW).height, 0);
  /* 间距: 把剩下的高度均分, 但别撑成一条一屏 (上限 64) 也别贴死 (下限 14) */
  const gap = Math.max(14, Math.min(64, (main.bounds.height * 0.86 - textH) / Math.max(1, n - 1)));
  const items = slots.items.map((item, i) =>
    HStack({ gap: 16, align: 'start' }, [
      Text(String(i + 1).padStart(2, '0'), {
        fontSize: fontSize + 2, bold: true, color: main.accent, width: NUM_W,
        fontLatin: t.fonts.numeric ?? t.fonts.displayLatin, fontEast: t.fonts.displayEast,
      }),
      Text(item, {
        fontSize, color: main.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        flex: 1,
      }),
    ]),
  );

  render(slide,
    VStack({ gap, align: 'stretch', justify: 'center', width: main.bounds.width, height: main.bounds.height }, items),
    { bounds: main.bounds },
  );
}
