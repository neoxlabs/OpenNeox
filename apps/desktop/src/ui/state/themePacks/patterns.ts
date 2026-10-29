/* ============================================================
 * 主题包 pattern overlay — 内联 SVG data URL
 *
 * 这些 pattern 平铺到整个窗口, 用 mix-blend-mode (dark=screen / light=multiply)
 * 跟壁纸渐变叠加, 是 "幻彩机核" / "水墨国风" / "樱花" 高级感的关键.
 *
 * 全部用 SVG (轻量, 可缩放, 不要 PNG). 颜色用 stroke 单色 + 半透明,
 * 由 blend-mode 决定最终视觉.
 * ============================================================ */

const encode = (svg: string): string =>
  `url("data:image/svg+xml;utf8,${svg.replace(/\s+/g, ' ').replace(/#/g, '%23').replace(/"/g, "'").trim()}")`;

/* 1. 机核电路板 — cyber pack 用 (霓虹紫/极光/蒸汽波) */
export const PATTERN_CIRCUIT = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <g fill="none" stroke="white" stroke-width="0.6" opacity="0.55">
    <path d="M30 30 L30 100 L80 100 L80 60 L150 60 L150 120 L200 120" />
    <path d="M30 180 L80 180 L80 140 L130 140 L130 200 L200 200" />
    <path d="M210 30 L210 90 L170 90" />
    <circle cx="30" cy="30" r="3" />
    <circle cx="80" cy="60" r="2" />
    <circle cx="150" cy="60" r="2" />
    <circle cx="200" cy="120" r="3" />
    <circle cx="130" cy="140" r="2" />
    <circle cx="80" cy="180" r="3" />
    <circle cx="200" cy="200" r="2" />
    <circle cx="210" cy="30" r="2" />
    <circle cx="170" cy="90" r="3" />
    <rect x="60" y="78" width="12" height="6" rx="1" />
    <rect x="130" y="118" width="12" height="6" rx="1" />
  </g>
</svg>`);

/* 2. 矩阵数字雨 — matrix pack 用 */
export const PATTERN_MATRIX = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200" viewBox="0 0 160 200">
  <g font-family="monospace" font-size="11" fill="lime" opacity="0.7">
    <text x="20" y="20">01</text>
    <text x="20" y="50">10</text>
    <text x="20" y="80">01</text>
    <text x="60" y="35">11</text>
    <text x="60" y="65">00</text>
    <text x="60" y="95">10</text>
    <text x="100" y="25">11</text>
    <text x="100" y="55">01</text>
    <text x="100" y="85">00</text>
    <text x="140" y="40">10</text>
    <text x="140" y="70">11</text>
    <text x="20" y="120">11</text>
    <text x="60" y="125">00</text>
    <text x="100" y="115">10</text>
    <text x="20" y="150">10</text>
    <text x="60" y="155">01</text>
    <text x="100" y="145">11</text>
    <text x="20" y="180">01</text>
    <text x="60" y="185">11</text>
    <text x="100" y="175">00</text>
  </g>
</svg>`);

/* 3. 樱花瓣 — sakura pack 用 */
export const PATTERN_SAKURA = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <g fill="pink" opacity="0.45">
    <path d="M40 40 Q35 30 45 28 Q55 30 50 40 Q60 35 58 45 Q55 55 45 50 Q35 55 38 45 Q28 50 30 40 Q35 35 40 40 Z" />
    <path d="M120 80 Q115 70 125 68 Q135 70 130 80 Q140 75 138 85 Q135 95 125 90 Q115 95 118 85 Q108 90 110 80 Q115 75 120 80 Z" />
    <path d="M70 150 Q65 140 75 138 Q85 140 80 150 Q90 145 88 155 Q85 165 75 160 Q65 165 68 155 Q58 160 60 150 Q65 145 70 150 Z" />
    <path d="M170 130 Q165 120 175 118 Q185 120 180 130 Q190 125 188 135 Q185 145 175 140 Q165 145 168 135 Q158 140 160 130 Q165 125 170 130 Z" />
  </g>
</svg>`);

/* 4. 水墨笔触 — ink pack 用 */
export const PATTERN_INK_BRUSH = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <g fill="none" stroke="black" stroke-width="1.2" opacity="0.35">
    <path d="M20 40 Q60 35 100 50 T200 60" stroke-linecap="round" />
    <path d="M50 120 Q90 110 130 130 T230 140" stroke-linecap="round" />
    <path d="M30 200 Q70 195 110 215 T210 220" stroke-linecap="round" />
    <path d="M80 260 Q120 255 160 275 T260 280" stroke-linecap="round" />
  </g>
</svg>`);

/* 5. 蒸汽波网格 — vaporwave 用 */
export const PATTERN_VAPOR_GRID = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <g fill="none" stroke="cyan" stroke-width="0.5" opacity="0.6">
    <line x1="0" y1="0" x2="120" y2="120" />
    <line x1="60" y1="0" x2="60" y2="120" />
    <line x1="0" y1="60" x2="120" y2="60" />
    <line x1="120" y1="0" x2="0" y2="120" />
  </g>
</svg>`);

/* 6. 星点 — 夜空感 (海月 / 极光) */
export const PATTERN_STARS = encode(`
<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280">
  <g fill="white" opacity="0.8">
    <circle cx="30" cy="40" r="0.8" />
    <circle cx="80" cy="20" r="1.2" />
    <circle cx="140" cy="60" r="0.7" />
    <circle cx="210" cy="30" r="1.0" />
    <circle cx="260" cy="80" r="0.9" />
    <circle cx="50" cy="110" r="0.6" />
    <circle cx="120" cy="140" r="1.4" />
    <circle cx="180" cy="120" r="0.7" />
    <circle cx="240" cy="160" r="1.0" />
    <circle cx="40" cy="190" r="1.1" />
    <circle cx="100" cy="220" r="0.6" />
    <circle cx="170" cy="200" r="1.3" />
    <circle cx="230" cy="240" r="0.8" />
    <circle cx="60" cy="260" r="0.9" />
  </g>
</svg>`);
