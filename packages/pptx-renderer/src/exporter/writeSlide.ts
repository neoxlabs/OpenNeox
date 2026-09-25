/**
 * writeSlide — 单张 slide 的 slideN.xml + rels.
 * 覆盖 kind: text / picture / shape (rect/roundRect/ellipse).
 */

import type {
  Slide, Shape, TextShape, PictureShape, ShapeRect, TableShape,
  Fill, Paragraph, TextRun,
} from '../model/types.js';
import { XML_DECL, esc, hexNoHash } from './ooxml/xml.js';
import { svgPathToCustGeom, SvgPathParseError } from './ooxml/svgPathToCustGeom.js';
import type { SlideMediaRef } from './writeMedia.js';
import { ptToRPrSz } from '../model/units.js';

export function writeSlideXml(
  slide: Slide,
  media: SlideMediaRef[],
  slideDim?: { widthEmu: number; heightEmu: number },
): string {
  const bg = slide.background ? bgXml(slide.background) : '';
  resetPicIndexCounter();
  const shapes = slide.shapes.map((sh, i) => shapeXml(sh, i + 2, media)).join('');

  /* 根组的 ext/chExt 使用整张 slide 的尺寸，避免严格 OOXML 阅读器按零尺寸
   * 组边界裁剪子形状；缺少尺寸时使用标准 16:9 画布。 */
  const w = slideDim?.widthEmu ?? 12192000;
  const h = slideDim?.heightEmu ?? 6858000;
  return `${XML_DECL}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld${slide.templateId ? ` name="${esc(String(slide.templateId))}"` : ''}>
    ${bg}
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/>
          <a:chOff x="0" y="0"/><a:chExt cx="${w}" cy="${h}"/>
        </a:xfrm>
      </p:grpSpPr>
      ${shapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
  ${transitionXml(slide)}
</p:sld>`;
}

export function writeSlideRelsXml(media: SlideMediaRef[]): string {
  const rels: string[] = [];
  /* rId1 → slideLayout */
  rels.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`);
  /* rId2..N+1 → media */
  for (const m of media) {
    rels.push(`<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.media.fileName}"/>`);
  }
  return `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('')}
</Relationships>`;
}

/* ---------- background ---------- */
function bgXml(fill: Fill): string {
  if (fill.kind === 'solid') {
    return `<p:bg><p:bgPr>${fillXmlInner(fill)}<a:effectLst/></p:bgPr></p:bg>`;
  }
  if (fill.kind === 'grad') {
    return `<p:bg><p:bgPr>${fillXmlInner(fill)}<a:effectLst/></p:bgPr></p:bg>`;
  }
  return '';
}

/* ---------- 单 shape 分发 ---------- */
function shapeXml(shape: Shape, ooxmlId: number, media: SlideMediaRef[]): string {
  if (shape.kind === 'text') return textShapeXml(shape, ooxmlId);
  if (shape.kind === 'shape') return rectShapeXml(shape, ooxmlId);
  if (shape.kind === 'picture') return picShapeXml(shape, ooxmlId, media);
  if (shape.kind === 'table') return tableShapeXml(shape, ooxmlId);
  return '';
}

