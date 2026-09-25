/**
 * pptx-renderer/parser — pptx (zip) → Presentation 数据模型
 *
 * 依赖: JSZip (已经在 monorepo 里) + 浏览器原生 DOMParser (renderer 侧免装 xml lib).
 *
 * 目标场景: AI 用 python-pptx / pptxgenjs / @oai/artifact-tool 生成的规整 pptx.
 *   典型模板 90% 覆盖 (标题+副标题+正文+图片+简单矩形装饰). SmartArt / 复杂动画 / 表格
 *   暂不覆盖, 但至少不会崩 — 未识别的形状被 silently 跳过.
 *
 * pptx 结构参考 (Ecma-376):
 *   ppt/presentation.xml — slide size, slide id list, theme ref
 *   ppt/_rels/presentation.xml.rels — slide id → slideN.xml 路径
 *   ppt/slides/slide{N}.xml — 一张 slide 的所有 shape
 *   ppt/slides/_rels/slide{N}.xml.rels — slide 里的 rId → 媒体/layout 路径
 *   ppt/theme/theme1.xml — 颜色/字体主题
 *   ppt/media/* — 图片资源
 */

import JSZip from 'jszip';
import type {
  Presentation, Slide, Shape, TextShape, PictureShape, ShapeRect,
  TableShape, TableRow, TableCell,
  Paragraph, TextRun, TextRunStyle, Frame, Fill, Theme, MediaMap,
} from '../model/types.js';

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};

/** 主入口. */
export async function parsePptx(input: ArrayBuffer | Uint8Array): Promise<Presentation> {
  const zip = await JSZip.loadAsync(input);
  const parser = new DOMParser();

  /* ---------- 1. presentation.xml — slide size + slide id list ---------- */
  const presXml = await readText(zip, 'ppt/presentation.xml');
  if (!presXml) throw new Error('这不是有效的 pptx (缺 ppt/presentation.xml)');
  const presDoc = parser.parseFromString(presXml, 'application/xml');
  const sldSz = presDoc.getElementsByTagNameNS(NS.p, 'sldSz')[0];
  const slideWidth = intAttr(sldSz, 'cx', 9144000);
  const slideHeight = intAttr(sldSz, 'cy', 6858000);
  const sldIdEls = Array.from(presDoc.getElementsByTagNameNS(NS.p, 'sldId'));

  /* ---------- 2. presentation.xml.rels — rId → slideN.xml 路径 ---------- */
  const presRelsMap = await readRels(zip, parser, 'ppt/_rels/presentation.xml.rels');

  /* ---------- 3. theme (取第一个) ---------- */
  const theme = await parseThemeIfPresent(zip, parser);

  /* ---------- 4. 遍历 slide ---------- */
  const slides: Slide[] = [];
  /* 版式 / 母版只解析一次: 几十页共用同一个母版, 每页都重读一遍没意义 */
  const underlayCache = new Map<string, PartVisuals>();
  for (let i = 0; i < sldIdEls.length; i++) {
    const sldId = sldIdEls[i];
    const rId = getAttrNS(sldId, NS.r, 'id') || getAttr(sldId, 'r:id') || '';
    const slidePath = presRelsMap[rId];
    if (!slidePath) continue;
    /* slidePath 形如 "slides/slide1.xml", 相对于 ppt/. 拼绝对路径. */
    const absSlidePath = resolveRelPath('ppt/presentation.xml', slidePath);
    const slide = await parseSlide(zip, parser, absSlidePath, i + 1, theme, slideWidth, slideHeight, underlayCache);
    if (slide) slides.push(slide);
  }

  return {
    slideWidth,
    slideHeight,
    slides,
    theme,
  };
}

/* ============================================================
 * 工具: zip 读取, XML DOM 遍历, 属性提取
 * ============================================================ */

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async('string');
}

async function readBase64(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async('base64');
}

async function readRels(zip: JSZip, parser: DOMParser, path: string): Promise<Record<string, string>> {
  const txt = await readText(zip, path);
  const map: Record<string, string> = {};
  if (!txt) return map;
  const doc = parser.parseFromString(txt, 'application/xml');
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    const id = r.getAttribute('Id') || '';
    const target = r.getAttribute('Target') || '';
    if (id) map[id] = target;
  }
  return map;
}

/** 读 rels 附带 Type — 用来定位 slideLayout / slideMaster (它们的 Target 只按 rId 找不到, 必须按 Type). */
async function readRelsWithType(zip: JSZip, parser: DOMParser, path: string): Promise<Array<{ id: string; type: string; target: string }>> {
  const txt = await readText(zip, path);
  const out: Array<{ id: string; type: string; target: string }> = [];
  if (!txt) return out;
  const doc = parser.parseFromString(txt, 'application/xml');
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    out.push({
      id: r.getAttribute('Id') || '',
      type: r.getAttribute('Type') || '',
      target: r.getAttribute('Target') || '',
    });
  }
  return out;
}

/**
 * 沿 slide → slideLayout → slideMaster 一路收集占位符表.
 * 匹配优先级: type+idx (最严格) > type only > idx only > 通用 fallback.
 * 后加载的会被前面 (更靠近 slide 的) 覆盖 — 因为 slide 优先.
 *
 * 返回 map: `${type}|${idx}` → PlaceholderInfo. parseSpShape 查这个补 frame/style.
 */
