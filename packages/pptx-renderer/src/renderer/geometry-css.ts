/**
 * geometry-css 将 OOXML preset geometry 映射为 CSS clip-path，
 * 供 React 预览和 slide-html QA 管线共享。
 */

/** prst → CSS clip-path. 没收录的返回 undefined (渲染端退回矩形). */
export function clipPathForGeometry(prst: string | undefined): string | undefined {
  if (!prst) return undefined;
  return GEOM_CLIP_PATH[prst];
}

const GEOM_CLIP_PATH: Record<string, string> = {
  triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)',
  star5: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  star6: 'polygon(50% 0%, 63% 25%, 93% 25%, 78% 50%, 93% 75%, 63% 75%, 50% 100%, 37% 75%, 7% 75%, 22% 50%, 7% 25%, 37% 25%)',
  pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
  hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
  chevron: 'polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%)',
  homePlate: 'polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%)',
  rightArrow: 'polygon(0% 30%, 60% 30%, 60% 0%, 100% 50%, 60% 100%, 60% 70%, 0% 70%)',
  leftArrow: 'polygon(100% 30%, 40% 30%, 40% 0%, 0% 50%, 40% 100%, 40% 70%, 100% 70%)',
  upArrow: 'polygon(50% 0%, 100% 40%, 70% 40%, 70% 100%, 30% 100%, 30% 40%, 0% 40%)',
  downArrow: 'polygon(50% 100%, 100% 60%, 70% 60%, 70% 0%, 30% 0%, 30% 60%, 0% 60%)',
  /* line/straightConnector1: 细长矩形本身就是视觉正确近似, 不需要 clip */
};
