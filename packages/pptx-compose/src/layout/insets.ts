/**
 * insets · padding/margin 归一化 helper.
 */

import type { Insets } from '../compose/types.js';

/** 数字或部分 Insets 归一化到完整 Insets. */
export function normalizeInsets(v: number | Partial<Insets> | undefined): Insets {
  if (v == null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof v === 'number') return { top: v, right: v, bottom: v, left: v };
  return {
    top: v.top ?? 0,
    right: v.right ?? 0,
    bottom: v.bottom ?? 0,
    left: v.left ?? 0,
  };
}

export function horizontalInsets(v: Insets): number {
  return v.left + v.right;
}
export function verticalInsets(v: Insets): number {
  return v.top + v.bottom;
}
