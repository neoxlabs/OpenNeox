import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { dividerMotif, withAlpha, nothing } from './motif-bits.js';
import { iconMark, hasIcon, type IconName } from './icon-bits.js';

export interface ThreeColumnSlots {
  kicker?: string;
  title?: string;
  columns: Array<{
    title: string;
    body: string | string[];
    stat?: { value: string; label?: string };
    /** 要点列表: 每条前面一个 accent 圆点, 跟 body 一起或替代 body */
    points?: string[];
    icon?: IconName;
  }>;
}

export function threeColumn(slide: Slide, slots: ThreeColumnSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const columns = slots.columns.slice(0, 3).map((c, i) => {
    const body = (Array.isArray(c.body) ? c.body : [c.body]).filter((p) => String(p ?? '').trim());
    const mark = c.icon && hasIcon(c.icon)
      ? iconMark(c.icon, { size: 40 })
      : Text(String(i + 1).padStart(2, '0'), {
          fontSize: 28, bold: true, color: t.accent, singleLine: true, width: 48,
          letterSpacingPt: -0.5, fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
        });
    return ZStack({ flex: 1, alignSelf: 'stretch' }, [
      Shape({ geometry: 'rect', flex: 1, alignSelf: 'stretch', fill: withAlpha(t.surface, 0.92), cornerRadius: 16 }),
      VStack({ gap: 14, align: 'stretch', justify: 'start', flex: 1,
        padding: { top: 28, left: 26, right: 26, bottom: 24 } }, [
        HStack({ gap: 12, align: 'center' }, [
          mark,
          Text(c.title, {
            fontSize: 21, bold: true, color: t.ink, flex: 1,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          }),
        ]),
        Shape({ geometry: 'rect', width: 36, height: 3, fill: t.accent }),
        c.stat?.value
          ? VStack({ gap: 2, align: 'start' }, [
              Text(c.stat.value, {
                fontSize: 34, bold: true, color: t.accent, singleLine: true,
                fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
              }),
              c.stat.label
                ? Text(c.stat.label, { fontSize: 14, color: t.muted, fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast })
                : nothing(),
            ])
          : nothing(),
        ...body.map((p) => Text(p, {
          fontSize: 16, color: t.ink, lineHeightPt: 26,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })),
        ...(c.points ?? []).filter((p) => String(p ?? '').trim()).map((p) =>
          HStack({ gap: 10, align: 'start' }, [
            Shape({ geometry: 'ellipse', width: 7, height: 7, fill: t.accent,
              padding: { top: 9, left: 0, right: 0, bottom: 0 } }),
            Text(p, { fontSize: 16, color: t.ink, flex: 1, lineHeightPt: 25,
              fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast }),
          ])),
      ]),
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
      HStack({ gap: 24, align: 'stretch', flex: 1 }, columns),
    ]),
    { bounds: b },
  );
}
