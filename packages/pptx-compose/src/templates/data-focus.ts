import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { halfPanelFrame } from './page-frame.js';
import { dividerMotif, nothing } from './motif-bits.js';

export interface DataFocusSlots {
  kicker?: string;
  label?: string;
  number: string;
  unit?: string;
  story: string | string[];
}

export function dataFocus(slide: Slide, slots: DataFocusSlots) {
  const t = activeTheme();
  const stories = Array.isArray(slots.story) ? slots.story : [slots.story];
  const numberWithUnit = slots.unit ? `${slots.number}${slots.unit}` : slots.number;

  /* 面板比默认宽一点: 这一页的主角是数字, 它需要地方 */
  const { panel, main } = halfPanelFrame(slide, { ratio: 0.46 });

  /* 数字字号按面板宽度反解 —— 写死 140pt 时 "82%" 正好, 换成 "¥1,280万" 就会
   * 溢出面板 (singleLine 之后不折行, 直接横向撑出去)。同 numbersHero 的做法:
   * 按字符估 em 宽 (中日韩全角 1.0 / 拉丁数字 0.55), 反解能塞下的最大 pt。 */
  const emWidth = (s: string) => {
    let em = 0;
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0)!;
      const wide = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff01 && cp <= 0xff60) || cp === 0xffe5;
      em += wide ? 1.0 : 0.55;
    }
    return em || 1;
  };
  const numberSize = Math.max(48, Math.min(140,
    Math.floor((panel.bounds.width * 0.96) / (emWidth(numberWithUnit) * (96 / 72)))));

  render(slide,
    VStack({ gap: 14, align: 'stretch', justify: 'center', width: panel.bounds.width, height: panel.bounds.height }, [
      slots.kicker
        ? Text(slots.kicker, {
            fontSize: 14, bold: true, color: panel.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      slots.label
        ? Text(slots.label, {
            fontSize: 16, color: panel.muted,
            letterSpacingPt: 0.5,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      Text(numberWithUnit, {
        fontSize: numberSize, bold: true, color: panel.ink,
        letterSpacingPt: -2, singleLine: true,
        fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
      }),
      /* 裸的 72×4 矩形换成风格记号 —— 同一份 deck 里所有分隔符都该是同一个形状 */
      dividerMotif(72, 18, panel.accent),
    ]),
    { bounds: panel.bounds, assertNoOverlap: false },
  );

  render(slide,
    VStack({ gap: 16, align: 'stretch', justify: 'center', width: main.bounds.width, height: main.bounds.height },
      stories.map((p) => Text(p, {
        fontSize: 18, color: main.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }))),
    { bounds: main.bounds },
  );
}
