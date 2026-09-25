import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme, contentBounds } from './theme.js';
import { mixHex } from './motif-bits.js';
import { stepNodeMotif, nothing } from './motif-bits.js';

export interface TimelineSlots {
  kicker?: string;
  title?: string;
  steps: Array<{ label: string; detail?: string }>;
}

export function timeline(slide: Slide, slots: TimelineSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const b = contentBounds(1280, 720);

  const n = slots.steps.length;
  const label = (step: { label: string; detail?: string }, i: number, above: boolean) => {
    const align = i === 0 ? 'l' : i === n - 1 ? 'r' : 'ctr';
    const labelText = Text(step.label, {
      fontSize: 19, bold: true, color: t.ink,
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      textAlign: align, singleLine: true,
    });
    const detailText = step.detail
      ? Text(step.detail, {
          fontSize: 15, color: t.muted,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          textAlign: align,
        })
      : nothing();

    const stem = Shape({
      geometry: 'rect', width: 2, flex: 1, alignSelf: 'center',
      fill: mixHex(t.subtle, t.ink, 0.30),
    });

    return VStack({
      flex: 1, align: 'stretch', gap: 8,
      padding: above ? { top: 0, left: 0, right: 0, bottom: 0 } : { top: 0, left: 0, right: 0, bottom: 0 },
    }, above ? [labelText, detailText, stem] : [stem, labelText, detailText]);
  };

  const stepCells = slots.steps.map((step, i) => {
    const above = i % 2 === 0;
    return VStack({ flex: 1, align: 'stretch' }, [
      above ? label(step, i, true) : VStack({ flex: 1 }, []),
      /* 三层配方节点 (背衬 + 实体 + 序号白圆) —— 时间轴上的节点是这一页的主角 */
      ZStack({ align: 'center' }, [stepNodeMotif({ index: i + 1, width: 132, height: 86 })]),
      above ? VStack({ flex: 1 }, []) : label(step, i, false),
    ]);
  });

  render(slide,
    VStack({ gap: 32, align: 'stretch', width: b.width, height: b.height }, [
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
      /* 时间轴带轨道 · ZStack 让轨道横穿点后 */
      ZStack({ align: 'center', flex: 1 }, [
        Shape({ geometry: 'rect', width: b.width, height: 4, fill: mixHex(t.subtle, t.ink, 0.42) }),
        /* alignSelf:'stretch' —— ZStack 里子节点默认按自己的 preferred 高摆,
         * 这一行必须吃满整个 flex 空档, 上下槽的 flex:1 才有东西可分。 */
        HStack({ align: 'stretch', alignSelf: 'stretch', gap: 24, justify: 'spaceBetween', width: b.width }, stepCells),
      ]),
    ]),
    { bounds: b },
  );
}