/* ---------- text shape (p:sp with txBody) ---------- */
function textShapeXml(shape: TextShape, id: number): string {
  const spPr = xfrmXml(shape) + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + (shape.fill ? fillXmlInner(shape.fill) : '<a:noFill/>')
    + (shape.border ? lineXml(shape.border) : '');

  /* 文本框默认使用 normAutofit，使超出内容按比例缩小并留在自身边界内；
   * 显式 autoFit 设置优先，允许标题等特殊布局关闭该行为。 */
  const shapeWithDefaultAutofit = shape.autoFit != null
    ? shape
    : { ...shape, autoFit: 'shrinkText' as const };
  const bodyPr = bodyPrXml(shapeWithDefaultAutofit);
  const paragraphs = shape.paragraphs.map(paragraphXml).join('');

  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="${id}" name="TextBox ${id}"/>
      <p:cNvSpPr txBox="1"/>
      <p:nvSpPr><p:nvPr/></p:nvSpPr>
    </p:nvSpPr>
    <p:spPr>${spPr}</p:spPr>
    <p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody>
  </p:sp>`;
}

/* ---------- rect / roundRect / ellipse / 装饰几何全家福 (扩) ---------- */
function rectShapeXml(shape: ShapeRect, id: number): string {
  /* geom → OOXML prstGeom preset 名. 未识别的走 'rect' 兜底. */
  const PRESET_MAP: Record<string, string> = {
    rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse',
    line: 'line', straightConnector1: 'straightConnector1',
    rightArrow: 'rightArrow', leftArrow: 'leftArrow', upArrow: 'upArrow', downArrow: 'downArrow',
    chevron: 'chevron', star5: 'star5', star6: 'star6',
    pentagon: 'pentagon', hexagon: 'hexagon', triangle: 'triangle',
    diagonalStripe: 'diagStripe', plaque: 'plaque', ribbon2: 'ribbon2',
  };
  const prst = PRESET_MAP[shape.geom] ?? 'rect';
  /* roundRect 的 adj 是"圆角半径占较短边的比例", 合法范围 0~50000 (50000 = 半个短边,
   * 即完全胶囊化)。**必须钳位**: 图表的零值桩只有 3px 高而柱子 cornerRadius 是 4px,
   * 不钳位算出来是 133333 —— 超出规范, 各家渲染器行为不一。 */
  const avLst = (shape.geom === 'roundRect' && shape.cornerRadius && shape.frame.w > 0)
    ? `<a:avLst><a:gd name="adj" fmla="val ${Math.max(0, Math.min(50000,
        Math.round((shape.cornerRadius / Math.min(shape.frame.w, shape.frame.h)) * 100000)))}"/></a:avLst>`
    : `<a:avLst/>`;
  const geomXml = customGeomXml(shape) ?? `<a:prstGeom prst="${prst}">${avLst}</a:prstGeom>`;
  const spPr = xfrmXml(shape) + geomXml
    + (shape.fill ? fillXmlInner(shape.fill) : '<a:noFill/>')
    + (shape.border ? lineXml(shape.border) : '')
    + effectLstXml(shape.effects); /* effectLst 阴影/描边/发光 */

  const txBody = shape.paragraphs && shape.paragraphs.length > 0
    ? `<p:txBody>${bodyPrXml({ vAlign: (shape as any).vAlign })}<a:lstStyle/>${shape.paragraphs.map(paragraphXml).join('')}</p:txBody>`
    : `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody>`;

  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="${id}" name="Shape ${id}"/>
      <p:cNvSpPr/>
      <p:nvSpPr><p:nvPr/></p:nvSpPr>
    </p:nvSpPr>
    <p:spPr>${spPr}</p:spPr>
    ${txBody}
  </p:sp>`;
}

/* ---------- picture ---------- */
function picShapeXml(shape: PictureShape, id: number, media: SlideMediaRef[]): string {
  /* 只为已解析成 data URL 且存在对应关系的图片生成 p:pic。
   * 未解析的来源保持空白，避免把 slideLayout 关系误当成图片关系；
   * 按源匹配关系并配合计数器，保证跳过图片后后续索引仍然连续。 */
  if (!shape.src || !shape.src.startsWith('data:')) {
    countPreviousPics(id); /* 消耗计数, 保持 subsequent pics 索引连续 */
    return '';
  }
  const ref = media.find((m) => (m.media as any).srcRef === shape.src);
  const picIndex = countPreviousPics(id);
  const rid = ref?.rid ?? media[picIndex]?.rid;
  if (!rid) return ''; /* 严格: 没有 rId 一律不 emit */
  const picEffects = shape.effects;
  const filterXml = blipFilterXml(shape.filter);
  return `<p:pic>
    <p:nvPicPr>
      <p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(shape.alt)}"/>
      <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
      <p:nvPicPr><p:nvPr/></p:nvPicPr>
    </p:nvPicPr>
    <p:blipFill>
      <a:blip r:embed="${rid}">${filterXml}</a:blip>
      ${srcRectXml(shape)}<a:stretch><a:fillRect/></a:stretch>
    </p:blipFill>
    <p:spPr>${xfrmXml(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${effectLstXml(picEffects)}</p:spPr>
  </p:pic>`;
}

/**
 * 换页动画 —— OOXML `<p:transition>`。
 *
 * StyleSpec 里 motion:{transition,build,stagger} 四套风格都定义好了,
 * 但**没有任何代码读过它**, 导出的 pptx 里一条 p:transition 都没有。又一处"写完没接线"。
 *
 * 元素顺序是硬要求: p:sld 里必须是 cSld → clrMapOvr → transition → timing,
 * 放错位置 PowerPoint 会判文件损坏 (不是忽略, 是拒绝打开)。
 *
 * 只做换页, 不做逐元素入场 (p:timing): 那需要构建完整时间轴树, 而且 WPS/Keynote
 * 对它的兼容性差得多 —— 一份打不开的 deck 比没有动画糟糕得多。
 */
function transitionXml(slide: Slide): string {
  const t = slide.transition;
  if (!t) return '';
  const body = t.kind === 'push' ? '<p:push dir="u"/>'
    : t.kind === 'wipe' ? '<p:wipe dir="r"/>'
    : '<p:fade/>';
  const dur = Math.max(100, Math.min(3000, Math.round(t.durationMs ?? 600)));
  /* spd 是老属性 (slow/med/fast), p14:dur 才是毫秒。两个都写: 老版本读 spd,
   * 新版本读 dur; 只写其一会在另一端退化成默认速度。 */
  const spd = dur <= 350 ? 'fast' : dur >= 900 ? 'slow' : 'med';
  return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">`
    + `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">`
    + `<p:transition spd="${spd}" p14:dur="${dur}">${body}</p:transition></mc:Choice>`
    + `<mc:Fallback><p:transition spd="${spd}">${body}</p:transition></mc:Fallback>`
    + `</mc:AlternateContent>`;
}

/**
 * srcRect —— 图片裁剪。
 *
 * l/t/r/b 表示各边裁掉的比例 (0~1)，导出时转换为 OOXML 的
 * 千分之一百分比单位，使 cover 预览与导出保持一致。
 */
function srcRectXml(shape: PictureShape): string {
  const c = shape.srcRect;
  if (!c) return '';
  const p = (v: number) => Math.round(Math.max(0, Math.min(0.9, v || 0)) * 100000);
  if (!c.l && !c.t && !c.r && !c.b) return '';
  return `<a:srcRect l="${p(c.l)}" t="${p(c.t)}" r="${p(c.r)}" b="${p(c.b)}"/>`;
}

/**
 * blipFilterXml  · OOXML `<a:blip>` 子元素 · 图片色调滤镜.
 * grayscale / duotone / biLevel / lum · 用于杂志感的 BW · 双色调等.
 */
function blipFilterXml(filter?: PictureShape['filter']): string {
  if (!filter) return '';
  const parts: string[] = [];
  if (filter.grayscale) {
    parts.push('<a:grayscl/>');
  }
  if (filter.duotone) {
    const dark = hexNoHash(filter.duotone.dark);
    const light = hexNoHash(filter.duotone.light);
    parts.push(`<a:duotone><a:srgbClr val="${dark}"/><a:srgbClr val="${light}"/></a:duotone>`);
  }
  if (filter.biLevel) {
    const t = Math.round((filter.biLevel.threshold ?? 50000));
    parts.push(`<a:biLevel thresh="${t}"/>`);
  }
  if (filter.lum) {
    const b = filter.lum.brightness != null ? ` bright="${Math.round(filter.lum.brightness * 100000)}"` : '';
    const c = filter.lum.contrast != null ? ` contrast="${Math.round(filter.lum.contrast * 100000)}"` : '';
    parts.push(`<a:lum${b}${c}/>`);
  }
  return parts.join('');
}

/* Hack: 因为 id 是全局 shape id, 但 media[] index 不是, 我们靠 id 反推 pic 的顺序 index —
 * 实际实现里应该带 slideMediaIndex 到 shape 上. 简化处理: 假设 shape 在 model 里的顺序等于 pic 顺序. */
let _picIndexCounter = 0;
function countPreviousPics(_id: number): number {
  /* 这个 hacky 计数依赖 shapeXml 是按顺序调用的 (是的). */
  return _picIndexCounter++;
}
export function resetPicIndexCounter(): void { _picIndexCounter = 0; }

/* ---------- xfrm ---------- */
/** ns: 'a' (spPr 内) / 'p' (graphicFrame 直属子元素 — OOXML schema 要求 p:xfrm, 写 a:xfrm
 * 严格实现 (PowerPoint) 会丢表格位置.  修.) */
function xfrmXml(shape: Shape, ns: 'a' | 'p' = 'a'): string {
  const rot = shape.rotation ? ` rot="${Math.round(shape.rotation * 60000)}"` : '';
  const flipH = shape.flipH ? ` flipH="1"` : '';
  const flipV = shape.flipV ? ` flipV="1"` : '';
  return `<${ns}:xfrm${rot}${flipH}${flipV}>
    <a:off x="${shape.frame.x}" y="${shape.frame.y}"/>
    <a:ext cx="${shape.frame.w}" cy="${shape.frame.h}"/>
  </${ns}:xfrm>`;
}

/* ---------- bodyPr ---------- */
function bodyPrXml(opts: {
  vAlign?: 'top' | 'ctr' | 'b';
  wrap?: 'square' | 'none';
  autoFit?: 'none' | 'shrinkText' | 'resizeShapeToFitText';
  padding?: { l: number; t: number; r: number; b: number };
}): string {
  const anchor = opts.vAlign ? ` anchor="${opts.vAlign}"` : '';
  const wrap = opts.wrap ? ` wrap="${opts.wrap}"` : '';
  /* 【 确定性硬化】insets 永远显式写.
   * 不写时 office 用默认 lIns=91440/tIns=45720 (每边 ~9.6px/4.8px) — 一个布局引擎
   * 看不见的隐藏缩水, 断行预测全被它带偏. 显式 0 (或 model padding) = 文本区域就是 frame. */
  const pad = opts.padding ?? { l: 0, t: 0, r: 0, b: 0 };
  const insets = ` lIns="${pad.l}" tIns="${pad.t}" rIns="${pad.r}" bIns="${pad.b}"`;
  let autoFit = '';
  if (opts.autoFit === 'shrinkText') autoFit = '<a:normAutofit/>';
  else if (opts.autoFit === 'resizeShapeToFitText') autoFit = '<a:spAutoFit/>';
  return `<a:bodyPr${anchor}${wrap}${insets}>${autoFit}</a:bodyPr>`;
}

/* ---------- fill inner (solid / grad / pic / none) — 不含 <p:*> 或 <a:*> wrapper ---------- */
function fillXmlInner(fill: Fill): string {
  if (fill.kind === 'solid') {
    /* rgba 颜色拆成 srgbClr 与 a:alpha，确保半透明装饰在 OOXML 中保持原语义。 */
    const parsed = extractAlpha(fill.color);
    const clr = hexNoHash(parsed.hex);
    const alphaXml = parsed.alpha != null ? `<a:alpha val="${Math.round(parsed.alpha * 100000)}"/>` : '';
    return `<a:solidFill><a:srgbClr val="${clr}">${alphaXml}</a:srgbClr></a:solidFill>`;
  }
  if (fill.kind === 'grad') {
    const stops = fill.stops.map(s => {
      const alpha = extractAlpha(s.color);
      const clr = hexNoHash(alpha.hex);
      const alphaXml = alpha.alpha != null ? `<a:alpha val="${Math.round(alpha.alpha * 100000)}"/>` : '';
      /* DrawingML 的渐变停靠点使用 0..100000 的千分之一百分点。 */
      return `<a:gs pos="${Math.round(s.pos * 100000)}"><a:srgbClr val="${clr}">${alphaXml}</a:srgbClr></a:gs>`;
    }).join('');
    if (fill.radial) {
      /* 径向渐变用 fillToRect 描述中心到边缘的映射；
       * cx/cy 是中心位置，停靠点按中心到边缘的顺序写入。 */
      const pc = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100000);
      const { cx, cy } = fill.radial;
      return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${stops}</a:gsLst>`
        + `<a:path path="circle"><a:fillToRect l="${pc(cx)}" t="${pc(cy)}" r="${pc(1 - cx)}" b="${pc(1 - cy)}"/></a:path>`
        + `</a:gradFill>`;
    }
    const ang = fill.angleDeg != null ? Math.round(fill.angleDeg * 60000) : 5400000;
    return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`;
  }
  return '<a:noFill/>';
}

function extractAlpha(color: string): { hex: string; alpha: number | null } {
  /* rgba(r,g,b,a) → 拆出 alpha 单独存 */
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (m) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const a = parseFloat(m[4]);
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('');
    return { hex, alpha: a };
  }
  return { hex: color, alpha: null };
}

