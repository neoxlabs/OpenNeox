
import type {
  Presentation, Slide, Shape, TextShape, PictureShape, ShapeRect, TableShape,
  Paragraph, TextRun, Fill, Frame,
} from '../model/types.js';
import { clipPathForGeometry } from './geometry-css.js';

const EMU_PER_PT = 12700;
const CJK_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cssColor(c: string | undefined): string {
  const v = String(c ?? '').trim();
  if (!v) return 'transparent';
  return /^[0-9a-fA-F]{3,8}$/.test(v) ? `#${v}` : v;
}

function fillCss(fill: Fill | undefined): string {
  if (!fill) return '';
  switch (fill.kind) {
    case 'solid': return `background:${cssColor(fill.color)};`;
    case 'pic': return fill.src
      ? `background-image:url('${fill.src}');background-size:cover;background-position:center;`
      : '';
    case 'grad': {
      const stops = fill.stops.map((s) => `${cssColor(s.color)} ${(s.pos * 100).toFixed(1)}%`).join(', ');
      if (fill.radial) {
        const { cx, cy } = fill.radial;
        return `background:radial-gradient(circle at ${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%, ${stops});`;
      }
      const angle = (fill.angleDeg ?? 90) + 90;
      return `background:linear-gradient(${angle}deg, ${stops});`;
    }
    case 'none': return '';
  }
  return '';
}

function frameCss(frame: Frame, scale: number, rotation?: number, flipH?: boolean, flipV?: boolean): string {
  let css = `position:absolute;left:${frame.x * scale}px;top:${frame.y * scale}px;`
    + `width:${frame.w * scale}px;height:${frame.h * scale}px;`;
  const parts: string[] = [];
  if (rotation) parts.push(`rotate(${rotation}deg)`);
  if (flipH) parts.push('scaleX(-1)');
  if (flipV) parts.push('scaleY(-1)');
  if (parts.length) css += `transform:${parts.join(' ')};transform-origin:center center;`;
  return css;
}

function fontFamilyCss(s: TextRun['style']): string {
  if (s.fontLatin || s.fontEast) {
    const chain = [s.fontLatin, s.fontEast].filter(Boolean).map((f) => `"${f}"`).join(', ');
    return `${chain}, ${CJK_STACK}`;
  }
  const f = s.fontFamily;
  if (!f) return CJK_STACK;
  if (/PingFang|Hiragino|YaHei|Source Han|Noto Sans CJK|SimHei|SimSun|Songti|Kaiti|FangSong/.test(f)) return `"${f}"`;
  return `"${f}", ${CJK_STACK}`;
}

function runHtml(run: TextRun, scale: number): string {
  const s = run.style;
  const fontSizePx = (s.fontSizePt || 18) * EMU_PER_PT * scale;
  let css = `font-family:${esc(fontFamilyCss(s))};font-size:${fontSizePx}px;`
    + `font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};`
    + `white-space:pre-wrap;`;
  if (s.color) css += `color:${cssColor(s.color)};`;
  const deco = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css += `text-decoration:${deco};`;
  if (s.spacing) css += `letter-spacing:${s.spacing * scale}px;`;
  return `<span style="${css}">${esc(run.text)}</span>`;
}

function paragraphHtml(p: Paragraph, scale: number): string {
  const align = p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' ? 'justify' : null;
  /* 行高: lnSpc 钉死值优先 (跟 exporter/measure 同一数字), 老 deck 退 1.15 */
  const lineHeight = p.lineSpacingPt != null
    ? `${p.lineSpacingPt * EMU_PER_PT * scale}px`
    : '1.15';
  let css = `${align ? `text-align:${align};` : ''}line-height:${lineHeight};`;
  const maxRunPt = p.runs.reduce((m, r) => Math.max(m, r.style?.fontSizePt ?? 0), 0);
  if (maxRunPt > 0) css += `font-size:${maxRunPt * EMU_PER_PT * scale}px;`;
  if (p.spaceBeforeEmu) css += `margin-top:${p.spaceBeforeEmu * scale}px;`;
  if (p.spaceAfterEmu) css += `margin-bottom:${p.spaceAfterEmu * scale}px;`;
  if (p.level) css += `margin-left:${p.level * 400000 * scale}px;`;
  const bullet = p.bullet && p.bullet.kind === 'char'
    ? `<span style="margin-right:6px;">${esc(p.bullet.char)}</span>`
    : '';
  const runs = p.runs.map((r) => runHtml(r, scale)).join('');
  return `<div style="${css}">${bullet}${runs || '&nbsp;'}</div>`;
}

