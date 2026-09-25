
import type { Slide } from '@neoxlabs/pptx-renderer';
import type { ComposeNode } from '../compose/types.js';
import { render } from '../bridge/render.js';
import { VStack, HStack, ZStack, Text, Shape } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { dividerMotif, mixHex, nothing } from './motif-bits.js';

export interface AgendaSlots {
  kicker?: string;
  title?: string;
  /** 2-6 项, 按顺序 */
  items: Array<{ title: string; desc?: string }>;
}

export function agenda(slide: Slide, slots: AgendaSlots) {
  const t = activeTheme();
  slide.background.fill = t.paper;
  const W = 1280;
  const H = 720;

  const items = (slots.items ?? []).slice(0, 6);
  const n = Math.max(1, items.length);
  const hasDesc = items.some((it) => !!it.desc);
  const rowH = Math.min(156, Math.floor(560 / n));
  const numSize = Math.max(24, Math.min(50, Math.floor((rowH - 42 - (hasDesc ? 26 : 0) - 10) / 1.67)));
  const step = n <= 3 ? 112 : n <= 4 ? 84 : 56;
  const NUM_W = 220;
  const x0 = 520;
  const top0 = Math.round((H - rowH * n) / 2);

  const numColor = mixHex(t.ink, t.paper, 0.38);
  const lineColor = mixHex(t.accent, t.paper, 0.25);

  const rows: ComposeNode[] = items.map((it, i) => {
    /* 第一项在最右, 逐项左移 */
    const x = x0 + (n - 1 - i) * step;
    const lineW = W - x - NUM_W - 20;
    return VStack({
      padding: { top: top0 + i * rowH, left: x, right: 0, bottom: 0 },
      gap: 4, align: 'start',
    }, [
      HStack({ align: 'center', gap: 20 }, [
        Text(String(i + 1).padStart(2, '0'), {
          fontSize: numSize, bold: true, color: numColor, singleLine: true, textAlign: 'r',
          width: NUM_W, letterSpacingPt: -1,
          fontLatin: t.fonts.numeric, fontEast: t.fonts.displayEast,
        }),
        /* 细线出血到页边 —— 被页边切断, 才读成"划分版面"而不是"一根装饰线" */
        Shape({ geometry: 'rect', width: lineW + 2, height: 1, fill: lineColor }),
      ]),
      Text(it.title, {
        fontSize: 16, color: t.ink, singleLine: true, textAlign: 'r', width: NUM_W,
        fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
      }),
      it.desc
        ? Text(it.desc, {
            fontSize: 12, color: t.muted, singleLine: true, textAlign: 'r', width: NUM_W,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
    ]);
  });

  const titleBlock = VStack({
    width: 440, height: H, justify: 'center', align: 'start', gap: 16,
    padding: { top: 0, left: 72, right: 0, bottom: 0 },
  }, [
    slots.kicker
      ? Text(slots.kicker, {
          fontSize: 13, bold: true, color: t.accent, letterSpacingPt: 2.4, uppercase: true,
          fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
        })
      : nothing(),
    Text(slots.title || '目录', {
      fontSize: 46, bold: true, color: t.ink, letterSpacingPt: -0.4,
      fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
    }),
    dividerMotif(64, 16),
  ]);

  render(slide, ZStack({ align: 'start', width: W, height: H }, [titleBlock, ...rows]), {
    bounds: { x: 0, y: 0, width: W, height: H },
    /* 行是按阶梯显式摆的, 求解器不该为了"填满"去挪它们 */
    fit: false,
  });
}