/* ---------- line (border) ---------- */
function lineXml(border: { color: string; widthEmu: number }): string {
  return `<a:ln w="${border.widthEmu}"><a:solidFill><a:srgbClr val="${hexNoHash(border.color)}"/></a:solidFill></a:ln>`;
}

/* ---------- effectLst  · 阴影/发光/软边 ----------
 * OOXML `<a:effectLst>` 支持: outerShdw / innerShdw / glow / softEdge.
 * 参数默认走"温和不喧宾"设置: blur 30-60kEMU, distance 50-100kEMU, alpha 30-50%.
 * 空 opts → 返回空串, 不影响 shape. */
function effectLstXml(effects?: ShapeRect['effects']): string {
  if (!effects) return '';
  const parts: string[] = [];

  if (effects.outerShadow) {
    const s = effects.outerShadow;
    const blur = s.blur ?? 40000;
    const distance = s.distance ?? 60000;
    const angle = Math.round((s.angle ?? 90) * 60000); /* OOXML: 1/60000 度 */
    const alpha = Math.round((s.alpha ?? 0.35) * 100000);
    const color = hexNoHash(s.color ?? '#000000');
    parts.push(`<a:outerShdw blurRad="${blur}" dist="${distance}" dir="${angle}" algn="ctr" rotWithShape="0"><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw>`);
  }

  if (effects.innerShadow) {
    const s = effects.innerShadow;
    const blur = s.blur ?? 30000;
    const distance = s.distance ?? 20000;
    const angle = Math.round((s.angle ?? 90) * 60000);
    const alpha = Math.round((s.alpha ?? 0.35) * 100000);
    const color = hexNoHash(s.color ?? '#000000');
    parts.push(`<a:innerShdw blurRad="${blur}" dist="${distance}" dir="${angle}"><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:innerShdw>`);
  }

  if (effects.glow) {
    const g = effects.glow;
    const blur = g.blur ?? 40000;
    const alpha = Math.round((g.alpha ?? 0.5) * 100000);
    const color = hexNoHash(g.color ?? '#FFFFFF');
    parts.push(`<a:glow rad="${blur}"><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:glow>`);
  }

  if (effects.softEdge) {
    const r = effects.softEdge.radius ?? 20000;
    parts.push(`<a:softEdge rad="${r}"/>`);
  }

  return parts.length ? `<a:effectLst>${parts.join('')}</a:effectLst>` : '';
}

