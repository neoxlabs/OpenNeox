/**
 * schema — 业务层 JSON schema (v1) + Presentation 双向转换.
 *
 * 为什么单独设计:
 *   Codex 明确说了 —— tool 接口不要绑内部数据结构 (EMU / 复杂 rPr 嵌套), 会跟内部改动一起破.
 *   业务 JSON 是"agent 眼里的 pptx"简化视图: 用 CSS px, 用扁平字段, 有版本号, 明确 slot.
 *
 *   agent 通过 `create_slides` tool 传 JsonPresentation → 我们 fromJson → 内部 Presentation
 *   → builder 侧继续用命令式 API 补细节 (可选) → exporter 输出 pptx.
 *
 * 心智:
 *   JsonPresentation = "agent 说要啥"
 *   Presentation     = "库里真渲染的东西"
 *   fromJson         = 编译器
 *   toJson           = serializer used for agent inspection
 */

import type {
  Presentation, Slide, Shape, TextShape, PictureShape, ShapeRect,
  Paragraph, TextRun, TextRunStyle, Fill,
} from './types.js';
import { pxToEmu, ptToEmu } from './units.js';
import {
  DEFAULT_SLIDE_WIDTH_PX, DEFAULT_SLIDE_HEIGHT_PX,
  DEFAULT_BACKGROUND_COLOR, DEFAULT_TEXT_COLOR,
  DEFAULT_FONT_SIZE_BODY_PT,
  DEFAULT_MAJOR_FONT,
} from './defaults.js';

/* ============================================================
 * JSON Schema v1 类型
 * ============================================================ */

export interface JsonPresentation {
  schemaVersion: 1;
  slideSize?: { width: number; height: number }; /* px, 默认 1280x720 */
  theme?: JsonTheme;
  slides: JsonSlide[];
}

export interface JsonTheme {
  colors?: Partial<Record<string, string>>;
  majorFont?: string;
  minorFont?: string;
}

export interface JsonSlide {
  /** 用 template 时 agent 只传 slots, template.build() 负责扩成 shapes.
   * 用 shapes 时 agent 直接给形状列表, 完全手动. */
  template?: string;
  slots?: Record<string, any>;
  shapes?: JsonShape[];
  background?: JsonFill;
  notes?: string;
}

export type JsonShape = JsonTextShape | JsonImageShape | JsonRectShape;

interface JsonShapeBase {
  /** CSS px */
  position: { left: number; top: number; width: number; height: number };
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

export interface JsonTextShape extends JsonShapeBase {
  kind: 'text';
  text: string | JsonRichText;
  style?: JsonTextStyle;
  vAlign?: 'top' | 'ctr' | 'b';
  wrap?: 'square' | 'none';
  autoFit?: 'none' | 'shrinkText' | 'resizeShapeToFitText';
  fill?: JsonFill;
  border?: { color: string; width: number };
}

export interface JsonImageShape extends JsonShapeBase {
  kind: 'image';
  /** 4 种输入: blob / dataUrl / uri / prompt */
  source:
    | { blob: ArrayBuffer | Uint8Array; contentType: string }
    | { dataUrl: string }
    | { uri: string }
    | { prompt: string; contentType?: string }; /* prompt 未来接图像生成, phase 1 拒绝 */
  alt?: string;
  fit?: 'cover' | 'contain' | 'fill';
}

export interface JsonRectShape extends JsonShapeBase {
  kind: 'rect' | 'roundRect' | 'ellipse';
  cornerRadius?: number; /* px, roundRect 用 */
  fill?: JsonFill;
  border?: { color: string; width: number };
  text?: string | JsonRichText;
  textStyle?: JsonTextStyle;
  vAlign?: 'top' | 'ctr' | 'b';
}

/** 富文本 — 多段 (换行) + 段内多 run (bold/color 混排) */
export interface JsonRichText {
  paragraphs: Array<{
    align?: 'l' | 'ctr' | 'r' | 'just';
    runs: Array<{ text: string; style?: JsonTextStyle }>;
  }>;
}

export interface JsonTextStyle {
  fontFamily?: string;
  fontSize?: number; /* pt */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  letterSpacingPt?: number;
}

export type JsonFill =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; stops: Array<{ pos: number; color: string }>; angleDeg?: number }
  | { type: 'none' };


/* ============================================================
 * fromJson: JsonPresentation → Presentation
 * ============================================================ */

/**
 * 编译业务 JSON 到内部数据模型.
 * template 处理不在这一层 — schema 层只做单元/格式转换, template 展开在 templates/ 目录里,
 * 由 build() 函数在 fromJson 之前先把 template 展开成 shapes[].
 */
export function fromJson(json: JsonPresentation): Presentation {
  if (json.schemaVersion !== 1) {
    throw new Error(`不支持的 schemaVersion: ${json.schemaVersion}, 期望 1`);
  }
  const slideWidthPx = json.slideSize?.width ?? DEFAULT_SLIDE_WIDTH_PX;
  const slideHeightPx = json.slideSize?.height ?? DEFAULT_SLIDE_HEIGHT_PX;
  const slides: Slide[] = json.slides.map((jSlide, i) => compileSlide(jSlide, i + 1));
  return {
    slideWidth: pxToEmu(slideWidthPx),
    slideHeight: pxToEmu(slideHeightPx),
    slides,
    theme: json.theme ? {
      colors: (json.theme.colors as Record<string, string>) ?? {},
      majorFont: json.theme.majorFont,
      minorFont: json.theme.minorFont,
    } : undefined,
  };
}

