import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif, mixHex } from './motif-bits.js';

export interface ThreeColumnSlots {
  kicker?: string;
  title?: string;
  columns: Array<{ title: string; body: string | string[] }>;
}

export function threeColumn(slide: Slide, slots: ThreeColumnSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const columns = slots.columns.slice(0, 3).map((c, i) => {
    const body = Array.isArray(c.body) ? c.body : [c.body];
    return VStack({ gap: 12, align: 'stretch', flex: 1, padding: { top: 20, left: 0, right: 0, bottom: 0 } }, [
      Text(String(i + 1).padStart(2, '0'), {
        fontSize: 34, bold: true, color: mixHex(t.accent, t.paper, 0.45), singleLine: true,
        letterSpacingPt: -0.5, fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
      }),
      Shape({ geometry: 'rect', width: 36, height: 3, fill: t.accent }),
      Text(c.title, {
        fontSize: 20, bold: true, color: t.accent,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: 8, left: 0, right: 0, bottom: 0 },
      }),
      ...body.map((p) => Text(p, {
        fontSize: 16, color: t.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      })),
    ]);
  });

  render(slide,
    VStack({ gap: 24, align: 'stretch', width: b.width, height: b.height }, [
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
      /* 分栏线 —— 三栏文字长短不一, 下面必然空出一块。加满高的细分隔线之后,
       * 那块空白读成**栏白** (报纸/杂志的分栏就是这么处理的), 而不是"没排完"。
       * 这比把文字拉开撑满诚实: 内容就这么多, 该做的是给它一个结构, 不是注水。
       * alignSelf:'stretch' 让线吃满栏高; 宽度显式 1px 所以不会被横向拉伸。 */
      HStack({ gap: 32, align: 'stretch', flex: 1 }, columns.flatMap((c, i) =>
        i === 0 ? [c] : [
          Shape({
            geometry: 'rect', width: 1, alignSelf: 'stretch',
            fill: mixHex(t.paper, t.ink, 0.16),
          }),
          c,
        ],
      )),
    ]),
    { bounds: b },
  );
}