/* ---------- Paragraph → <a:p> ---------- */
function paragraphXml(p: Paragraph): string {
  const pPr = pPrXml(p);
  const runs = p.runs.map(runXml).join('');
  return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US"/></a:p>`;
}

function pPrXml(p: Paragraph): string {
  const attrs: string[] = [];
  if (p.align) attrs.push(`algn="${p.align}"`);
  if (p.level) attrs.push(`lvl="${p.level}"`);
  if (p.indent != null) attrs.push(`indent="${p.indent}"`);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  /* 【 确定性硬化】lnSpc 用 spcPts 钉死行高 (单位 1/100 pt).
   * 有它: 高度 = 行数 × lnSpc, office/WPS 必须遵守, 布局引擎的预测就是事实.
   * OOXML schema 顺序: lnSpc → spcBef → spcAft → bullet. */
  const lnSpc = p.lineSpacingPt
    ? `<a:lnSpc><a:spcPts val="${Math.round(p.lineSpacingPt * 100)}"/></a:lnSpc>`
    : '';
  const spcBef = p.spaceBeforeEmu ? `<a:spcBef><a:spcPts val="${Math.round(p.spaceBeforeEmu / 127)}"/></a:spcBef>` : '';
  const spcAft = p.spaceAfterEmu ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfterEmu / 127)}"/></a:spcAft>` : '';
  const bullet = p.bullet && p.bullet.kind === 'char'
    ? `<a:buChar char="${esc(p.bullet.char)}"/>`
    : p.bullet && p.bullet.kind === 'none' ? '<a:buNone/>' : '';
  if (!attrStr && !lnSpc && !spcBef && !spcAft && !bullet) return '';
  return `<a:pPr${attrStr}>${lnSpc}${spcBef}${spcAft}${bullet}</a:pPr>`;
}

