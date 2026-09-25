import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { readableAccent, softInk } from './motif-bits.js';

export interface ContrastSlots {
  left: { label: string; headline: string; body?: string | string[] };
  right: { label: string; headline: string; body?: string | string[] };
}

export function contrast(slide: Slide, slots: ContrastSlots) {
  const t = activeTheme();

  function side(data: ContrastSlots['left'], dark: boolean) {
    const body = data.body ? (Array.isArray(data.body) ? data.body : [data.body]) : [];
    return VStack({ flex: 1, gap: 16, padding: 72, align: 'stretch', height: 720 }, [
      /* 深侧的 accent 必须过 readableAccent —— 和封面 kicker 同款的坑, 只是一直
       * 没人看这一页: minimal-line 的 accent 是深红 #8B0000, 写在深棕 ink 底上
       * 对比度不到 1.5, 这行 label 在那套风格里是**看不见**的。
       * 正文色原来写死 '#FFFFFF' / '#F1F5F9' —— 后者是 corporate 的 surface 色,
       * 被硬编码到所有主题上。深底上的文字色只有一个正确来源: t.onInk。 */
      Text(data.label.toUpperCase(), {
        fontSize: 12, bold: true, color: dark ? readableAccent(t.ink) : t.accent,
        letterSpacingPt: 2.4,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        padding: { top: 200, left: 0, right: 0, bottom: 0 },
      }),
      Text(data.headline, {
        fontSize: 36, bold: true, color: dark ? t.onInk : t.ink,
        letterSpacingPt: -0.2,
        fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
      }),
      ...body.map((p) => Text(p, {
        fontSize: 16, color: dark ? softInk(0.86) : t.ink,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      })),
    ]);
  }

  render(slide,
    ZStack({ align: 'start' }, [
      HStack({ align: 'stretch', width: 1280, height: 720 }, [
        VStack({ flex: 1, height: 720, background: t.ink }, []),
        VStack({ flex: 1, height: 720, background: t.paper }, []),
      ]),
      HStack({ align: 'stretch', width: 1280, height: 720 }, [
        side(slots.left, true),
        side(slots.right, false),
      ]),
      /* 中间强 accent 分割 · 手写位置 · 用 padding */
      Shape({
        geometry: 'rect', width: 2, height: 500, fill: t.accent,
        padding: { top: 110, left: 639, right: 0, bottom: 0 },
      }),
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