async function loadPlaceholderChain(
  zip: JSZip, parser: DOMParser,
  slideRels: Array<{ id: string; type: string; target: string }>,
  slidePath: string,
): Promise<Record<string, PlaceholderInfo>> {
  const layoutRel = slideRels.find(r => r.type.endsWith('/slideLayout'));
  const master: Record<string, PlaceholderInfo> = {};
  const layout: Record<string, PlaceholderInfo> = {};

  if (layoutRel) {
    const layoutPath = resolveRelPath(slidePath, layoutRel.target);
    /* layout 里的形状 */
    const layoutXml = await readText(zip, layoutPath);
    if (layoutXml) {
      const layoutDoc = parser.parseFromString(layoutXml, 'application/xml');
      collectPlaceholders(layoutDoc.documentElement, layout);
    }
    /* 继续追 master (layout → master) */
    const layoutRelsPath = layoutPath.replace(/\/slideLayouts\//, '/slideLayouts/_rels/') + '.rels';
    const layoutRels = await readRelsWithType(zip, parser, layoutRelsPath);
    const masterRel = layoutRels.find(r => r.type.endsWith('/slideMaster'));
    if (masterRel) {
      const masterPath = resolveRelPath(layoutPath, masterRel.target);
      const masterXml = await readText(zip, masterPath);
      if (masterXml) {
        const masterDoc = parser.parseFromString(masterXml, 'application/xml');
        collectPlaceholders(masterDoc.documentElement, master);
      }
    }
  }

  /* 合并: master 底, layout 覆盖 */
  return { ...master, ...layout };
}

/** 从 layout/master doc 里, 找 spTree 下所有带 <p:ph> 的 sp, 抽 xfrm/bodyPr/defRPr 存 map. */
function collectPlaceholders(root: Element, out: Record<string, PlaceholderInfo>): void {
  const spTree = root.getElementsByTagNameNS(NS.p, 'spTree')[0];
  if (!spTree) return;
  const sps = Array.from(spTree.getElementsByTagNameNS(NS.p, 'sp'));
  for (const sp of sps) {
    /* <p:ph> 埋在 <p:nvSpPr>/<p:nvSpPr>/<p:ph> 深处, 直接 descendant 查最省事. */
    const phEl = firstDescendantNS(sp, NS.p, 'ph');
    if (!phEl) continue;
    const type = phEl.getAttribute('type') || '';
    const idx = phEl.getAttribute('idx') || '';
    const key = `${type}|${idx}`;

    const spPr = firstChildNS(sp, NS.p, 'spPr');
    const xfrm = firstChildNS(spPr, NS.a, 'xfrm');
    const frame = xfrm ? parseXfrm(xfrm) : undefined;

    const txBody = firstChildNS(sp, NS.p, 'txBody');
    const bodyPr = firstChildNS(txBody, NS.a, 'bodyPr');
    const vAlign = (bodyPr?.getAttribute('anchor') as 'top' | 'ctr' | 'b' | null) || undefined;

    /* 字体默认样式的解析优先级 (对齐 python-pptx / PowerPoint 实际生成结构):
     *   1. <p:txBody>/<a:lstStyle>/<a:lvl1pPr>/<a:defRPr> — 占位符段落级默认 (最常见, python-pptx 就写这里)
     *   2. <a:p>/<a:pPr>/<a:defRPr> — 首段段落默认
     *   3. 首段首 r 的 rPr — sample text 样式 (兜底)
     */
    const emptyCtx: ParseCtx = { theme: undefined, media: {}, slideWidth: 0, slideHeight: 0, placeholderFallback: {} };
    let defaultStyle: TextRunStyle | undefined;
    const lstStyle = firstChildNS(txBody, NS.a, 'lstStyle');
    const lvl1pPr = firstChildNS(lstStyle, NS.a, 'lvl1pPr');
    const lvl1DefRPr = firstChildNS(lvl1pPr, NS.a, 'defRPr');
    if (lvl1DefRPr) {
      defaultStyle = parseRunStyle(lvl1DefRPr, emptyCtx);
    } else {
      const firstP = firstChildNS(txBody, NS.a, 'p');
      const firstPpr = firstChildNS(firstP, NS.a, 'pPr');
      const paraDefRPr = firstChildNS(firstPpr, NS.a, 'defRPr');
      if (paraDefRPr) {
        defaultStyle = parseRunStyle(paraDefRPr, emptyCtx);
      } else {
        const firstR = firstChildNS(firstP, NS.a, 'r');
        const firstRpr = firstChildNS(firstR, NS.a, 'rPr');
        if (firstRpr) defaultStyle = parseRunStyle(firstRpr, emptyCtx);
      }
    }

    /* 存进 map, 用多 key 覆盖多种 fallback 路径 */
    out[key] = { frame: frame || undefined, defaultStyle, vAlign };
    if (type) out[`${type}|`] = { frame: frame || undefined, defaultStyle, vAlign };
    if (idx) out[`|${idx}`] = { frame: frame || undefined, defaultStyle, vAlign };
  }
}

function firstDescendantNS(el: Element | null, ns: string, name: string): Element | null {
  if (!el) return null;
  const list = el.getElementsByTagNameNS(ns, name);
  return list[0] || null;
}

/** 从 "a/b/foo.xml" 出发, 解析相对路径 "../c/bar.xml" → 绝对 "a/c/bar.xml". */
function resolveRelPath(from: string, rel: string): string {
  if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
  const baseDir = from.substring(0, from.lastIndexOf('/'));
  const parts = (baseDir + '/' + rel).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function getAttr(el: Element | null, name: string): string | null {
  if (!el) return null;
  return el.getAttribute(name);
}
function getAttrNS(el: Element | null, ns: string, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(ns, name);
}
function intAttr(el: Element | null, name: string, fallback: number): number {
  if (!el) return fallback;
  const v = el.getAttribute(name);
  if (v == null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function firstChildNS(el: Element | null, ns: string, name: string): Element | null {
  if (!el) return null;
  const list = el.getElementsByTagNameNS(ns, name);
  for (let i = 0; i < list.length; i++) {
    if (list[i].parentNode === el) return list[i];
  }
  return list[0] || null;
}
/** DOM 库无关的 element children (childNodes 过滤 nodeType=1).
 * 浏览器 DOMParser 有 .children, 但 node 里的 @xmldom/xmldom 没有 —
 * renderSlides.mjs 在 node 里跑 parser, 必须走 childNodes. */
function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1) out.push(c as Element);
  }
  return out;
}

function directChildrenNS(el: Element | null, ns: string, name: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 /* ELEMENT */ && (c as Element).namespaceURI === ns && (c as Element).localName === name) {
      out.push(c as Element);
    }
  }
  return out;
}

/* ============================================================
 * theme parse — 抽 color scheme + font scheme
 * ============================================================ */