function runXml(r: TextRun): string {
  const s = r.style;
  const attrs: string[] = [];
  if (s.fontSizePt) attrs.push(`sz="${ptToRPrSz(s.fontSizePt)}"`);
  if (s.bold) attrs.push(`b="1"`);
  if (s.italic) attrs.push(`i="1"`);
  if (s.underline) attrs.push(`u="sng"`);
  if (s.strike) attrs.push(`strike="sngStrike"`);
  /* builder 以 EMU 保存字符间距，OOXML 的 spc 使用 1/100 pt；
   * 按 1 pt = 12700 EMU 转换并取整。 */
  if (s.spacing) attrs.push(`spc="${Math.round(s.spacing / 127)}"`);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  /* 文本颜色与形状填充使用相同的 rgba 拆分规则，分别写入颜色和透明度。 */
  const runColor = s.color ? extractAlpha(s.color) : null;
  const runAlphaXml = runColor?.alpha != null ? `<a:alpha val="${Math.round(runColor.alpha * 100000)}"/>` : '';
  const fill = runColor
    ? `<a:solidFill><a:srgbClr val="${hexNoHash(runColor.hex)}">${runAlphaXml}</a:srgbClr></a:solidFill>`
    : '';
  /* 中英分排 · 优先 fontLatin/fontEast, fallback 到 fontFamily.
   * OOXML `<a:latin>` 拉丁/数字/符号, `<a:ea>` 东亚 (中日韩), `<a:cs>` 复杂脚本.
   * 分开写让 "标题衬线 + 中文黑体" 或 "英文 Inter + 中文 PingFang" 这类配对能真正生效. */
  const latinFont = s.fontLatin || s.fontFamily;
  const eastFont = s.fontEast || s.fontFamily;
  const fontParts: string[] = [];
  if (latinFont) fontParts.push(`<a:latin typeface="${esc(latinFont)}"/>`);
  if (eastFont) fontParts.push(`<a:ea typeface="${esc(eastFont)}"/>`);
  const font = fontParts.join('');
  const rPr = (fill || font || attrStr)
    ? `<a:rPr lang="en-US"${attrStr}>${fill}${font}</a:rPr>`
    : '';
  return `<a:r>${rPr}<a:t>${esc(r.text)}</a:t></a:r>`;
}

