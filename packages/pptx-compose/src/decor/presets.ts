/**
 * decor/presets — 预制装饰 HTML 片段库 · WPS 稻壳级视觉的关键.
 *
 * 每个 preset 返回完整 HTML 文档字符串 · 参数化了主题色和尺寸.
 * Agent 调 `htmlDecor.blueCorporateBackdrop(theme, 1280, 720)` 得到一段 HTML,
 * 传给 renderHtmlToImage 得 PNG dataUrl · 嵌到 slide 做背景.
 *
 * 覆盖:
 *   - blueCorporateStairs · 蓝色商务风 3D 楼梯背景 (对齐 WPS 稻壳蓝色商务模板)
 *   - editorialGrid · 编辑感网格纹理背景
 *   - abstractGeometry · 抽象几何色块
 *   - subtleGradient · 品牌色渐变
 *   - dotPattern · 点阵背景
 *   - waveLines · 波浪线条
 */

import type { NeoxComposeTheme } from '../templates/themes.js';

function head(width: number, height: number, extraStyles: string = ''): string {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  ${extraStyles}
</style>
</head>
<body>`;
}
function foot(): string { return `</body></html>`; }

/** 蓝色商务风 · 3D 楼梯建筑背景 · 对齐 WPS 稻壳"蓝色商务风产品发布会"模板 */
export function blueCorporateStairs(theme: NeoxComposeTheme, w: number, h: number): string {
  return head(w, h, `
    body { background: linear-gradient(135deg, ${theme.paper} 0%, ${theme.accentSoft} 100%); }
    .stage { position: absolute; right: -20%; top: -10%; width: 90%; height: 120%; transform: perspective(1000px) rotateY(-25deg); }
    .step {
      position: absolute; background: linear-gradient(180deg, ${theme.paper}FF 0%, ${theme.paper}CC 100%);
      border-top: 1px solid ${theme.accentSoft};
      box-shadow: 0 4px 20px ${theme.subtle}88;
    }
    ${Array.from({ length: 12 }, (_, i) => `
    .step-${i} { top: ${i * 8}%; left: ${i * 3}%; width: ${100 - i * 6}%; height: ${8}%; }`).join('')}
    .accent-line {
      position: absolute; bottom: 15%; left: 8%; width: 4px; height: 20%;
      background: ${theme.accent};
    }
    .bg-square {
      position: absolute; top: 0; left: 0; width: 40%; height: 100%;
      background: linear-gradient(180deg, transparent 0%, ${theme.subtle}44 100%);
    }
  `) + `
  <div class="bg-square"></div>
  <div class="stage">
    ${Array.from({ length: 12 }, (_, i) => `<div class="step step-${i}"></div>`).join('')}
  </div>
  <div class="accent-line"></div>
  ` + foot();
}

/** 编辑感网格 · 8x8 格子淡叠 · 复古 magazine 感 */
export function editorialGrid(theme: NeoxComposeTheme, w: number, h: number): string {
  const cellW = w / 12;
  const cellH = h / 8;
  return head(w, h, `
    body { background: ${theme.paper}; position: relative; }
    .grid-cell {
      position: absolute;
      width: ${cellW}px; height: ${cellH}px;
      border-right: 1px solid ${theme.subtle}66;
      border-bottom: 1px solid ${theme.subtle}66;
    }
    .accent-block {
      position: absolute; top: 20%; left: 8%;
      width: 60px; height: 60px;
      background: ${theme.accent};
      opacity: 0.9;
    }
    .accent-line-h {
      position: absolute; top: 33%; left: 8%;
      width: ${w * 0.3}px; height: 2px;
      background: ${theme.accent};
    }
  `) + `
  ${Array.from({ length: 12 * 8 }, (_, i) => {
    const col = i % 12;
    const row = Math.floor(i / 12);
    return `<div class="grid-cell" style="top:${row * cellH}px;left:${col * cellW}px"></div>`;
  }).join('')}
  <div class="accent-block"></div>
  <div class="accent-line-h"></div>
  ` + foot();
}

/** 抽象几何 · 多个大色块交错 · 现代感 */
export function abstractGeometry(theme: NeoxComposeTheme, w: number, h: number): string {
  return head(w, h, `
    body { background: ${theme.ink}; position: relative; overflow: hidden; }
    .shape { position: absolute; }
    .circle-a {
      right: 15%; top: -10%; width: 45%; height: 45%;
      background: ${theme.accent}; border-radius: 50%; opacity: 0.28;
    }
    .circle-b {
      right: 30%; top: 40%; width: 30%; height: 30%;
      background: ${theme.accentSoft}; border-radius: 50%; opacity: 0.18;
    }
    .rect-a {
      left: 5%; top: 20%; width: 8px; height: 40%;
      background: ${theme.accent}; opacity: 0.85;
    }
    .rect-b {
      bottom: 0; left: 0; width: 100%; height: 6px;
      background: ${theme.accentDeep}; opacity: 0.9;
    }
    .accent-diag {
      position: absolute; left: 5%; top: 60%;
      width: ${w * 0.2}px; height: 3px;
      background: ${theme.accentSoft}; opacity: 0.6;
      transform: rotate(-15deg);
    }
  `) + `
  <div class="shape circle-a"></div>
  <div class="shape circle-b"></div>
  <div class="shape rect-a"></div>
  <div class="shape rect-b"></div>
  <div class="accent-diag"></div>
  ` + foot();
}

/** 淡渐变 · 品牌色由深到浅 */
export function subtleGradient(theme: NeoxComposeTheme, w: number, h: number, direction: 'to bottom' | 'to right' = 'to bottom'): string {
  return head(w, h, `
    body { background: linear-gradient(${direction}, ${theme.accentSoft}66 0%, ${theme.paper} 100%); }
  `) + foot();
}

/** 点阵 · 8pt 圆点 32px 间距 · 底子 */
export function dotPattern(theme: NeoxComposeTheme, w: number, h: number): string {
  return head(w, h, `
    body {
      background: ${theme.paper};
      background-image: radial-gradient(circle, ${theme.subtle}88 1px, transparent 1px);
      background-size: 32px 32px;
    }
  `) + foot();
}

/** 波浪线条 · SVG 波浪 · 品牌色叠 */
export function waveLines(theme: NeoxComposeTheme, w: number, h: number): string {
  return head(w, h, `
    body { background: ${theme.paper}; position: relative; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  `) + `
  <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M0,${h * 0.7} Q${w * 0.25},${h * 0.55} ${w * 0.5},${h * 0.7} T${w},${h * 0.7} L${w},${h} L0,${h} Z"
          fill="${theme.accentSoft}" opacity="0.4"/>
    <path d="M0,${h * 0.8} Q${w * 0.3},${h * 0.65} ${w * 0.6},${h * 0.8} T${w},${h * 0.8} L${w},${h} L0,${h} Z"
          fill="${theme.accent}" opacity="0.6"/>
    <path d="M0,${h * 0.9} Q${w * 0.35},${h * 0.75} ${w * 0.7},${h * 0.9} T${w},${h * 0.9} L${w},${h} L0,${h} Z"
          fill="${theme.accentDeep}" opacity="0.85"/>
  </svg>
  ` + foot();
}

/** 全部 preset · agent 挑用 */
export const htmlDecor = {
  blueCorporateStairs,
  editorialGrid,
  abstractGeometry,
  subtleGradient,
  dotPattern,
  waveLines,
};