async function parseThemeIfPresent(zip: JSZip, parser: DOMParser): Promise<Theme | undefined> {
  /* 简化: 拿第一个 theme (ppt/theme/theme1.xml). 有些 pptx 有多 theme, 罕见. */
  const themeXml = await readText(zip, 'ppt/theme/theme1.xml');
  if (!themeXml) return undefined;
  const doc = parser.parseFromString(themeXml, 'application/xml');
  const themeEl = doc.documentElement;
  if (!themeEl) return undefined;

  const colors: Record<string, string> = {};
  const clrScheme = themeEl.getElementsByTagNameNS(NS.a, 'clrScheme')[0];
  if (clrScheme) {
    const slots = elementChildren(clrScheme);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const key = slot.localName; /* 如 'dk1', 'lt1', 'accent1'... */
      /* slot 里可能是 <a:srgbClr val="RRGGBB"/> 或 <a:sysClr lastClr="RRGGBB"/> */
      const srgb = slot.getElementsByTagNameNS(NS.a, 'srgbClr')[0];
      const sysClr = slot.getElementsByTagNameNS(NS.a, 'sysClr')[0];
      if (srgb) colors[key] = '#' + (srgb.getAttribute('val') || '').toUpperCase();
      else if (sysClr) colors[key] = '#' + (sysClr.getAttribute('lastClr') || 'FFFFFF').toUpperCase();
    }
  }

  const fontScheme = themeEl.getElementsByTagNameNS(NS.a, 'fontScheme')[0];
  let majorFont: string | undefined;
  let minorFont: string | undefined;
  if (fontScheme) {
    const major = fontScheme.getElementsByTagNameNS(NS.a, 'majorFont')[0];
    const minor = fontScheme.getElementsByTagNameNS(NS.a, 'minorFont')[0];
    if (major) {
      const latin = major.getElementsByTagNameNS(NS.a, 'latin')[0];
      majorFont = latin?.getAttribute('typeface') || undefined;
    }
    if (minor) {
      const latin = minor.getElementsByTagNameNS(NS.a, 'latin')[0];
      minorFont = latin?.getAttribute('typeface') || undefined;
    }
  }

  return { colors, majorFont, minorFont };
}

/* ============================================================
 * slide parse — 主形状树
 * ============================================================ */

