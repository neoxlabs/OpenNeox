/**
 * cover-hero (compose 版) — 大字封面 · 用 declarative DSL 完全重写.
 *
 * 结构 (声明式):
 *   ZStack {
 *     Background image or gradient decor (bleed 满 slide)
 *     VStack (bottom-aligned, left) {
 *       Kicker (小字 uppercase)
 *       HeroTitle (大字)
 *       AccentBar (48x4 rect)
 *       Subtitle
 *     }
 *   }
 *
 * 保证: 内容不叠 · title 自动换行时后续元素自动下推.
 */

import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import {
  VStack, ZStack, Text, Image, Shape, Spacer,
} from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { heroBackdropLayers, titleMarkShape, nothing, dividerMotif , readableAccent } from './motif-bits.js';

export interface CoverHeroSlots {
  tag?: string;
  title: string;
  subtitle?: string;
  footerText?: string;
  backgroundImage?: any; /* NonNullable<ImageNode['source']> */
}

export function coverHero(slide: Slide, slots: CoverHeroSlots) {
  const theme = activeTheme();
  slide.background.fill = theme.paper;

  const hasImage = !!slots.backgroundImage;
  const textColor = hasImage ? '#FFFFFF' : theme.onInk;
  const kickerColor = hasImage ? theme.onInk : readableAccent(theme.ink);
  /* 记号和 kicker 要分开取色: 小字需要**亮度**对比 (所以照片上只能白),
   * 而记号是一块纯色形状 —— 靠色相就能读出来, 亮度对比低一点无所谓。
   * 共用一个颜色的话, 图片封面会连 accent 都不剩, 风格标识整个没了。 */
  const markColor = hasImage ? theme.accent : kickerColor;

  render(slide,
    ZStack({ align: 'start' }, [
      /* 背景层 · 满出血 */
      hasImage
        ? Image(slots.backgroundImage, {
            /* 满出血背景图 —— 声明 bleed, 让 overlap 断言把它当背景而不是内容 */
            bleed: true,
            fit: 'cover', width: 1280, height: 720,
            filter: { lum: { brightness: -0.15, contrast: 0.1 } },
          })
        : Shape({
            geometry: 'rect', width: 1280, height: 720,
            fill: theme.ink,
          }),

      hasImage
        ? Shape({
            geometry: 'rect', width: 1280, height: 580,
            gradient: {
              angleDeg: 90,
              stops: [
                { pos: 0, color: 'rgba(0, 0, 0, 0)' },
                { pos: 0.19, color: 'rgba(0, 0, 0, 0.55)' },
                { pos: 1, color: 'rgba(0, 0, 0, 0.68)' },
              ],
            },
            padding: { top: 140, left: 0, right: 0, bottom: 0 },
          })
        : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),

      !hasImage ? heroBackdropLayers({ tone: 'onDark' }) : nothing(),
      nothing(),

      /* 内容层 · 底部左对齐. 用 VStack 保证元素自然堆叠不叠. */
      VStack({
        padding: { top: 0, left: 72, right: 72, bottom: 72 },
        justify: 'end', /* 内容推到底 */
        align: 'start',
        gap: 16,
        width: 1280,
        height: 720,
      }, [
        Spacer({}), /* 推内容到底 */
        slots.tag
          ? Text(slots.tag, {
              fontSize: 14, bold: true, color: kickerColor,
              letterSpacingPt: 2.4, uppercase: true,
              fontLatin: theme.fonts.textLatin, fontEast: theme.fonts.textEast,
              width: 800,
            })
          : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
        Text(slots.title, {
          fontSize: 60, bold: true, color: textColor,
          letterSpacingPt: -0.5,
          fontLatin: theme.fonts.displayLatin, fontEast: theme.fonts.displayEast,
          width: 1000,
        }),
        dividerMotif(64, 16, markColor),
        slots.subtitle
          ? Text(slots.subtitle, {
              fontSize: 20, color: textColor,
              fontLatin: theme.fonts.textLatin, fontEast: theme.fonts.textEast,
              width: 900,
            })
          : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
        slots.footerText
          ? Text(slots.footerText, {
              fontSize: 12, color: theme.onInk,
              letterSpacingPt: 0.4,
              fontLatin: theme.fonts.textLatin, fontEast: theme.fonts.textEast,
              padding: { top: 16, left: 0, right: 0, bottom: 0 },
              width: 600,
            })
          : Shape({ geometry: 'rect', width: 0, height: 0, fill: 'rgba(0,0,0,0)' }),
      ]),
    ]),
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  );
}
