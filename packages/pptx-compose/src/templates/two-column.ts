
import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text } from '../compose/dsl.js';
import type { ComposeNode } from '../compose/types.js';
import { activeTheme, PAGE } from './theme.js';
import { dividerMotif, nothing } from './motif-bits.js';
import { diagonalFrame } from './page-frame.js';

export interface TwoColumnSlots {
  kicker?: string;
  title?: string;
  leftTitle: string;
  leftBody: string | string[];
  rightTitle: string;
  rightBody: string | string[];
  footerText?: string;
}

export function twoColumn(slide: Slide, slots: TwoColumnSlots) {
  const t = activeTheme();
  const hasHead = Boolean(slots.kicker || slots.title);
  /* 有标题时色块从标题下方开始才不会顶到题上 —— 用 ratio 控左右, 用 headH 控上下 */
  const headH = hasHead ? 168 : 0;
  const { panel, main } = diagonalFrame(slide, { ratio: 0.5 });

  if (hasHead) {
    render(slide,
      VStack({ gap: 16, align: 'stretch', width: 1280 - PAGE.padH * 2 }, [
        slots.kicker
          ? Text(slots.kicker, {
              fontSize: 14, bold: true, color: t.accent,
              letterSpacingPt: 2.4, uppercase: true,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
            })
          : nothing(),
        slots.title
          ? Text(slots.title, {
              fontSize: 36, bold: true, color: t.ink,
              letterSpacingPt: -0.2,
              fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
            })
          : nothing(),
        /* 标题下**不再**放分隔符: 切分的那条边界本身就是这一页最强的分隔,
         * 再加一个记号, 加上两栏各自的记号, 同一个形状一页出现三次, 变成噪声。 */
      ]),
      { bounds: { x: PAGE.padH, y: PAGE.padTop, width: 1280 - PAGE.padH * 2, height: headH - 24 } },
    );
  }

  function column(
    title: string,
    body: string | string[],
    region: typeof panel,
  ): ComposeNode {
    const paragraphs = Array.isArray(body) ? body : [body];
    return VStack({ gap: 16, align: 'stretch', width: region.bounds.width }, [
      dividerMotif(40, 12, region.accent),
      Text(title, {
        fontSize: 20, bold: true, color: region.accent,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: 8, left: 0, right: 0, bottom: 0 },
      }),
      ...paragraphs.map((p) => Text(p, {
        fontSize: 18, color: region.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      })),
    ]);
  }

  const colBounds = (r: typeof panel) => ({
    x: r.bounds.x,
    y: r.bounds.y + headH,
    width: r.bounds.width,
    height: r.bounds.height - headH,
  });

  render(slide, column(slots.leftTitle, slots.leftBody, panel), { bounds: colBounds(panel) });
  render(slide, column(slots.rightTitle, slots.rightBody, main), { bounds: colBounds(main) });
}
