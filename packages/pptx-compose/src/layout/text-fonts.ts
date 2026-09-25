/**
 * layout/text-fonts — TextParams → 实际字体名解析 (measure 与 paint 的共同事实源).
 *
 * 解析优先级: 显式 fontLatin/fontEast > role (display/text/numeric) > 主题 text 字体.
 * measure 用它选 metrics 记录, paint 用它写 OOXML <a:latin>/<a:ea> —
 * 两边必须走同一个函数, 否则"测的字体"和"导出的字体"不一致 = 回到靠猜.
 */

import type { TextParams } from '../compose/types.js';
import { NEOX_THEME } from '../templates/theme.js';

export interface ResolvedTextFonts {
  fontLatin: string;
  fontEast: string;
}

export function resolveTextFonts(p: TextParams | undefined): ResolvedTextFonts {
  const f = NEOX_THEME.fonts;
  let fontLatin: string;
  let fontEast: string;
  switch (p?.role) {
    case 'display':
      fontLatin = f.displayLatin;
      fontEast = f.displayEast;
      break;
    case 'numeric':
      fontLatin = f.numeric;
      fontEast = f.textEast;
      break;
    default:
      fontLatin = f.textLatin;
      fontEast = f.textEast;
  }
  if (p?.fontLatin) fontLatin = p.fontLatin;
  if (p?.fontEast) fontEast = p.fontEast;
  return { fontLatin, fontEast };
}
