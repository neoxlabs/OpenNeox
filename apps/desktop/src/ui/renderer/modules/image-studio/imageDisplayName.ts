
import type React from 'react';

/** 标题上限 —— 两行大约就是这个量级, 超了截断加省略号 (CSS 行数裁剪之外的兜底)。 */
const MAX_TITLE_CHARS = 64;

export interface ImageDisplayName {
  /** 铺在标题位的短名 */
  title: string;
  /** 完整文件名 —— 给 title 属性 (悬浮看全) */
  full: string;
}

export function imageDisplayName(filename: string): ImageDisplayName {
  const full = filename || '';
  let stem = full.replace(/\.[A-Za-z0-9]{1,6}$/, '');       // 去扩展名
  stem = stem.replace(/[-_]\d{10,}(?:[-_]\d+)?$/, '');      // 去尾部时间戳 (可能还带一个序号)
  stem = stem.trim() || full;
  const title = stem.length > MAX_TITLE_CHARS ? `${stem.slice(0, MAX_TITLE_CHARS - 1)}…` : stem;
  return { title, full };
}

/** 标题位的排版: 两行封顶, 超出省略, 长词也能断行 (中文长串不留缝) */
export const IMAGE_TITLE_CLAMP: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  wordBreak: 'break-word',
};