async function parseSlide(
  zip: JSZip, parser: DOMParser, slidePath: string, index: number, theme: Theme | undefined,
  slideWidth: number, slideHeight: number, underlayCache: Map<string, PartVisuals> = new Map(),
): Promise<Slide | null> {
  const slideXml = await readText(zip, slidePath);
  if (!slideXml) return null;
  const doc = parser.parseFromString(slideXml, 'application/xml');

  /* slide rels → 找 image / hyperlink / slideLayout 等资源 */
  const relsPath = slidePath.replace(/\/slides\//, '/slides/_rels/') + '.rels';
  const relsTypeMap = await readRelsWithType(zip, parser, relsPath);
  /* 预加载所有 image rels 到 dataUrl */
  const media = await loadPartMedia(zip, parser, slidePath);

  /* 加载 slideLayout 和 slideMaster 的占位符表，供缺少自身 xfrm 的形状继承位置。 */
  const placeholderFallback = await loadPlaceholderChain(zip, parser, relsTypeMap, slidePath);

  const ctx: ParseCtx = {
    theme, media, slideWidth, slideHeight,
    placeholderFallback,
  };

  const sldEl = firstChildNS(doc.documentElement, NS.p, 'cSld') || doc.documentElement;
  const spTree = firstChildNS(sldEl, NS.p, 'spTree');

  /* 背景按 slide → layout → master 继承；layout/master 的非占位符形状作为
   * 本页形状的底层装饰，并遵守 showMasterSp。 */
  const underlay = await loadUnderlay(zip, parser, relsTypeMap, slidePath, theme, slideWidth, slideHeight, underlayCache);
  const background = parseBackground(firstChildNS(sldEl, NS.p, 'bg'), ctx) ?? underlay.background;
  const hideMasterShapes = doc.documentElement.getAttribute('showMasterSp') === '0';

  const shapes: Shape[] = hideMasterShapes ? [] : [...underlay.shapes];
  if (spTree) {
    for (const child of elementChildren(spTree)) {
      collectShapesInto(child, ctx, shapes);
    }
  }

  return {
    index,
    id: (doc.documentElement.getAttribute('id') || String(index)),
    background,
    shapes,
  };
}

/* ---------- 版式 / 母版这一层 ---------- */

/** 一个版式或母版零件里, 会画到每一页上的东西 */
interface PartVisuals {
  background?: Fill;
  /** 非占位符形状 (占位符只是给本页用的模板, 不直接画) */
  shapes: Shape[];
  /** 这个零件自己带 showMasterSp="0" (版式上: 不显示母版的图形) */
  hidesMaster: boolean;
}

/** 某个零件 (slide / layout / master) 的媒体: rId → dataUrl。图片按**这个零件自己的** rels 解析 */
async function loadPartMedia(zip: JSZip, parser: DOMParser, partPath: string): Promise<MediaMap> {
  const relsPath = partPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  const relsMap = await readRels(zip, parser, relsPath);
  const media: MediaMap = {};
  for (const [rId, target] of Object.entries(relsMap)) {
    if (!/media\//.test(target)) continue;
    const abs = resolveRelPath(partPath, target);
    const b64 = await readBase64(zip, abs);
    if (!b64) continue;
    media[rId] = `data:${mimeOfPath(abs)};base64,${b64}`;
  }
  return media;
}

/** <p:bg>: 填充在 <p:bgPr> 里; 或者 <p:bgRef idx=…> 引用主题背景样式 (按它带的颜色近似) */
function parseBackground(bgEl: Element | null, ctx: ParseCtx): Fill | undefined {
  if (!bgEl) return undefined;
  const bgPr = firstChildNS(bgEl, NS.p, 'bgPr');
  if (bgPr) return parseFillFrom(bgPr, ctx);
  const bgRef = firstChildNS(bgEl, NS.p, 'bgRef');
  if (bgRef) {
    const c = resolveColorEl(bgRef, ctx);
    if (c) return { kind: 'solid', color: c };
  }
  return parseFillFrom(bgEl, ctx);
}

async function loadPartVisuals(
  zip: JSZip, parser: DOMParser, partPath: string, theme: Theme | undefined,
  slideWidth: number, slideHeight: number, cache: Map<string, PartVisuals>,
): Promise<PartVisuals> {
  const hit = cache.get(partPath);
  if (hit) return hit;
  const empty: PartVisuals = { shapes: [], hidesMaster: false };
  const xml = await readText(zip, partPath);
  if (!xml) { cache.set(partPath, empty); return empty; }
  const doc = parser.parseFromString(xml, 'application/xml');
  const ctx: ParseCtx = { theme, media: await loadPartMedia(zip, parser, partPath), slideWidth, slideHeight, placeholderFallback: {} };
  const cSld = firstChildNS(doc.documentElement, NS.p, 'cSld');
  const spTree = firstChildNS(cSld, NS.p, 'spTree');
  const shapes: Shape[] = [];
  if (spTree) {
    for (const child of elementChildren(spTree)) {
      if (firstDescendantNS(child, NS.p, 'ph')) continue;
      collectShapesInto(child, ctx, shapes);
    }
  }
  const out: PartVisuals = {
    background: parseBackground(firstChildNS(cSld, NS.p, 'bg'), ctx),
    shapes,
    hidesMaster: doc.documentElement.getAttribute('showMasterSp') === '0',
  };
  cache.set(partPath, out);
  return out;
}

/** 本页下面垫的一层: 背景 (版式 ?? 母版) + 装饰形状 (母版在下、版式在上) */
async function loadUnderlay(
  zip: JSZip, parser: DOMParser,
  slideRels: Array<{ id: string; type: string; target: string }>,
  slidePath: string, theme: Theme | undefined, slideWidth: number, slideHeight: number,
  cache: Map<string, PartVisuals>,
): Promise<{ background?: Fill; shapes: Shape[] }> {
  const layoutRel = slideRels.find(r => r.type.endsWith('/slideLayout'));
  if (!layoutRel) return { shapes: [] };
  const layoutPath = resolveRelPath(slidePath, layoutRel.target);
  const layout = await loadPartVisuals(zip, parser, layoutPath, theme, slideWidth, slideHeight, cache);
  const layoutRelsPath = layoutPath.replace(/\/slideLayouts\//, '/slideLayouts/_rels/') + '.rels';
  const layoutRels = await readRelsWithType(zip, parser, layoutRelsPath);
  const masterRel = layoutRels.find(r => r.type.endsWith('/slideMaster'));
  const master = masterRel
    ? await loadPartVisuals(zip, parser, resolveRelPath(layoutPath, masterRel.target), theme, slideWidth, slideHeight, cache)
    : { shapes: [], hidesMaster: false } as PartVisuals;
  return {
    background: layout.background ?? master.background,
    shapes: [...(layout.hidesMaster ? [] : master.shapes), ...layout.shapes],
  };
}

interface PlaceholderInfo {
  frame?: Frame;
  /** 默认 rPr — 段内 run 没设时兜底 */
  defaultStyle?: TextRunStyle;
  vAlign?: 'top' | 'ctr' | 'b';
}

interface ParseCtx {
  theme?: Theme;
  media: MediaMap;
  slideWidth: number;
  slideHeight: number;
  /** placeholder (type, idx) → 从 layout/master 继承的默认信息.
   * key 格式: `${type}|${idx}` (缺失部分空串). 查找时按 (type+idx) → (type) → (idx) 三级 fallback. */
  placeholderFallback: Record<string, PlaceholderInfo>;
}

/**
 * 递归解析 group shape，并将所有实际渲染形状按文档顺序收进 out 数组。
 */
function collectShapesInto(el: Element, ctx: ParseCtx, out: Shape[]): void {
  const local = el.localName;
  if (local === 'sp') {
    const shape = parseSpShape(el, ctx);
    if (shape) out.push(shape);
    return;
  }
  if (local === 'pic') {
    const shape = parsePicShape(el, ctx);
    if (shape) out.push(shape);
    return;
  }
  if (local === 'grpSp') {
    /* 组内子形状 xfrm 已是绝对坐标, 直接 flatten. */
    for (const c of elementChildren(el)) {
      collectShapesInto(c, ctx, out);
    }
    return;
  }
  if (local === 'graphicFrame') {
    /* 表格 round-trip (确定性硬化): exporter 写的 <a:tbl> 读回 TableShape.
     * chart / SmartArt 仍跳过 (graphicData uri 不匹配时返回 null). */
    const shape = parseGraphicFrameTable(el, ctx);
    if (shape) out.push(shape);
    return;
  }
}

/* ---------- <p:graphicFrame> → TableShape ---------- */
function parseGraphicFrameTable(el: Element, ctx: ParseCtx): TableShape | null {
  const graphic = firstChildNS(el, NS.a, 'graphic');
  const graphicData = graphic ? firstChildNS(graphic, NS.a, 'graphicData') : null;
  if (!graphicData) return null;
  const uri = graphicData.getAttribute('uri') || '';
  if (!uri.includes('/table')) return null;
  const tbl = firstChildNS(graphicData, NS.a, 'tbl');
  if (!tbl) return null;

  /* frame: 规范是 <p:xfrm> (off/ext 仍是 a:); 兼容老 exporter 写的 <a:xfrm> */
  const xfrm = firstChildNS(el, NS.p, 'xfrm') ?? firstChildNS(el, NS.a, 'xfrm');
  const off = xfrm ? firstChildNS(xfrm, NS.a, 'off') : null;
  const ext = xfrm ? firstChildNS(xfrm, NS.a, 'ext') : null;
  if (!off || !ext) return null;
  const frame: Frame = {
    x: intAttr(off, 'x', 0),
    y: intAttr(off, 'y', 0),
    w: intAttr(ext, 'cx', 0),
    h: intAttr(ext, 'cy', 0),
  };

  const grid = firstChildNS(tbl, NS.a, 'tblGrid');
  const columnWidths = grid
    ? directChildrenNS(grid, NS.a, 'gridCol').map((c) => intAttr(c, 'w', 0))
    : [];

  const tblPr = firstChildNS(tbl, NS.a, 'tblPr');
  const hasHeader = tblPr ? tblPr.getAttribute('firstRow') === '1' : undefined;
  const zebra = tblPr ? tblPr.getAttribute('bandRow') === '1' : undefined;

  const rows: TableRow[] = directChildrenNS(tbl, NS.a, 'tr').map((tr) => {
    const cells: TableCell[] = directChildrenNS(tr, NS.a, 'tc').map((tc) => {
      const txBody = firstChildNS(tc, NS.a, 'txBody');
      const paragraphs = txBody ? parseTxBody(txBody, ctx) : undefined;
      const tcPr = firstChildNS(tc, NS.a, 'tcPr');
      const fill = tcPr ? parseFillFrom(tcPr, ctx) : undefined;
      const vAlign = (tcPr?.getAttribute('anchor') as 'top' | 'ctr' | 'b' | null) || undefined;
      const align = paragraphs?.[0]?.align;
      const gridSpan = tc.getAttribute('gridSpan');
      const rowSpan = tc.getAttribute('rowSpan');
      /* 被合并掉的格 (hMerge / vMerge) 还留在 XML 里, 渲染时要跳过, 不然合并的表会多出一堆格 */
      const merged = tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1';
      return {
        paragraphs,
        fill,
        vAlign,
        align: align === 'just' ? 'l' : align,
        colSpan: gridSpan ? parseInt(gridSpan, 10) : undefined,
        rowSpan: rowSpan ? parseInt(rowSpan, 10) : undefined,
        ...(merged ? { merged: true } : {}),
      };
    });
    return { heightEmu: intAttr(tr, 'h', 0) || undefined, cells };
  });

  return { kind: 'table', frame, columnWidths, rows, hasHeader, zebra };
}

/** parser 认识并透传的 prstGeom 集合 — 跟 model ShapeRect.geom 枚举同步 */
const KNOWN_GEOMS = new Set([
  'rect', 'roundRect', 'ellipse', 'line', 'straightConnector1',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow',
  'chevron', 'homePlate', 'star5', 'star6', 'pentagon', 'hexagon', 'triangle',
  'diagonalStripe', 'plaque', 'ribbon2',
]);

/**
 * <a:custGeom> → SVG 路径。
 *
 * 解析器将 custGeom 的 path 指令转换为 SVG path，覆盖导出器写入的
 * moveTo、lnTo、cubicBezTo、quadBezTo、arcTo 和 close；多条 path 统一到
 * 第一条 path 的坐标空间，全部 path 为 fill=none 时标记为只描边。
 */
function parseCustGeom(custGeom: Element): { d: string; viewBox: { width: number; height: number }; strokeOnly: boolean } | null {
  const pathLst = firstChildNS(custGeom, NS.a, 'pathLst');
  const paths = directChildrenNS(pathLst, NS.a, 'path');
  if (paths.length === 0) return null;
  const W0 = Number(paths[0]!.getAttribute('w')) || 21600;
  const H0 = Number(paths[0]!.getAttribute('h')) || 21600;
  const f = (v: number) => String(Math.round(v * 100) / 100);
  const out: string[] = [];
  let strokeOnly = true;
  for (const p of paths) {
    const sx = W0 / (Number(p.getAttribute('w')) || W0);
    const sy = H0 / (Number(p.getAttribute('h')) || H0);
    if ((p.getAttribute('fill') || '') !== 'none') strokeOnly = false;
    const pt = (e: Element): [number, number] => [Number(e.getAttribute('x')) * sx, Number(e.getAttribute('y')) * sy];
    let cx = 0;
    let cy = 0;
    for (let n = p.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const cmd = n as Element;
      const pts = directChildrenNS(cmd, NS.a, 'pt').map(pt);
      switch (cmd.localName) {
        case 'moveTo':
          if (pts[0]) { [cx, cy] = pts[0]; out.push(`M${f(cx)} ${f(cy)}`); }
          break;
        case 'lnTo':
          if (pts[0]) { [cx, cy] = pts[0]; out.push(`L${f(cx)} ${f(cy)}`); }
          break;
        case 'cubicBezTo':
          if (pts.length === 3) {
            out.push(`C${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' ')}`);
            [cx, cy] = pts[2]!;
          }
          break;
        case 'quadBezTo':
          if (pts.length === 2) {
            out.push(`Q${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' ')}`);
            [cx, cy] = pts[1]!;
          }
          break;
        case 'arcTo': {
          /* OOXML: 从当前点出发, 沿半径 (wR,hR) 的椭圆, 起始角 stAng 扫过 swAng (1/60000 度, y 向下)。
           * 反推圆心, 再算终点, 换成 SVG 的 A 指令。 */
          const wR = Number(cmd.getAttribute('wR')) * sx;
          const hR = Number(cmd.getAttribute('hR')) * sy;
          const st = (Number(cmd.getAttribute('stAng')) / 60000) * (Math.PI / 180);
          const sw = (Number(cmd.getAttribute('swAng')) / 60000) * (Math.PI / 180);
          const ox = cx - wR * Math.cos(st);
          const oy = cy - hR * Math.sin(st);
          const ex = ox + wR * Math.cos(st + sw);
          const ey = oy + hR * Math.sin(st + sw);
          out.push(`A${f(wR)} ${f(hR)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${f(ex)} ${f(ey)}`);
          cx = ex;
          cy = ey;
          break;
        }
        case 'close':
          out.push('Z');
          break;
      }
    }
  }
  return out.length ? { d: out.join(' '), viewBox: { width: W0, height: H0 }, strokeOnly } : null;
}

/* ---------- <p:sp> ---------- */
function parseSpShape(el: Element, ctx: ParseCtx): TextShape | ShapeRect | null {
  const spPr = firstChildNS(el, NS.p, 'spPr');
  const txBody = firstChildNS(el, NS.p, 'txBody');
  let frame = parseXfrm(firstChildNS(spPr, NS.a, 'xfrm'));

  /* 占位符优先继承 layout/master 中同 type 与 idx 的 frame，再退化到
   * type 或 idx 匹配，最后使用按占位符类型计算的默认区域。 */
  let phFallback: PlaceholderInfo | undefined;
  const phEl = firstDescendantNS(el, NS.p, 'ph');
  if (phEl) {
    const type = phEl.getAttribute('type') || '';
    const idx = phEl.getAttribute('idx') || '';
    phFallback = ctx.placeholderFallback[`${type}|${idx}`]
      || ctx.placeholderFallback[`${type}|`]
      || ctx.placeholderFallback[`|${idx}`];
    if (!frame && phFallback?.frame) frame = phFallback.frame;
    if (!frame) frame = defaultFrameForPlaceholder(type, ctx);
  }
  if (!frame) {
    /* 非占位符且缺少 xfrm 时使用覆盖主要内容区域的默认 frame。 */
    frame = {
      x: Math.floor(ctx.slideWidth * 0.05),
      y: Math.floor(ctx.slideHeight * 0.15),
      w: Math.floor(ctx.slideWidth * 0.9),
      h: Math.floor(ctx.slideHeight * 0.7),
    };
  }

  const prstGeom = firstChildNS(spPr, NS.a, 'prstGeom');
  const prst = prstGeom?.getAttribute('prst') || 'rect';
  const custGeomEl = prstGeom ? null : firstChildNS(spPr, NS.a, 'custGeom');
  const custom = custGeomEl ? parseCustGeom(custGeomEl) : null;
  const fill = parseFillFrom(spPr, ctx);
  const border = parseLineFrom(spPr, ctx);

  const paragraphs = txBody ? parseTxBody(txBody, ctx, phFallback?.defaultStyle) : undefined;
  const bodyPr = firstChildNS(txBody, NS.a, 'bodyPr');
  const vAlign = (bodyPr?.getAttribute('anchor') as 'top' | 'ctr' | 'b' | null)
    || phFallback?.vAlign
    || undefined;

  /* 装饰形状 (有 fill / border 但没实质文字) → 归为 ShapeRect;
   * 纯文本框 (fill=none 或 shape 只是文字容器) → 归为 TextShape. */
  const hasText = !!paragraphs && paragraphs.some(p => p.runs.some(r => (r.text || '').trim()));
  const hasFillOrBorder = !!(fill && fill.kind !== 'none') || !!border;

  if (hasText && !hasFillOrBorder && !custom) {
    /* autoFit 读回 : normAutofit=shrinkText / spAutoFit=resizeShapeToFitText */
    let autoFit: 'none' | 'shrinkText' | 'resizeShapeToFitText' | undefined;
    if (bodyPr) {
      if (firstChildNS(bodyPr, NS.a, 'normAutofit')) autoFit = 'shrinkText';
      else if (firstChildNS(bodyPr, NS.a, 'spAutoFit')) autoFit = 'resizeShapeToFitText';
      else autoFit = 'none';
    }
    return {
      kind: 'text',
      frame,
      paragraphs: paragraphs!,
      vAlign,
      padding: paddingFromBodyPr(bodyPr),
      autoFit,
    };
  }
  /* 都算 shape rect (可能带文字, 可能不带) */
  return {
    kind: 'shape',
    frame,
    /* 已知 prst 直接透传给渲染器；未知几何使用 other 的矩形兜底。 */
    geom: (custom ? 'custom' : KNOWN_GEOMS.has(prst) ? prst : 'other') as ShapeRect['geom'],
    ...(custom ? { customPath: custom } : {}),
    fill,
    border,
    paragraphs,
    vAlign,
  };
}

/** placeholder type → 一个"看起来不错"的默认位置 (仅当 layout 里也没找到时兜底). */
function defaultFrameForPlaceholder(type: string, ctx: ParseCtx): Frame {
  const W = ctx.slideWidth, H = ctx.slideHeight;
  switch (type) {
    case 'title':
    case 'ctrTitle':
      return { x: Math.floor(W * 0.06), y: Math.floor(H * 0.06), w: Math.floor(W * 0.88), h: Math.floor(H * 0.22) };
    case 'subTitle':
      return { x: Math.floor(W * 0.1), y: Math.floor(H * 0.32), w: Math.floor(W * 0.8), h: Math.floor(H * 0.18) };
    case 'body':
    case '':
    default:
      return { x: Math.floor(W * 0.06), y: Math.floor(H * 0.3), w: Math.floor(W * 0.88), h: Math.floor(H * 0.65) };
  }
}

/* ---------- <p:pic> ---------- */
function parsePicShape(el: Element, ctx: ParseCtx): PictureShape | null {
  const spPr = firstChildNS(el, NS.p, 'spPr');
  let frame = parseXfrm(firstChildNS(spPr, NS.a, 'xfrm'));

  /* 图片占位符也可以从 layout/master 继承 frame，匹配逻辑与普通占位符一致。 */
  if (!frame) {
    const phEl = firstDescendantNS(el, NS.p, 'ph');
    if (phEl) {
      const type = phEl.getAttribute('type') || '';
      const idx = phEl.getAttribute('idx') || '';
      const ph = ctx.placeholderFallback[`${type}|${idx}`]
        || ctx.placeholderFallback[`${type}|`]
        || ctx.placeholderFallback[`|${idx}`];
      if (ph?.frame) frame = ph.frame;
      if (!frame) frame = defaultFrameForPlaceholder(type, ctx);
    }
  }
  if (!frame) {
    /* 非 placeholder pic 且没 xfrm → 兜底全屏 (通常是背景全铺图) */
    frame = { x: 0, y: 0, w: ctx.slideWidth, h: ctx.slideHeight };
  }

  const blipFill = firstChildNS(el, NS.p, 'blipFill');
  const blip = firstChildNS(blipFill, NS.a, 'blip');
  const embed = blip?.getAttributeNS(NS.r, 'embed') || getAttr(blip, 'r:embed');
  if (!embed) return null;
  const src = ctx.media[embed];
  if (!src) return null;

  /* stretch / tile — pptx 里默认 stretch fillRect (等比拉伸铺满). srcRect 里裁剪暂不支持. */
  const stretch = firstChildNS(blipFill, NS.a, 'stretch');
  const objectFit: 'cover' | 'fill' = stretch ? 'fill' : 'cover';

  const nvPicPr = firstChildNS(el, NS.p, 'nvPicPr');
  const cNvPr = firstChildNS(nvPicPr, NS.p, 'cNvPr');
  const alt = cNvPr?.getAttribute('descr') || cNvPr?.getAttribute('name') || undefined;

  return {
    kind: 'picture',
    frame,
    src,
    alt,
    objectFit,
  };
}

/* ---------- xfrm → Frame ---------- */
function parseXfrm(xfrm: Element | null): Frame | null {
  if (!xfrm) return null;
  const off = firstChildNS(xfrm, NS.a, 'off');
  const ext = firstChildNS(xfrm, NS.a, 'ext');
  if (!off || !ext) return null;
  return {
    x: intAttr(off, 'x', 0),
    y: intAttr(off, 'y', 0),
    w: intAttr(ext, 'cx', 0),
    h: intAttr(ext, 'cy', 0),
  };
}

/* ---------- txBody → Paragraph[] ---------- */
function parseTxBody(txBody: Element, ctx: ParseCtx, inheritedStyle?: TextRunStyle): Paragraph[] {
  const out: Paragraph[] = [];
  const paras = directChildrenNS(txBody, NS.a, 'p');
  for (const pEl of paras) {
    const pPr = firstChildNS(pEl, NS.a, 'pPr');
    const align = (pPr?.getAttribute('algn') as 'l' | 'ctr' | 'r' | 'just' | null) || undefined;
    const level = pPr ? intAttr(pPr, 'lvl', 0) : 0;
    const indent = pPr ? intAttr(pPr, 'indent', 0) : undefined;
    const spaceBeforeEmu = spacingEmu(pPr, 'spcBef');
    const spaceAfterEmu = spacingEmu(pPr, 'spcAft');
    /* 【 确定性硬化】lnSpc spcPts 读回 (exporter 钉死的行高) — round-trip 保真 */
    const lineSpacingPt = parseLnSpcPt(pPr);

    const bullet = parseBullet(pPr);
    const defRPr = firstChildNS(pPr, NS.a, 'defRPr');
    /* 段落 default: 继承占位符默认样式 (layout/master) + 段落自己的 defRPr */
    const paraDefault: TextRunStyle = { ...(inheritedStyle || {}), ...(defRPr ? parseRunStyle(defRPr, ctx) : {}) };

    const runs: TextRun[] = [];
    for (const c of elementChildren(pEl)) {
      const cel = c;
      if (cel.localName === 'r' && cel.namespaceURI === NS.a) {
        const rPr = firstChildNS(cel, NS.a, 'rPr');
        const tEl = firstChildNS(cel, NS.a, 't');
        const text = tEl?.textContent ?? '';
        const style = { ...paraDefault, ...(rPr ? parseRunStyle(rPr, ctx) : {}) };
        runs.push({ text, style });
      } else if (cel.localName === 'br' && cel.namespaceURI === NS.a) {
        runs.push({ text: '\n', style: paraDefault });
      } else if (cel.localName === 'fld' && cel.namespaceURI === NS.a) {
        /* 域 (页码/时间等), 只取 <a:t> 内容, 不做动态求值 */
        const tEl = firstChildNS(cel, NS.a, 't');
        if (tEl) {
          const rPr = firstChildNS(cel, NS.a, 'rPr');
          const style = { ...paraDefault, ...(rPr ? parseRunStyle(rPr, ctx) : {}) };
          runs.push({ text: tEl.textContent ?? '', style });
        }
      }
    }

    /* 段落里啥都没 (纯 <a:endParaRPr>) 就跳过, 否则渲染出一个空行 */
    if (runs.length === 0 && !bullet) continue;

    out.push({
      runs,
      align,
      defaultRun: paraDefault,
      lineSpacingPt,
      indent: indent || undefined,
      spaceBeforeEmu,
      spaceAfterEmu,
      bullet,
      level,
    });
  }
  return out;
}

/** <a:lnSpc><a:spcPts val="2450"/></a:lnSpc> → 24.5 (pt). spcPct (百分比) 返回 undefined —
 * 百分比行高依赖渲染端字体 metrics, 正是确定性硬化要消灭的形态. */
function parseLnSpcPt(pPr: Element | null): number | undefined {
  if (!pPr) return undefined;
  const el = firstChildNS(pPr, NS.a, 'lnSpc');
  if (!el) return undefined;
  const pts = firstChildNS(el, NS.a, 'spcPts');
  if (pts) return intAttr(pts, 'val', 0) / 100;
  return undefined;
}

function spacingEmu(pPr: Element | null, name: string): number | undefined {
  if (!pPr) return undefined;
  const el = firstChildNS(pPr, NS.a, name);
  if (!el) return undefined;
  const pts = firstChildNS(el, NS.a, 'spcPts');
  if (pts) return intAttr(pts, 'val', 0) * 127; /* val 是 hundredths of point, 100 EMU = 1 hundredth of pt */
  const pct = firstChildNS(el, NS.a, 'spcPct');
  if (pct) return undefined; /* 百分比先跳过, 需要相对字号运算 */
  return undefined;
}

function parseBullet(pPr: Element | null): Paragraph['bullet'] {
  if (!pPr) return undefined;
  const buNone = firstChildNS(pPr, NS.a, 'buNone');
  if (buNone) return { kind: 'none' };
  const buChar = firstChildNS(pPr, NS.a, 'buChar');
  if (buChar) {
    const ch = buChar.getAttribute('char') || '•';
    return { kind: 'char', char: ch };
  }
  const buAutoNum = firstChildNS(pPr, NS.a, 'buAutoNum');
  if (buAutoNum) return { kind: 'auto', scheme: buAutoNum.getAttribute('type') || 'arabicPeriod' };
  return undefined;
}

/* ---------- rPr → TextRunStyle ---------- */
function parseRunStyle(rPr: Element, ctx: ParseCtx): TextRunStyle {
  const style: TextRunStyle = {};
  const sz = rPr.getAttribute('sz');
  if (sz) style.fontSizePt = parseInt(sz, 10) / 100;
  if (rPr.getAttribute('b') === '1') style.bold = true;
  if (rPr.getAttribute('i') === '1') style.italic = true;
  const u = rPr.getAttribute('u');
  if (u && u !== 'none') style.underline = true;
  const strike = rPr.getAttribute('strike');
  if (strike && strike !== 'noStrike') style.strike = true;
  /* 一致性调整： 内部 spacing 语义 = EMU (跟其它 unit 字段一致).
   * OOXML spc 属性是 hundredths of a point, 换算 EMU 是 * 127.  parser 和 writer 现在对齐. */
  const spc = rPr.getAttribute('spc');
  if (spc) style.spacing = parseInt(spc, 10) * 127;

  /* 颜色 — solidFill 或 直接 srgbClr */
  const solidFill = firstChildNS(rPr, NS.a, 'solidFill');
  if (solidFill) {
    const c = resolveColorEl(solidFill, ctx);
    if (c) style.color = c;
  }

  /* 字体 — latin / ea 分排读回 (确定性硬化: exporter 写的中英分排要能 round-trip).
   * fontFamily 兜底 = latin (老代码兼容), fontLatin/fontEast 分别保留. */
  const latin = firstChildNS(rPr, NS.a, 'latin');
  if (latin) {
    const face = resolveThemeFont(latin.getAttribute('typeface') || '', ctx.theme);
    style.fontFamily = face;
    style.fontLatin = face;
  }
  const ea = firstChildNS(rPr, NS.a, 'ea');
  if (ea) {
    const face = resolveThemeFont(ea.getAttribute('typeface') || '', ctx.theme);
    style.fontEast = face;
    if (!style.fontFamily) style.fontFamily = face;
  }

  return style;
}

function resolveThemeFont(face: string, theme?: Theme): string {
  if (!face) return '';
  if (face === '+mj-lt' || face === '+mj-ea' || face === '+mj-cs') return theme?.majorFont || face;
  if (face === '+mn-lt' || face === '+mn-ea' || face === '+mn-cs') return theme?.minorFont || face;
  return face;
}

/* ---------- fill parsing ---------- */
function parseFillFrom(container: Element | null, ctx: ParseCtx): Fill | undefined {
  if (!container) return undefined;
  /* 只认**直接子元素**。firstChildNS 找不到直接子元素时会退回任意后代 —— 于是
   * "有填充、无描边" 的色块 (<a:solidFill/> + <a:ln><a:noFill/></a:ln>, 模板里最常见的写法)
   * 被描边里的 noFill 判成无填充, 预览里整块消失; 反过来 "无填充、彩色描边" 会被描边色填满。 */
  const direct = (name: string) => directChildrenNS(container, NS.a, name)[0] ?? null;
  const noFill = direct('noFill');
  if (noFill) return { kind: 'none' };
  const solidFill = direct('solidFill');
  if (solidFill) {
    const c = resolveColorEl(solidFill, ctx);
    if (c) return { kind: 'solid', color: c };
  }
  const blipFill = direct('blipFill');
  if (blipFill) {
    const blip = firstChildNS(blipFill, NS.a, 'blip');
    const embed = blip?.getAttributeNS(NS.r, 'embed') || getAttr(blip, 'r:embed');
    if (embed && ctx.media[embed]) return { kind: 'pic', src: ctx.media[embed] };
  }
  const gradFill = direct('gradFill');
  if (gradFill) {
    const gsLst = firstChildNS(gradFill, NS.a, 'gsLst');
    const stops: Array<{ pos: number; color: string }> = [];
    if (gsLst) {
      for (const gs of directChildrenNS(gsLst, NS.a, 'gs')) {
        const pos = intAttr(gs, 'pos', 0) / 1000; /* pos in thousandths of percent */
        const c = resolveColorEl(gs, ctx);
        if (c) stops.push({ pos, color: c });
      }
    }
    if (stops.length > 0) {
      const lin = firstChildNS(gradFill, NS.a, 'lin');
      const angleDeg = lin ? intAttr(lin, 'ang', 5400000) / 60000 : 90;
      return { kind: 'grad', stops, angleDeg };
    }
  }
  return undefined;
}

/* ---------- line (border) ---------- */
function parseLineFrom(spPr: Element | null, ctx: ParseCtx): { color: string; widthEmu: number } | undefined {
  if (!spPr) return undefined;
  const ln = firstChildNS(spPr, NS.a, 'ln');
  if (!ln) return undefined;
  const w = intAttr(ln, 'w', 0);
  const noFill = firstChildNS(ln, NS.a, 'noFill');
  if (noFill || w <= 0) return undefined;
  const solidFill = firstChildNS(ln, NS.a, 'solidFill');
  const c = solidFill ? resolveColorEl(solidFill, ctx) : '#000000';
  return { color: c || '#000000', widthEmu: w };
}

/* ---------- color resolver ---------- */
/** 解析色 → CSS rgba(...) 字串, alpha 支持 <a:alpha val="X"/> (X 是千分位). */
function resolveColorEl(container: Element, ctx: ParseCtx): string | null {
  let hex: string | null = null;
  const srgb = firstChildNS(container, NS.a, 'srgbClr');
  if (srgb) {
    hex = '#' + (srgb.getAttribute('val') || '000000').toUpperCase();
    hex = applyColorMods(hex, srgb);
  } else {
    const scheme = firstChildNS(container, NS.a, 'schemeClr');
    if (scheme) {
      const key = scheme.getAttribute('val') || '';
      hex = ctx.theme?.colors[key] || '#000000';
      hex = applyColorMods(hex, scheme);
    } else {
      const sys = firstChildNS(container, NS.a, 'sysClr');
      if (sys) hex = '#' + (sys.getAttribute('lastClr') || '000000').toUpperCase();
    }
  }
  if (!hex) return null;
  /* alpha 修饰 — <a:alpha val="30000"/> 意为 30% 透明 → rgba 保留 30/100 alpha */
  const colorContainer = firstChildNS(container, NS.a, 'srgbClr')
    || firstChildNS(container, NS.a, 'schemeClr')
    || firstChildNS(container, NS.a, 'sysClr');
  const alphaEl = colorContainer ? firstChildNS(colorContainer, NS.a, 'alpha') : null;
  if (alphaEl) {
    const alphaPct = intAttr(alphaEl, 'val', 100000) / 100000; /* val 是 percent-thousandths */
    const rgb = hexToRgb(hex);
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alphaPct.toFixed(3)})`;
  }
  return hex;
}

/** color modifier: lumMod / lumOff / shade / tint / alpha 简化实现 (只处理 lumMod/lumOff/tint/shade). */
function applyColorMods(hex: string, container: Element): string {
  const lumMod = firstChildNS(container, NS.a, 'lumMod');
  const lumOff = firstChildNS(container, NS.a, 'lumOff');
  const tint = firstChildNS(container, NS.a, 'tint');
  const shade = firstChildNS(container, NS.a, 'shade');
  if (!lumMod && !lumOff && !tint && !shade) return hex;
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  let { r, g, b } = rgb;
  if (tint) {
    const t = intAttr(tint, 'val', 0) / 100000;
    r = Math.round(r + (255 - r) * t);
    g = Math.round(g + (255 - g) * t);
    b = Math.round(b + (255 - b) * t);
  }
  if (shade) {
    const s = intAttr(shade, 'val', 0) / 100000;
    r = Math.round(r * s);
    g = Math.round(g * s);
    b = Math.round(b * s);
  }
  if (lumMod || lumOff) {
    const lm = lumMod ? intAttr(lumMod, 'val', 100000) / 100000 : 1;
    const lo = lumOff ? intAttr(lumOff, 'val', 0) / 100000 : 0;
    /* 近似: 均匀应用到 RGB (不做真 HSL 转换) */
    r = clamp255(Math.round(r * lm + 255 * lo));
    g = clamp255(Math.round(g * lm + 255 * lo));
    b = clamp255(Math.round(b * lm + 255 * lo));
  }
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('');
}
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
function clamp255(v: number): number { return Math.max(0, Math.min(255, v)); }

/* ---------- bodyPr padding ---------- */
function paddingFromBodyPr(bodyPr: Element | null): { l: number; t: number; r: number; b: number } {
  /* OOXML 默认: lIns/rIns=91440 (0.1in), tIns/bIns=45720 (0.05in) — 之前四边都拍 91440,
   * 上下各多了 4.8px, 属于"看不见的猜测". 我们自己导出的 pptx 现在总是显式写 insets. */
  const defH = 91440;
  const defV = 45720;
  if (!bodyPr) return { l: defH, t: defV, r: defH, b: defV };
  return {
    l: intAttr(bodyPr, 'lIns', defH),
    t: intAttr(bodyPr, 'tIns', defV),
    r: intAttr(bodyPr, 'rIns', defH),
    b: intAttr(bodyPr, 'bIns', defV),
  };
}

/* ---------- mime by extension ---------- */
function mimeOfPath(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.bmp')) return 'image/bmp';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
