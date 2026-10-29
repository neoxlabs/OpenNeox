/**
 * units — EMU / px / pt 单位换算, isomorphic.
 *
 * pptx OOXML 内部一切位置都用 EMU (English Metric Unit):
 *   1 inch  = 914400 EMU
 *   1 point = 12700 EMU (914400 / 72)
 *   1 CSS px @ 96 DPI = 9525 EMU (914400 / 96)
 *
 * Builder API 对外用 CSS px (跟 Codex 的 1280x720 slideSize 一致, 直觉友好).
 * 内部数据模型统一存 EMU, 保证 parser 出来的和 builder 出来的能进同一套渲染 / 导出.
 */

export const EMU_PER_INCH = 914400;
export const EMU_PER_PT = 12700;
export const EMU_PER_PX_96DPI = 9525;

export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_PX_96DPI);
}

export function emuToPx(emu: number): number {
  return emu / EMU_PER_PX_96DPI;
}

export function ptToEmu(pt: number): number {
  return Math.round(pt * EMU_PER_PT);
}

export function emuToPt(emu: number): number {
  return emu / EMU_PER_PT;
}

/** OOXML rPr 里 sz 属性是 hundredths of pt (44 pt → sz="4400"). */
export function ptToRPrSz(pt: number): number {
  return Math.round(pt * 100);
}

export function rPrSzToPt(sz: number): number {
  return sz / 100;
}

/** OOXML pct 属性 (spcBef/lumMod 等) 单位是 percent-thousandths (100000 = 100%). */
export function pctToPercent(pct: number): number {
  return pct / 1000;
}

export function percentToPct(percent: number): number {
  return Math.round(percent * 1000);
}
