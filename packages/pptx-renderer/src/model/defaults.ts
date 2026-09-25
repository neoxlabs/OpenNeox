/**
 * defaults — 库级默认值 (slide size / theme / font / padding).
 * 集中一处让所有 builder / exporter / template 引用同一份, 改一处全生效.
 */

import { pxToEmu } from './units.js';

/** 默认 slide size 跟 Codex 一致: 1280x720 CSS px (对齐 16:9 web 标准). */
export const DEFAULT_SLIDE_WIDTH_PX = 1280;
export const DEFAULT_SLIDE_HEIGHT_PX = 720;
export const DEFAULT_SLIDE_WIDTH_EMU = pxToEmu(DEFAULT_SLIDE_WIDTH_PX);
export const DEFAULT_SLIDE_HEIGHT_EMU = pxToEmu(DEFAULT_SLIDE_HEIGHT_PX);

export const DEFAULT_BACKGROUND_COLOR = '#FFFFFF';
export const DEFAULT_TEXT_COLOR = '#1D2A2F';

/** 默认字号 (pt) — 标题 / 副标题 / 正文. Codex Grid 元数据里各模板会 override. */
export const DEFAULT_FONT_SIZE_TITLE_PT = 40;
export const DEFAULT_FONT_SIZE_SUBTITLE_PT = 22;
export const DEFAULT_FONT_SIZE_BODY_PT = 18;

/** 默认字体 — 主副字体分开. 中文场景我们用 PingFang SC 兜底. */
export const DEFAULT_MAJOR_FONT = 'PingFang SC';
export const DEFAULT_MINOR_FONT = 'PingFang SC';

/** 默认 Theme 12 色 (Office 兼容 slot 名). 单色系, 适合大多数场景. Agent 可以 override. */
export const DEFAULT_THEME_COLORS: Record<string, string> = {
  dk1: '#1D2A2F',
  lt1: '#FFFFFF',
  dk2: '#4B5563',
  lt2: '#F3F4F6',
  accent1: '#6366F1',
  accent2: '#EC4899',
  accent3: '#F59E0B',
  accent4: '#10B981',
  accent5: '#3B82F6',
  accent6: '#8B5CF6',
  hlink: '#2563EB',
  folHlink: '#7C3AED',
};

/** 文本框默认内边距 EMU (0.1 inch = 91440). */
export const DEFAULT_TEXT_PADDING_EMU = 91440;