/* ---------- table (原生 pptx `<a:tbl>` ·) ----------
 * 表格输出为 graphicFrame 中的原生 OOXML table，PowerPoint、Keynote 和 WPS
 * 可继续编辑单元格。
 *
 * OOXML 结构:
 *   <p:graphicFrame>
 *     <p:nvGraphicFramePr>...</p:nvGraphicFramePr>
 *     <p:xfrm>...</p:xfrm>
 *     <a:graphic><a:graphicData uri="tbl-namespace">
 *       <a:tbl>
 *         <a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>...</a:tableStyleId></a:tblPr>
 *         <a:tblGrid><a:gridCol w="X"/>...</a:tblGrid>
 *         <a:tr h="Y"><a:tc>...cell...</a:tc>...</a:tr>
 *         ...
 *       </a:tbl>
 *     </a:graphicData></a:graphic>
 *   </p:graphicFrame>
 */
function tableShapeXml(shape: TableShape, id: number): string {
  const gridCols = shape.columnWidths
    .map((w) => `<a:gridCol w="${w}"/>`).join('');

  const hasHeader = shape.hasHeader !== false; /* 默认开 */
  const zebra = shape.zebra !== false;         /* 默认开 */
  const borderColor = hexNoHash(shape.borderColor ?? '#D6D3CB');

  const rowsXml = shape.rows.map((row, rowIdx) => {
    const rowH = row.heightEmu ?? 400000; /* ≈ 42px */
    const isHeader = hasHeader && rowIdx === 0;
    const isZebraRow = zebra && !isHeader && (rowIdx % 2 === 1);

    const cellsXml = row.cells.map((cell) => {
      /* 单元格默认对齐. header 白字, 其它 ink 色 */
      const align = cell.align ?? 'l';
      const vAlign = cell.vAlign ?? 'ctr';
      const spanAttrs: string[] = [];
      if (cell.colSpan && cell.colSpan > 1) spanAttrs.push(`gridSpan="${cell.colSpan}"`);
      if (cell.rowSpan && cell.rowSpan > 1) spanAttrs.push(`rowSpan="${cell.rowSpan}"`);

      /* 单元格 fill: 明确指定 > header 深底 > 斑马淡底 > 无 */
      let cellFill = '';
      if (cell.fill) {
        cellFill = fillXmlInner(cell.fill);
      } else if (isHeader) {
        /* 默认表头与斑马行颜色从表格主题属性读取。 */
        cellFill = `<a:solidFill><a:srgbClr val="${hexNoHash((shape as any).headerFill ?? '#1D2A2F')}"/></a:solidFill>`;
      } else if (isZebraRow) {
        cellFill = `<a:solidFill><a:srgbClr val="${hexNoHash((shape as any).zebraFill ?? '#F5F1E8')}"/></a:solidFill>`;
      } else {
        cellFill = `<a:noFill/>`;
      }

      /* 内边距 + 对齐 */
      const tcPr = `<a:tcPr marL="72000" marR="72000" marT="36000" marB="36000" anchor="${vAlign}">${cellFill}<a:lnL w="6350"><a:solidFill><a:srgbClr val="${borderColor}"/></a:solidFill></a:lnL><a:lnR w="6350"><a:solidFill><a:srgbClr val="${borderColor}"/></a:solidFill></a:lnR><a:lnT w="6350"><a:solidFill><a:srgbClr val="${borderColor}"/></a:solidFill></a:lnT><a:lnB w="6350"><a:solidFill><a:srgbClr val="${borderColor}"/></a:solidFill></a:lnB></a:tcPr>`;

      /* txBody: header 用白字, 其它默认 ink. 每段带上 align */
      const txBody = cellTxBody(cell.paragraphs, align, isHeader);

      return `<a:tc${spanAttrs.length ? ' ' + spanAttrs.join(' ') : ''}>${txBody}${tcPr}</a:tc>`;
    }).join('');

    return `<a:tr h="${rowH}">${cellsXml}</a:tr>`;
  }).join('');

  return `<p:graphicFrame>
    <p:nvGraphicFramePr>
      <p:cNvPr id="${id}" name="Table ${id}"/>
      <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
      <p:nvPr/>
    </p:nvGraphicFramePr>
    ${xfrmXml(shape, 'p')}
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblPr firstRow="${hasHeader ? 1 : 0}" bandRow="${zebra ? 1 : 0}">
            <a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>
          </a:tblPr>
          <a:tblGrid>${gridCols}</a:tblGrid>
          ${rowsXml}
        </a:tbl>
      </a:graphicData>
    </a:graphic>
  </p:graphicFrame>`;
}