function textShapeHtml(shape: TextShape, scale: number): string {
  const pad = shape.padding || { l: 0, t: 0, r: 0, b: 0 };
  const justify = shape.vAlign === 'ctr' ? 'center' : shape.vAlign === 'b' ? 'flex-end' : 'flex-start';
  let css = frameCss(shape.frame, scale, shape.rotation, shape.flipH, shape.flipV)
    + `box-sizing:border-box;display:flex;flex-direction:column;justify-content:${justify};`
    + `padding:${pad.t * scale}px ${pad.r * scale}px ${pad.b * scale}px ${pad.l * scale}px;`
    + `overflow:visible;`; /* QA 要看到裸溢出 */
  css += fillCss(shape.fill);
  if (shape.border) css += `border:${Math.max(1, shape.border.widthEmu * scale)}px solid ${cssColor(shape.border.color)};`;
  return `<div style="${css}">${shape.paragraphs.map((p) => paragraphHtml(p, scale)).join('')}</div>`;
}

function pictureShapeHtml(shape: PictureShape, scale: number): string {
  let css = frameCss(shape.frame, scale, shape.rotation, shape.flipH, shape.flipV)
    + `object-fit:${shape.objectFit || 'fill'};`;
  css += shadowCss((shape as unknown as ShapeRect).effects, scale);
  const f = shape.filter;
  let defs = '';
  if (f) {
    const fx: string[] = [];
    if (f.grayscale) fx.push('grayscale(1)');
    if (f.biLevel) fx.push('grayscale(1) contrast(6)');
    if (f.duotone || f.lum) {
      const id = `nxf${(hashStr(JSON.stringify(f) + shape.src.slice(0, 64)) >>> 0).toString(36)}`;
      const parts: string[] = [];
      if (f.duotone) {
        const rgb = (h: string) => {
          const x = h.replace('#', '');
          return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
        };
        const [dr, dg, db] = rgb(f.duotone.dark);
        const [lr, lg, lb] = rgb(f.duotone.light);
        parts.push('<feColorMatrix type="saturate" values="0"/>'
          + '<feComponentTransfer>'
          + `<feFuncR type="table" tableValues="${dr} ${lr}"/>`
          + `<feFuncG type="table" tableValues="${dg} ${lg}"/>`
          + `<feFuncB type="table" tableValues="${db} ${lb}"/>`
          + '</feComponentTransfer>');
      }
      if (f.lum) {
        const c = f.lum.contrast ?? 0;
        const b = f.lum.brightness ?? 0;
        const slope = 1 + c;
        const intercept = 0.5 - 0.5 * slope + b;
        const fn = (ch: string) =>
          `<feFunc${ch} type="linear" slope="${slope.toFixed(4)}" intercept="${intercept.toFixed(4)}"/>`;
        parts.push(`<feComponentTransfer>${fn('R')}${fn('G')}${fn('B')}</feComponentTransfer>`);
      }
      defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">`
        + `<filter id="${id}" color-interpolation-filters="sRGB">${parts.join('')}</filter></svg>`;
      fx.push(`url(#${id})`);
    }
    if (fx.length) css += `filter:${fx.join(' ')};`;
  }
  return `${defs}<img src="${esc(shape.src)}" style="${css}" alt=""/>`;
}

