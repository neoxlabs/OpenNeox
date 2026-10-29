import { mapOutsideCodeFences } from './mdFences';


/** 行首 `1.x` / `1)x` → `1. x`; `-x` / `*x` / `+x` → `- x` */
const LOOSE_ORDERED = /^(\s{0,3})(\d{1,9})([.)])(?=[^\s\d])/gm;
const LOOSE_BULLET = /^(\s{0,3})([-*+])(?=[^\s\-*+=>|])/gm;

function fixSegment(seg: string): string {
  let out = seg.replace(LOOSE_ORDERED, '$1$2$3 ');
  /* 无序项更容易误伤 (`---` 分隔线、`*强调*`、`-->`), 所以排除了紧跟的标点。
   * `*bold*` 这种整行强调仍会被排除, 因为 `*` 后是字母时才补 —— 这里接受一点点保守:
   * 只有当同一段里出现 ≥2 个这种行首标记时才认为是清单。 */
  const bulletLines = (seg.match(LOOSE_BULLET) || []).length;
  if (bulletLines < 2) return out;
  out = out.replace(LOOSE_BULLET, '$1$2 ');
  return out;
}

export function normalizeLooseLists(text: string): string {
  if (!text) return text;
  return mapOutsideCodeFences(text, fixSegment);
}