/**
 * 单元格 txBody · 简版: 每个 paragraph 加对齐 + header 覆盖白字.
 * 段落为空时给一个 endParaRPr 占位, 不然某些 viewer 会渲染坏.
 */
function cellTxBody(
  paragraphs: Paragraph[] | undefined,
  align: 'l' | 'ctr' | 'r',
  isHeader: boolean,
): string {
  if (!paragraphs || paragraphs.length === 0) {
    return `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></a:txBody>`;
  }
  const pXml = paragraphs.map((p) => {
    /* lnSpc 钉死 : 表格单元格行高也走确定性 — compose 表格行高测量可精确预测 */
    const lnSpc = p.lineSpacingPt
      ? `<a:lnSpc><a:spcPts val="${Math.round(p.lineSpacingPt * 100)}"/></a:lnSpc>`
      : '';
    const pPr = `<a:pPr algn="${align}">${lnSpc}</a:pPr>`;
    const runs = p.runs.map((r) => {
      /* header 覆盖字色 (只在 run 没指定 color 时) */
      const runWithColor: TextRun = isHeader && !r.style.color
        ? { ...r, style: { ...r.style, color: '#FFFFFF' } }
        : r;
      return runXml(runWithColor);
    }).join('');
    return `<a:p>${pPr}${runs || '<a:endParaRPr/>'}</a:p>`;
  }).join('');
  return `<a:txBody><a:bodyPr/><a:lstStyle/>${pXml}</a:txBody>`;
}


/**
 * geom='custom' → `<a:custGeom>`。path 解析失败时**不静默吞掉**: 打日志 + 退回矩形,
 * 免得导出一个"少了一块"的 PPT 却没人知道 (这类静默降级的教训今天已经吃过一次)。
 */
function customGeomXml(shape: ShapeRect): string | null {
  if (shape.geom !== 'custom') return null;
  const cp = shape.customPath;
  if (!cp?.d) {
    // eslint-disable-next-line no-console
    console.warn('[pptx] geom=custom 但没有 customPath.d, 退回矩形');
    return null;
  }
  try {
    return svgPathToCustGeom(cp.d, {
      viewBoxWidth: cp.viewBox.width,
      viewBoxHeight: cp.viewBox.height,
      strokeOnly: cp.strokeOnly,
    });
  } catch (err) {
    const why = err instanceof SvgPathParseError ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[pptx] custom path 解析失败, 退回矩形: ${why}`);
    return null;
  }
}