function compileSlide(j: JsonSlide, index: number): Slide {
  return {
    index,
    id: `s${index}`,
    background: j.background ? compileFill(j.background) : undefined,
    shapes: (j.shapes ?? []).map(compileShape),
    notes: j.notes,
  };
}

function compileShape(j: JsonShape): Shape {
  if (j.kind === 'text') return compileTextShape(j);
  if (j.kind === 'image') return compileImageShape(j);
  return compileRectShape(j);
}

function compileTextShape(j: JsonTextShape): TextShape {
  return {
    kind: 'text',
    frame: {
      x: pxToEmu(j.position.left),
      y: pxToEmu(j.position.top),
      w: pxToEmu(j.position.width),
      h: pxToEmu(j.position.height),
    },
    rotation: j.rotation,
    flipH: j.flipH,
    flipV: j.flipV,
    paragraphs: compileParagraphs(j.text, j.style),
    vAlign: j.vAlign,
    wrap: j.wrap,
    autoFit: j.autoFit,
    fill: j.fill ? compileFill(j.fill) : undefined,
    border: j.border ? { color: j.border.color, widthEmu: pxToEmu(j.border.width) } : undefined,
  };
}

function compileImageShape(j: JsonImageShape): PictureShape {
  let src: string;
  const src0 = j.source as any;
  if (src0.blob) {
    src = blobToDataUrl(src0.blob, src0.contentType);
  } else if (src0.dataUrl) {
    src = src0.dataUrl;
  } else if (src0.uri) {
    src = src0.uri; /* 直接放 URL — 渲染层的 <img> 会拉 */
  } else if (src0.prompt) {
    throw new Error('image.source.prompt 需要接图像生成 tool, phase 1 暂不支持');
  } else {
    throw new Error('image.source 未识别: 需要 blob / dataUrl / uri 之一');
  }
  return {
    kind: 'picture',
    frame: {
      x: pxToEmu(j.position.left),
      y: pxToEmu(j.position.top),
      w: pxToEmu(j.position.width),
      h: pxToEmu(j.position.height),
    },
    rotation: j.rotation,
    flipH: j.flipH,
    flipV: j.flipV,
    src,
    alt: j.alt,
    objectFit: j.fit ?? 'cover',
  };
}

function compileRectShape(j: JsonRectShape): ShapeRect {
  return {
    kind: 'shape',
    geom: j.kind === 'roundRect' ? 'roundRect' : j.kind === 'ellipse' ? 'ellipse' : 'rect',
    frame: {
      x: pxToEmu(j.position.left),
      y: pxToEmu(j.position.top),
      w: pxToEmu(j.position.width),
      h: pxToEmu(j.position.height),
    },
    rotation: j.rotation,
    flipH: j.flipH,
    flipV: j.flipV,
    cornerRadius: j.cornerRadius ? pxToEmu(j.cornerRadius) : undefined,
    fill: j.fill ? compileFill(j.fill) : undefined,
    border: j.border ? { color: j.border.color, widthEmu: pxToEmu(j.border.width) } : undefined,
    paragraphs: j.text ? compileParagraphs(j.text, j.textStyle) : undefined,
    vAlign: j.vAlign,
  };
}

function compileParagraphs(text: string | JsonRichText, style?: JsonTextStyle): Paragraph[] {
  if (typeof text === 'string') {
    /* 简单文本: 按 \n 拆段, 每段一 run 用共享 style */
    const runStyle = compileTextStyle(style);
    return text.split('\n').map((line): Paragraph => ({
      runs: [{ text: line, style: runStyle }],
      defaultRun: runStyle,
    }));
  }
  /* 富文本: 完整段落 */
  return text.paragraphs.map((p): Paragraph => ({
    runs: p.runs.map((r): TextRun => ({
      text: r.text,
      style: compileTextStyle(r.style),
    })),
    align: p.align,
  }));
}

function compileTextStyle(j?: JsonTextStyle): TextRunStyle {
  if (!j) return {
    fontSizePt: DEFAULT_FONT_SIZE_BODY_PT,
    fontFamily: DEFAULT_MAJOR_FONT,
    color: DEFAULT_TEXT_COLOR,
  };
  return {
    fontFamily: j.fontFamily ?? DEFAULT_MAJOR_FONT,
    fontSizePt: j.fontSize ?? DEFAULT_FONT_SIZE_BODY_PT,
    bold: j.bold,
    italic: j.italic,
    underline: j.underline,
    color: j.color ?? DEFAULT_TEXT_COLOR,
    spacing: j.letterSpacingPt ? ptToEmu(j.letterSpacingPt) : undefined,
  };
}

function compileFill(j: JsonFill): Fill {
  if (j.type === 'solid') return { kind: 'solid', color: j.color };
  if (j.type === 'none') return { kind: 'none' };
  return {
    kind: 'grad',
    stops: j.stops,
    angleDeg: j.angleDeg,
  };
}

function blobToDataUrl(blob: ArrayBuffer | Uint8Array, contentType: string): string {
  /* isomorphic base64 编码: 优先用 Buffer (Node), fallback btoa (Browser) */
  const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : blob;
  let b64: string;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64');
  } else {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    b64 = btoa(s);
  }
  return `data:${contentType};base64,${b64}`;
}

/* 反向 toJson: Phase 2 加 (给 agent inspect 用) */
void DEFAULT_BACKGROUND_COLOR;
