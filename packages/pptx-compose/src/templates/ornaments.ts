/**
 * ornaments — 内置的精细矢量纹样
 *
 * 需求： "为什么没有造型优雅的内置图形? 出图又慢。" 生图一张要一两分钟, 而且出来是位图、
 * 改不了色。这里的纹样全部是**算出来的矢量路径**: 秒出、跟着主题色、在 PowerPoint 里仍是可编辑图形。
 *
 * 三类, 都是金融/正式文书里真实存在的视觉语言, 不是随手画的装饰:
 *   · guilloche 细线纹 —— 钞票、支票、股票凭证上那种多条正弦交织的细线带。本来就是银行的纹样。
 *   · rosette 玫瑰纹章 —— 同一种技法绕成圆, 证书和票面上的防伪圆章。
 *   · rings 同心环 —— 编辑类版式里的几何点缀 (一组环 + 圆心点)。
 *
 * 【为什么是纯函数】这里只算路径, 不决定颜色和位置 —— 那由调用方 (装饰层 / 封面背景) 按
 * 当前风格和底色决定。路径算法写在一处, 封面和内容页用的才是同一套纹样。
 *
 * 【定型不随机】全部是确定的三角函数, 没有随机数: 同一份 deck 每次导出必须一模一样。
 */

import type { VectorPath } from './diagram-bits.js';

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 钞票细线纹带: strands 条正弦线, 相位均匀错开, 振幅再被一个慢波包络调制 ——
 * 包络让线在某些位置收拢、某些位置张开, 这正是 guilloche 的"绞索"感;
 * 没有包络就只是几条平行波浪线。
 *
 * 纵向永远落在 [0, h] 内 (振幅 ≤ h/2 × 0.96), 放进多高的框都不会越界。
 */
export function guillochePath(w: number, h: number, opts?: {
  strands?: number; waves?: number; envelope?: number; samples?: number;
}): VectorPath {
  const n = Math.max(2, opts?.strands ?? 9);
  const waves = opts?.waves ?? 7;
  const envelope = opts?.envelope ?? 2;
  const S = Math.max(60, opts?.samples ?? 260);
  const cy = h / 2;
  const parts: string[] = [];
  for (let k = 0; k < n; k++) {
    const ph = (k / n) * Math.PI * 2;
    const pts: string[] = [];
    for (let i = 0; i <= S; i++) {
      const u = (i / S) * Math.PI * 2;
      const env = 0.55 + 0.45 * Math.sin(u * envelope + ph * 0.5);
      pts.push(`${r2((i / S) * w)} ${r2(cy + Math.sin(u * waves + ph) * (h / 2) * env * 0.96)}`);
    }
    parts.push(`M${pts.join(' L')}`);
  }
  return { d: parts.join(' '), viewBox: { width: w, height: h } };
}

export interface RosetteRing {
  /** 基准半径, 相对外接圆半径 (0~1) */
  r: number;
  /** 起伏幅度, 同单位。r + amp 必须 ≤ 1 */
  amp: number;
  /** 一圈几个花瓣 */
  lobes: number;
  /** 同一圈叠几条错相的线 —— 叠出来的交织就是"纹章"而不是"花边" */
  copies: number;
}

/**
 * 玫瑰纹章: 几圈极坐标波形 ρ(θ) = r + amp·sin(lobes·θ + φ), 每圈叠 copies 条错相线。
 * 外圈花瓣多而浅、内圈少而深, 由外向内收 —— 跟票面防伪圆章同一种构造。
 */
export function rosettePath(size: number, opts?: { rings?: RosetteRing[]; samples?: number }): VectorPath {
  const c = size / 2;
  const S = Math.max(120, opts?.samples ?? 360);
  const rings = opts?.rings ?? [
    { r: 0.86, amp: 0.10, lobes: 18, copies: 5 },
    { r: 0.60, amp: 0.09, lobes: 12, copies: 4 },
    { r: 0.36, amp: 0.07, lobes: 8, copies: 3 },
  ];
  const parts: string[] = [];
  for (const ring of rings) {
    for (let j = 0; j < ring.copies; j++) {
      const ph = (j / ring.copies) * Math.PI * 2;
      const pts: string[] = [];
      for (let i = 0; i < S; i++) {
        const th = (i / S) * Math.PI * 2;
        const rho = c * (ring.r + ring.amp * Math.sin(ring.lobes * th + ph));
        pts.push(`${r2(c + rho * Math.cos(th))} ${r2(c + rho * Math.sin(th))}`);
      }
      parts.push(`M${pts.join(' L')} Z`);
    }
  }
  return { d: parts.join(' '), viewBox: { width: size, height: size } };
}

/** 同心圆 (全圆, 描边用)。fracs 是相对外接圆半径的比例, 1 = 贴边 */
export function ringsPath(size: number, fracs: number[] = [1, 0.72, 0.44]): VectorPath {
  const c = size / 2;
  const d = fracs.map((f) => {
    const r = c * f;
    /* 单段 360° 弧在 SVG 里是退化的, 必须两段半弧 */
    return `M${r2(c - r)},${r2(c)} A${r2(r)},${r2(r)} 0 1 0 ${r2(c + r)},${r2(c)} A${r2(r)},${r2(r)} 0 1 0 ${r2(c - r)},${r2(c)} Z`;
  }).join(' ');
  return { d, viewBox: { width: size, height: size } };
}

/** 实心圆点 (圆心点用) */
export function dotPath(size: number): VectorPath {
  return ringsPath(size, [1]);
}