/** 稳定的小 hash —— 渐变 id 必须每次渲染都一样, 否则预览刷新时会闪 */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function shadowCss(effects: ShapeRect['effects'], scale: number): string {
  if (!effects) return '';
  const rgba = (c: string | undefined, a: number | undefined) => {
    const hex = (c ?? '#000000').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a ?? 0.3})`;
  };
  const offset = (distance: number | undefined, angle: number | undefined) => {
    const dist = (distance ?? 0) * scale;
    const rad = ((angle ?? 90) * Math.PI) / 180;
    return [(Math.cos(rad) * dist).toFixed(1), (Math.sin(rad) * dist).toFixed(1)];
  };
  const parts: string[] = [];
  const out = effects.outerShadow;
  if (out) {
    const [x, y] = offset(out.distance, out.angle);
    parts.push(`${x}px ${y}px ${((out.blur ?? 0) * scale).toFixed(1)}px ${rgba(out.color, out.alpha)}`);
  }
  const inn = effects.innerShadow;
  if (inn) {
    const [x, y] = offset(inn.distance, inn.angle);
    parts.push(`inset ${x}px ${y}px ${((inn.blur ?? 0) * scale).toFixed(1)}px ${rgba(inn.color, inn.alpha)}`);
  }
  const glow = effects.glow;
  if (glow) {
    /* glow = 四周均匀外扩, 没有方向。用零偏移 + 同时给 blur 和 spread,
     * 否则纯 blur 的光晕在浅底上几乎看不出来。 */
    const r = ((glow.blur ?? 0) * scale).toFixed(1);
    parts.push(`0 0 ${r}px ${(Number(r) / 2).toFixed(1)}px ${rgba(glow.color, glow.alpha)}`);
  }
  /* softEdge 没做: CSS 侧要靠 mask-image 才准, 硬用 blur 会把整块内容糊掉,
   * 比不画更误导。导出端仍然写 <a:softEdge>。 */
  return parts.length ? `box-shadow:${parts.join(',')};` : '';
}

function rectShapeHtml(shape: ShapeRect, scale: number): string {
  if (shape.geom === 'custom' && shape.customPath?.d) {
    const box = frameCss(shape.frame, scale, shape.rotation, shape.flipH, shape.flipV);
    const vb = shape.customPath.viewBox;
    let fill = 'none';
    let defs = '';
    if (shape.customPath.strokeOnly) {
      /* 什么都不做: fill 保持 'none' */
    } else if (shape.fill?.kind === 'solid') {
      fill = cssColor(shape.fill.color);
    } else if (shape.fill?.kind === 'grad') {
      /* SVG 的 x1/y1→x2/y2 用 objectBoundingBox 单位; angleDeg 与 CSS 一致:
       * 90 = 从上到下。换算成单位向量即可。 */
      const id = `g${Math.abs(hashStr(shape.id + shape.customPath.d))}`;
      const rad = (shape.fill.angleDeg ?? 90) * Math.PI / 180;
      const dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
      const stops = shape.fill.stops
        .map((st) => `<stop offset="${Math.round(st.pos * 100)}%" stop-color="${cssColor(st.color)}"/>`)
        .join('');
      /* custom path 上的径向渐变 —— 这是预览端**第三处**渐变实现 (另外两处是
       * fillCss 的 background 和导出端的 gradFill)。三处必须同时支持, 否则又是
       * "同一语义两条实现只修了一条", 这个文件已经因为它翻过两次车。 */
      defs = shape.fill.radial
        ? `<defs><radialGradient id="${id}" cx="${shape.fill.radial.cx}" cy="${shape.fill.radial.cy}" r="0.72">${stops}</radialGradient></defs>`
        : `<defs><linearGradient id="${id}" x1="${0.5 - dx}" y1="${0.5 - dy}"`
          + ` x2="${0.5 + dx}" y2="${0.5 + dy}">${stops}</linearGradient></defs>`;
      fill = `url(#${id})`;
    }
    const strokeAttr = shape.border
      ? ` stroke="${cssColor(shape.border.color)}"`
        + ` stroke-width="${Math.max(0.5, shape.border.widthEmu * scale).toFixed(2)}"`
        + ' vector-effect="non-scaling-stroke"'
      : '';
    return `<div style="${box}">`
      + `<svg width="100%" height="100%" viewBox="0 0 ${vb.width} ${vb.height}"`
      + ` preserveAspectRatio="none" style="display:block;overflow:visible">`
      + `${defs}<path d="${esc(shape.customPath.d)}" fill="${fill}"${strokeAttr}/>`
      + `</svg></div>`;
  }

  let css = frameCss(shape.frame, scale, shape.rotation, shape.flipH, shape.flipV)
    + 'box-sizing:border-box;overflow:hidden;';
  css += fillCss(shape.fill);
  if (shape.border) css += `border:${Math.max(1, shape.border.widthEmu * scale)}px solid ${cssColor(shape.border.color)};`;
  css += shadowCss(shape.effects, scale);
  if (shape.geom === 'roundRect') {
    /* 有明确 cornerRadius 就用真值 —— 6% 近似会把"全圆角胶囊"画成小圆角方块,
     * 预览和导出对不上 */
    const r = shape.cornerRadius
      ? Math.min(shape.cornerRadius, Math.min(shape.frame.w, shape.frame.h) / 2)
      : Math.min(shape.frame.w, shape.frame.h) * 0.06;
    css += `border-radius:${r * scale}px;`;
  } else if (shape.geom === 'ellipse') {
    css += 'border-radius:50%;';
  } else {
    const clip = clipPathForGeometry(shape.geom);
    if (clip) css += `clip-path:${clip};`;
  }
  const hasText = shape.paragraphs?.some((p) => p.runs.some((r) => (r.text || '').trim()));
  if (!hasText) return `<div style="${css}"></div>`;
  const justify = shape.vAlign === 'ctr' ? 'center' : shape.vAlign === 'b' ? 'flex-end' : 'flex-start';
  const inner = `width:100%;height:100%;box-sizing:border-box;padding:${91440 * scale}px;`
    + `display:flex;flex-direction:column;justify-content:${justify};`;
  return `<div style="${css}"><div style="${inner}">`
    + shape.paragraphs!.map((p) => paragraphHtml(p, scale)).join('')
    + `</div></div>`;
}

