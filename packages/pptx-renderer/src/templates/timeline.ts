/**
 * timeline — 时间轴 / 步骤. 一天行程 / 项目里程碑 / 流程.
 *
 * 视觉架构 (Neox PDS):
 *   kicker + sectionTitle + timelineTrack (自带圆点 + 内白点 + accent 主轴) + footer
 */

import type { Presentation } from '../builder/index.js';
import { kicker, sectionTitle, timelineTrack, footer, pageNumber } from '../design/primitives.js';
import { WARM_EDITORIAL, PAGE, SPACE, type NeoxTheme } from '../design/tokens.js';

export const meta = {
  id: 'timeline',
  category: 'process',
  useWhen: 'sequential steps, roadmap, milestones, day-by-day itinerary, hourly agenda, process flow',
  avoidWhen: 'non-sequential list (use bullet-list), narrative content (use title-body)',
  slots: {
    kicker: { required: false, maxChars: 40 },
    title: { required: false, maxChars: 32 },
    steps: { required: true, minItems: 2, maxItems: 6, kind: '[{label, detail?}]', maxCharsPerLabel: 16, maxCharsPerDetail: 32 },
    pageNumber: { required: false },
    footerText: { required: false },
  },
  typographyBudget: { titlePt: 32, labelPt: 18, detailPt: 12 },
  densityBudget: 'medium',
} as const;

export interface TimelineStep {
  label: string;
  detail?: string;
}

export interface TimelineSlots {
  kicker?: string;
  title?: string;
  steps: TimelineStep[];
  pageNumber?: string | number;
  footerText?: string;
  theme?: NeoxTheme;
}

export function timeline(ppt: Presentation, slots: TimelineSlots) {
  const theme = slots.theme ?? WARM_EDITORIAL;
  const W = ppt.model.slideWidth / 9525;
  const H = ppt.model.slideHeight / 9525;

  const slide = ppt.slides.add();
  slide.background.fill = theme.palette.paper;

  let cursorY = PAGE.padTop;

  if (slots.kicker) {
    kicker(slide, slots.kicker,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 20 },
      { theme },
    );
    cursorY += SPACE.xl + 4; /* 加宽 kicker→title 呼吸 (原 28px → 36px), 避免部分 viewer 视觉贴脸 */
  }

  if (slots.title) {
    sectionTitle(slide, slots.title,
      { l: PAGE.padH, t: cursorY, w: W - PAGE.padH * 2, h: 50 },
      { theme },
    );
    cursorY += 50 + SPACE.xl;
  }

  /* timeline track · 居中垂直位置 */
  const trackH = 120;
  const trackY = Math.max(cursorY + SPACE.xl, (H - trackH) / 2);
  timelineTrack(slide, slots.steps,
    { l: PAGE.padH, t: trackY, w: W - PAGE.padH * 2, h: trackH },
    { theme },
  );

  if (slots.footerText) {
    footer(slide, { width: W, height: H }, { left: slots.footerText, theme });
  }
  if (slots.pageNumber != null) {
    pageNumber(slide, slots.pageNumber, { width: W, height: H }, { theme });
  }

  return slide;
}