function tableShapeHtml(shape: TableShape, scale: number): string {
  const outerCss = frameCss(shape.frame, scale) + 'box-sizing:border-box;';
  const totalColW = shape.columnWidths.reduce((a, b) => a + b, 0) || 1;
  const borderColor = shape.borderColor ?? '#D6D3CB';
  const hasHeader = shape.hasHeader !== false;
  const zebra = shape.zebra !== false;

  const colgroup = shape.columnWidths
    .map((w) => `<col style="width:${(w / totalColW) * 100}%"/>`)
    .join('');

  const rowsHtml = shape.rows.map((row, rowIdx) => {
    const isHeader = hasHeader && rowIdx === 0;
    const isZebra = zebra && !isHeader && rowIdx % 2 === 1;
    const minH = (row.heightEmu ?? 400000) * scale;
    const cells = row.cells.map((cell) => {
      let bg = '';
      if (cell.fill) bg = fillCss(cell.fill);
      else if (isHeader) bg = `background:${cssColor(shape.headerFill ?? '#1D2A2F')};`;
      else if (isZebra) bg = `background:${cssColor(shape.zebraFill ?? '#F5F1E8')};`;
      const alignCss = cell.align === 'ctr' ? 'center' : cell.align === 'r' ? 'right' : 'left';
      const vAlignCss = cell.vAlign === 'top' ? 'top' : cell.vAlign === 'b' ? 'bottom' : 'middle';
      /* cell 内边距镜像 exporter tcPr: marL/R=72000, marT/B=36000 EMU */
      const padCss = `padding:${36000 * scale}px ${72000 * scale}px;`;
      const span = `${cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}`
        + `${cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}`;
      const paras = (cell.paragraphs ?? []).map((p) => {
        /* header 白字兜底 (exporter cellTxBody 同款规则); 深色主题由 headerColor 覆盖 */
        if (isHeader) {
          const withColor: Paragraph = {
            ...p,
            runs: p.runs.map((r) => r.style.color ? r : { ...r, style: { ...r.style, color: shape.headerColor ?? '#FFFFFF' } }),
          };
          return paragraphHtml(withColor, scale);
        }
        return paragraphHtml(p, scale);
      }).join('');
      return `<td${span} style="${bg}${padCss}text-align:${alignCss};vertical-align:${vAlignCss};`
        + `border:${Math.max(1, 6350 * scale)}px solid ${borderColor};">${paras}</td>`;
    }).join('');
    return `<tr style="height:${minH}px;">${cells}</tr>`;
  }).join('');

  return `<div style="${outerCss}"><table style="width:100%;border-collapse:collapse;table-layout:fixed;">`
    + `<colgroup>${colgroup}</colgroup><tbody>${rowsHtml}</tbody></table></div>`;
}

function shapeHtml(shape: Shape, scale: number): string {
  switch (shape.kind) {
    case 'text': return textShapeHtml(shape, scale);
    case 'picture': return pictureShapeHtml(shape, scale);
    case 'shape': return rectShapeHtml(shape, scale);
    case 'table': return tableShapeHtml(shape, scale);
    default: return '';
  }
}

export interface SlideHtmlOptions {
  /** 输出宽度 CSS px · 默认 1280 */
  width?: number;
}

/**
 * 只出 slide 的**内容层** (背景 div + 所有 shape), 不带 <html>/<head>。
 * 给 deck-preview 这种"要把很多页嵌进同一个文档里"的场景用 ——
 * 缩略图墙不能每页塞一个完整 HTML 文档。
 */
export function renderSlideBodyHtml(
  presentation: Presentation,
  slide: Slide,
  scale: number,
): string {
  const width = presentation.slideWidth * scale;
  const height = presentation.slideHeight * scale;
  const bg = slide.background ? fillCss(slide.background) : 'background:#FFFFFF;';
  const shapes = slide.shapes.map((s) => shapeHtml(s, scale)).join('\n');
  return `<div style="position:relative;width:${width}px;height:${height}px;overflow:hidden;${bg}">\n${shapes}\n</div>`;
}

/** 单页 slide → self-contained HTML 文档字符串 (渲染桥直接可截) */
export function renderSlideToHtml(
  presentation: Presentation,
  slide: Slide,
  opts?: SlideHtmlOptions,
): string {
  const width = opts?.width ?? 1280;
  const scale = width / presentation.slideWidth;
  const height = presentation.slideHeight * scale;
  const bg = slide.background ? fillCss(slide.background) : 'background:#FFFFFF;';

  const shapes = slide.shapes.map((s) => shapeHtml(s, scale)).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  * { margin: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
</style></head>
<body><div style="position:relative;width:${width}px;height:${height}px;overflow:hidden;${bg}">
${shapes}
</div></body></html>`;
}

/** 整个 deck → 每页 HTML 数组 */
export function renderSlidesToHtml(presentation: Presentation, opts?: SlideHtmlOptions): string[] {
  return presentation.slides.map((slide) => renderSlideToHtml(presentation, slide, opts));
}
