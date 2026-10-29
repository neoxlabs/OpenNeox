/**
 * builder — 生成侧命令式 API (Codex @oai/artifact-tool 心智).
 *
 * 用法 (isomorphic, Node + Browser 都能跑):
 *   import { Presentation } from '@neoxlabs/pptx-renderer';
 *
 *   const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
 *   const slide = ppt.slides.add();
 *   slide.background.fill = '#FAF7F1';
 *
 *   const title = slide.shapes.add({
 *     geometry: 'textbox',
 *     position: { left: 64, top: 50, width: 800, height: 60 },
 *   });
 *   title.text = '长白山 · 延吉 5 天游';
 *   title.textStyle = { fontFamily: 'PingFang SC', fontSize: 40, bold: true, color: '#1D2A2F' };
 *
 *   slide.images.add({
 *     blob: await fs.readFile('changbai.jpg'),
 *     contentType: 'image/jpeg',
 *     position: { left: 64, top: 150, width: 600, height: 400 },
 *     fit: 'cover',
 *   });
 *
 *   const file = await exportPptx(ppt);
 *   await file.save('长白山延吉5天攻略.pptx');
 */

import type {
  Presentation as PresentationModel, Slide as SlideModel,
  TextShape, PictureShape, ShapeRect, Paragraph, TextRunStyle, Fill,
  TableShape, TableRow, TableCell,
} from '../model/types.js';
import { pxToEmu, ptToEmu } from '../model/units.js';
import {
  DEFAULT_SLIDE_WIDTH_PX, DEFAULT_SLIDE_HEIGHT_PX,
  DEFAULT_FONT_SIZE_BODY_PT, DEFAULT_MAJOR_FONT, DEFAULT_TEXT_COLOR,
} from '../model/defaults.js';
import { slideId, shapeId, imageId } from '../model/ids.js';

/* ============================================================
 * Presentation
 * ============================================================ */

export interface PresentationOptions {
  slideSize?: { width: number; height: number }; /* CSS px */
}

/** Presentation — 顶级入口. `Presentation.create({...}).slides.add()...` */
export class Presentation {
  /** 内部数据模型引用 (exporter / renderer 通过 model 属性拿) */
  model: PresentationModel;
  slides: SlidesCollection;

  private constructor(model: PresentationModel) {
    this.model = model;
    this.slides = new SlidesCollection(this);
  }

  /** 创建新 Presentation. */
  static create(opts?: PresentationOptions): Presentation {
    const widthPx = opts?.slideSize?.width ?? DEFAULT_SLIDE_WIDTH_PX;
    const heightPx = opts?.slideSize?.height ?? DEFAULT_SLIDE_HEIGHT_PX;
    const model: PresentationModel = {
      slideWidth: pxToEmu(widthPx),
      slideHeight: pxToEmu(heightPx),
      slides: [],
    };
    return new Presentation(model);
  }

  /** 直接从内部数据模型包 (parser 输出 / 反序列化恢复用). */
  static fromModel(model: PresentationModel): Presentation {
    const p = new Presentation(model);
    /* 把已有 slides 也 wrap 出可编辑对象 */
    p.slides.rehydrate();
    return p;
  }

  /** 主题快捷设置. */
  setTheme(theme: { colors?: Record<string, string>; majorFont?: string; minorFont?: string }): this {
    this.model.theme = {
      colors: theme.colors ?? this.model.theme?.colors ?? {},
      majorFont: theme.majorFont ?? this.model.theme?.majorFont,
      minorFont: theme.minorFont ?? this.model.theme?.minorFont,
    };
    return this;
  }
}

/* ============================================================
 * Slides collection
 * ============================================================ */

export class SlidesCollection {
  private _slides: Slide[] = [];

  constructor(private _presentation: Presentation) {}

  /** 加一张空 slide, 返回可继续操作的 Slide 对象. */
  add(): Slide {
    const model: SlideModel = {
      index: this._slides.length + 1,
      id: slideId(),
      shapes: [],
    };
    this._presentation.model.slides.push(model);
    const slide = new Slide(this._presentation, model);
    this._slides.push(slide);
    return slide;
  }

  /**
   * 扔掉最后一张 slide.
   *
   * 逐页生成时, 模板画到一半抛异常, slide 已经 push 进 model 了 —— 不撤掉的话
   * 导出的 pptx 里会夹一张半成品 (背景色刷了、文字没上)。比"少一页"难看得多,
   * 因为用户看不出它是失败页, 只会觉得我们随机生成空白页。
   */
  removeLast(): void {
    if (this._slides.length === 0) return;
    this._slides.pop();
    this._presentation.model.slides.pop();
  }

  get length(): number { return this._slides.length; }
  at(i: number): Slide | undefined { return this._slides[i]; }
  all(): Slide[] { return [...this._slides]; }

  /** parser 出来的 model 挂进来时用 — 给每个已有 slide 包一层 Slide. */
  rehydrate(): void {
    this._slides = this._presentation.model.slides.map(m => new Slide(this._presentation, m));
  }
}

/* ============================================================
 * Slide
 * ============================================================ */

export class Slide {
  shapes: ShapesCollection;
  images: ImagesCollection;
  tables: TablesCollection;
  background: BackgroundHandle;

  constructor(public _pres: Presentation, public _model: SlideModel) {
    this.shapes = new ShapesCollection(this);
    this.images = new ImagesCollection(this);
    this.tables = new TablesCollection(this);
    this.background = new BackgroundHandle(this);
  }

  get notes(): string | undefined { return this._model.notes; }
  set notes(v: string | undefined) { this._model.notes = v; }

  /** 这一页用了哪个页型 —— 写进 <p:cSld name>, 供 inspect 直接读 (见 SlideModel.templateId) */
  get templateId(): string | undefined { return this._model.templateId; }
  set templateId(v: string | undefined) { this._model.templateId = v; }
}

class BackgroundHandle {
  constructor(private slide: Slide) {}

  /** 设纯色背景. `slide.background.fill = '#FAF7F1'`. */
  set fill(color: string) {
    this.slide._model.background = { kind: 'solid', color };
  }

  get fill(): string | undefined {
    const bg = this.slide._model.background;
    return bg?.kind === 'solid' ? bg.color : undefined;
  }

  setGradient(stops: Array<{ pos: number; color: string }>, angleDeg = 90): void {
    this.slide._model.background = { kind: 'grad', stops, angleDeg };
  }

  clear(): void { this.slide._model.background = undefined; }
}

/* ============================================================
 * Shapes collection — text / rect / roundRect / ellipse / line
 * ============================================================ */

export interface ShapeAddOptions {
  geometry: 'textbox'
          | 'rect' | 'roundRect' | 'ellipse'
          | 'line' | 'straightConnector1'
          | 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow'
          | 'chevron' | 'star5' | 'star6'
          | 'pentagon' | 'hexagon' | 'triangle'
          | 'diagonalStripe' | 'plaque' | 'ribbon2'
          | 'custom';
  /**
   * geometry='custom' 时的 SVG path —— 导出时转成 OOXML custGeom (真·可编辑图形)。
   * 预设形状就那 180 多个, 想要 WPS 稻壳那种版式必须走这条。
   */
  customPath?: { d: string; viewBox: { width: number; height: number }; strokeOnly?: boolean };
  position: { left: number; top: number; width: number; height: number }; /* px */
  fill?: string; /* hex 或 rgba(r,g,b,a) —— rgba 会导出成带 <a:alpha> 的 solidFill */
  /**
   * 渐变填充。导出层的 gradFill 早就支持, 缺的一直是 builder 这一格 ——
   * 于是所有形状只能用平涂, 整份 deck 看着"平"。
   * stops 的 pos 是 0~1, angleDeg 90 = 从上到下。
   */
  fillGradient?: { stops: Array<{ pos: number; color: string }>; angleDeg?: number; radial?: { cx: number; cy: number } };
  border?: { color: string; width: number }; /* width in px */
  cornerRadius?: number; /* px, roundRect */
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  effects?: {
    outerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    innerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    glow?: { blur?: number; color?: string; alpha?: number };
    softEdge?: { radius?: number };
  };
}

export class ShapesCollection {
  constructor(private slide: Slide) {}

  add(opts: ShapeAddOptions): ShapeHandle {
    const frame = {
      x: pxToEmu(opts.position.left),
      y: pxToEmu(opts.position.top),
      w: pxToEmu(opts.position.width),
      h: pxToEmu(opts.position.height),
    };
    const id = shapeId();
    let shape: TextShape | ShapeRect;
    if (opts.geometry === 'textbox') {
      shape = {
        kind: 'text',
        id,
        frame,
        paragraphs: [],
        rotation: opts.rotation,
      };
    } else {
      /* geometry → model geom · 传透明射, unknown 走 rect */
      const GEOM_MAP: Record<string, ShapeRect['geom']> = {
        rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse',
        line: 'line', straightConnector1: 'straightConnector1',
        rightArrow: 'rightArrow', leftArrow: 'leftArrow',
        upArrow: 'upArrow', downArrow: 'downArrow',
        chevron: 'chevron', star5: 'star5', star6: 'star6',
        pentagon: 'pentagon', hexagon: 'hexagon', triangle: 'triangle',
        diagonalStripe: 'diagonalStripe', plaque: 'plaque', ribbon2: 'ribbon2',
        custom: 'custom',
      };
      let geom: ShapeRect['geom'] = GEOM_MAP[opts.geometry] ?? 'rect';
      if (geom === 'rect' && opts.cornerRadius && opts.cornerRadius > 0) geom = 'roundRect';
      shape = {
        kind: 'shape',
        id,
        frame,
        geom,
        fill: opts.fillGradient
          ? { kind: 'grad', stops: opts.fillGradient.stops, angleDeg: opts.fillGradient.angleDeg ?? 90, radial: opts.fillGradient.radial }
          : opts.fill ? { kind: 'solid', color: opts.fill } : undefined,
        border: opts.border ? { color: opts.border.color, widthEmu: pxToEmu(opts.border.width) } : undefined,
        cornerRadius: opts.cornerRadius ? pxToEmu(opts.cornerRadius) : undefined,
        rotation: opts.rotation,
        flipH: opts.flipH,
        flipV: opts.flipV,
        effects: opts.effects,
        customPath: opts.geometry === 'custom' ? opts.customPath : undefined,
      };
    }
    this.slide._model.shapes.push(shape);
    return new ShapeHandle(shape);
  }

  /** 短语快捷: shapes.addText(text, position, style?) */
  addText(text: string, position: ShapeAddOptions['position'], style?: TextStyleInput): ShapeHandle {
    const h = this.add({ geometry: 'textbox', position });
    h.text = text;
    if (style) h.textStyle = style;
    return h;
  }

  /** 短语快捷: shapes.addLine(from, to, style?) — 直线, 简化用 rotated 极窄 rect 表达. */
  addLine(from: { x: number; y: number }, to: { x: number; y: number }, style?: { color?: string; width?: number }): ShapeHandle {
    const width = style?.width ?? 2;
    const color = style?.color ?? '#000000';
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    return this.add({
      geometry: 'rect',
      position: {
        left: from.x + (dx - length) / 2,
        top: from.y + (dy - width) / 2,
        width: length,
        height: width,
      },
      fill: color,
      rotation: angle,
    });
  }

  /** 短语快捷: shapes.addRect + shapes.addRoundRect + shapes.addEllipse */
  addRect(position: ShapeAddOptions['position'], fill: string): ShapeHandle {
    return this.add({ geometry: 'rect', position, fill });
  }
  addRoundRect(position: ShapeAddOptions['position'], fill: string, cornerRadius = 12): ShapeHandle {
    return this.add({ geometry: 'roundRect', position, fill, cornerRadius });
  }
  addEllipse(position: ShapeAddOptions['position'], fill: string): ShapeHandle {
    return this.add({ geometry: 'ellipse', position, fill });
  }
}

/** shape 引用 — 可以继续设 .text / .textStyle / .fill. */
export class ShapeHandle {
  constructor(public _shape: TextShape | ShapeRect) {}

  /** 单行 / 多行文本设置. 换行走 \n. */
  set text(value: string) {
    if (this._shape.kind === 'text') {
      this._shape.paragraphs = stringToParagraphs(value);
    } else {
      this._shape.paragraphs = stringToParagraphs(value);
    }
  }

  /** 富文本 / 多样式段落. */
  setParagraphs(paragraphs: Paragraph[]): this {
    if (this._shape.kind === 'text') this._shape.paragraphs = paragraphs;
    else this._shape.paragraphs = paragraphs;
    return this;
  }

  set textStyle(style: TextStyleInput) {
    const s = compileStyle(style);
    /* 应用到所有 run — 单文本 shape 常见场景 */
    const paras = this._shape.kind === 'text' ? this._shape.paragraphs : this._shape.paragraphs;
    if (paras) {
      for (const p of paras) {
        p.defaultRun = { ...(p.defaultRun ?? {}), ...s };
        for (const r of p.runs) r.style = { ...r.style, ...s };
        if (style.lineSpacingPt != null) p.lineSpacingPt = style.lineSpacingPt;
      }
    }
  }

  set vAlign(v: 'top' | 'ctr' | 'b') {
    (this._shape as any).vAlign = v;
  }

  set autoFit(v: 'none' | 'shrinkText' | 'resizeShapeToFitText') {
    if (this._shape.kind === 'text') this._shape.autoFit = v;
  }
}

export interface TextStyleInput {
  fontFamily?: string;
  fontLatin?: string;
  fontEast?: string;
  fontSize?: number; /* pt */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  letterSpacingPt?: number;
  lineSpacingPt?: number;
}

function compileStyle(s: TextStyleInput): TextRunStyle {
  return {
    fontFamily: s.fontFamily,
    fontLatin: s.fontLatin,
    fontEast: s.fontEast,
    fontSizePt: s.fontSize,
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    color: s.color,
    spacing: s.letterSpacingPt ? ptToEmu(s.letterSpacingPt) : undefined,
  };
}

function stringToParagraphs(str: string): Paragraph[] {
  const defRun: TextRunStyle = {
    fontFamily: DEFAULT_MAJOR_FONT,
    fontSizePt: DEFAULT_FONT_SIZE_BODY_PT,
    color: DEFAULT_TEXT_COLOR,
  };
  return str.split('\n').map((line): Paragraph => ({
    runs: [{ text: line, style: defRun }],
    defaultRun: defRun,
  }));
}

/* ============================================================
 * Images collection — 4 类输入
 * ============================================================ */

export type ImageSource =
  | { blob: ArrayBuffer | Uint8Array; contentType: string }
  | { dataUrl: string }
  | { uri: string };

export interface ImageAddOptions {
  source?: ImageSource;
  blob?: ArrayBuffer | Uint8Array;
  contentType?: string;
  /** 或者传 dataUrl */
  dataUrl?: string;
  /** 或者传 URI */
  uri?: string;
  position: { left: number; top: number; width: number; height: number };
  fit?: 'cover' | 'contain' | 'fill';
  /** 裁剪比例 (0~1)。调用方 (compose) 知道图片真实尺寸和目标框, 由它算好传进来 */
  srcRect?: { l: number; t: number; r: number; b: number };
  alt?: string;
  rotation?: number;
  filter?: {
    grayscale?: boolean;
    duotone?: { dark: string; light: string };
    biLevel?: { threshold: number };
    lum?: { brightness?: number; contrast?: number };
  };
  /** 图片 shadow/glow/softEdge · 跟 shape effects 同结构 */
  effects?: {
    outerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    innerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    glow?: { blur?: number; color?: string; alpha?: number };
    softEdge?: { radius?: number };
  };
}

export class ImagesCollection {
  constructor(private slide: Slide) {}

  add(opts: ImageAddOptions): ImageHandle {
    let src: string;
    const rawSource = opts.source ?? opts;
    src = normalizeImageInput(rawSource as any, opts.contentType);
    if (!src) {
      throw new Error(
        'image source 未识别. 支持格式:\n' +
        '  { blob: ArrayBuffer, contentType: "image/jpeg" }\n' +
        '  { dataUrl: "data:image/png;base64,..." }\n' +
        '  { uri: "https://..." } (或字段名 url / imageUrl / src / href / path)\n' +
        '  直接传 string (会当 uri 或 dataUrl 自动识别)\n' +
        '实际收到: ' + JSON.stringify(rawSource).slice(0, 200),
      );
    }

    const pic: PictureShape = {
      kind: 'picture',
      id: imageId(),
      frame: {
        x: pxToEmu(opts.position.left),
        y: pxToEmu(opts.position.top),
        w: pxToEmu(opts.position.width),
        h: pxToEmu(opts.position.height),
      },
      src,
      alt: opts.alt,
      objectFit: opts.fit ?? 'cover',
      srcRect: opts.srcRect,
      rotation: opts.rotation,
      filter: opts.filter,
      effects: opts.effects,
    };
    this.slide._model.shapes.push(pic);
    return new ImageHandle(pic);
  }
}

export class ImageHandle {
  constructor(public _shape: PictureShape) {}
  set alt(v: string) { this._shape.alt = v; }
}

function blobToDataUrl(blob: ArrayBuffer | Uint8Array, contentType: string): string {
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

/** 宽容地识别 agent 给的图片 input, 支持: blob / dataUrl / uri / url / imageUrl / src / href / path / 裸 string. */
function normalizeImageInput(input: any, fallbackContentType?: string): string {
  if (!input) return '';
  /* 裸字符串: data: 走 dataUrl, http 走 uri, 其它可能是 file path — 也走 uri (renderer 会用 <img> 加载, 主进程侧 exporter 会跳过) */
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return '';

  /* blob / bytes 类: blob / buffer / bytes / arrayBuffer */
  const blobLike = input.blob ?? input.buffer ?? input.bytes ?? input.arrayBuffer ?? input.data;
  if (blobLike && (blobLike instanceof ArrayBuffer || ArrayBuffer.isView(blobLike) || (typeof blobLike === 'object' && 'byteLength' in blobLike))) {
    const ct = input.contentType ?? input.mimeType ?? input.mime ?? input.type ?? fallbackContentType ?? 'image/png';
    return blobToDataUrl(blobLike as ArrayBuffer | Uint8Array, ct);
  }

  /* dataUrl 各种别名 */
  const dataUrl = input.dataUrl ?? input.dataURL ?? input.data_url;
  if (typeof dataUrl === 'string') return dataUrl;

  /* uri / url / src / href / path 家族 */
  const uri = input.uri ?? input.url ?? input.imageUrl ?? input.image_url ?? input.src ?? input.href ?? input.path;
  if (typeof uri === 'string') return uri;

  return '';
}

/* 未使用的 Fill 引用 — 保留类型链完整 */
void ({} as Fill);


export interface TableAddOptions {
  /** 位置 · px (相对 slide 左上) */
  position: { left: number; top: number; width: number; height: number };
  /** 列宽 · px 数组. 会自动归一化到 position.width. 缺省等宽. */
  columnWidths?: number[];
  /** 表头 · 第一行. 长度 = 列数. header 行有深底白字. 不给就没 header 行. */
  headers?: string[];
  /** 内容行 · [row][col]. cell 可以是纯文本或结构化 TableCell. */
  rows: Array<Array<string | TableCell>>;
  /** 隔行斑马 · 默认开 */
  zebra?: boolean;
  /** 表头底色 / 斑马行底色 —— 不传则用默认暖色, 传了就跟主题走 */
  headerFill?: string;
  zebraFill?: string;
  /** 高亮一行数据 (0 起, 不算表头) —— 比如"我们自己那一行"。底色用 highlightFill,
   * 写成该行每格的显式 cell.fill, 导出和预览本来就按 cell.fill 优先, 两边不用另写规则。
   * 不加粗: compose 按常规字重测行高, 粗体 Latin 变宽会折行把表格撑出框。 */
  highlightRow?: number;
  highlightFill?: string;
  /** 表格外边线颜色 · 默认 subtle 淡色 */
  borderColor?: string;
  /** 每列对齐 (数字列建议 'r' 右对齐). 长度 = 列数 */
  columnAlign?: Array<'l' | 'ctr' | 'r'>;
  /** 表头字色 / 正文固定字色. 不给时保持老行为 (白字 / 默认墨色) —— 深色主题必须传 */
  headerColor?: string;
  bodyColor?: string;
  rowHeights?: number[];
}

export class TablesCollection {
  constructor(private slide: Slide) {}

  add(opts: TableAddOptions): void {
    const { position, headers, rows: dataRows } = opts;

    /* 决定列数. 优先看 headers, 其次 rows[0], 兜底 columnWidths */
    const colCount = headers?.length
      ?? dataRows[0]?.length
      ?? opts.columnWidths?.length
      ?? 1;

    /* 列宽 · 归一化到 position.width */
    let widthsPx: number[];
    if (opts.columnWidths && opts.columnWidths.length === colCount) {
      const sum = opts.columnWidths.reduce((a, b) => a + b, 0);
      widthsPx = opts.columnWidths.map((w) => (w / sum) * position.width);
    } else {
      widthsPx = Array(colCount).fill(position.width / colCount);
    }

    const columnWidths = widthsPx.map((px) => pxToEmu(px));
    const align = opts.columnAlign ?? Array(colCount).fill('l');

    const rows: TableRow[] = [];

    if (headers && headers.length) {
      rows.push({
        heightEmu: pxToEmu(opts.rowHeights?.[0] ?? 44),
        cells: headers.map((h, i) => ({
          paragraphs: [{
            runs: [{
              text: h,
              style: {
                fontSizePt: 15,
                bold: true,
                color: opts.headerColor ?? '#FFFFFF',
              },
            }],
            lineSpacingPt: 21, /* 15pt × 1.4 */
          }],
          align: align[i] ?? 'l',
          vAlign: 'ctr',
        })),
      });
    }

    /* 数据行 */
    const bodyOffset = headers && headers.length ? 1 : 0;
    const hlFill = opts.highlightFill;
    for (const [ri, row] of dataRows.entries()) {
      const hl = hlFill && opts.highlightRow === ri;
      rows.push({
        heightEmu: pxToEmu(opts.rowHeights?.[bodyOffset + ri] ?? 40),
        cells: row.map((cell, i) => {
          if (typeof cell === 'string') {
            return {
              ...(hl ? { fill: { kind: 'solid' as const, color: hlFill } } : {}),
              paragraphs: [{
                runs: [{
                  text: cell,
                  style: { fontSizePt: 14, color: opts.bodyColor ?? '#1D2A2F' },
                }],
                lineSpacingPt: 19.5, /* 14pt × 1.4 → 圆整 0.25pt */
              }],
              align: align[i] ?? 'l',
              vAlign: 'ctr',
            };
          }
          return cell;
        }),
      });
    }

    const naturalEmu = rows.reduce((s, r) => s + (r.heightEmu ?? 400000), 0);
    const targetEmu = pxToEmu(position.height);
    if (naturalEmu > 0 && targetEmu > naturalEmu) {
      const factor = Math.min(targetEmu / naturalEmu, 2.2);
      for (const r of rows) r.heightEmu = Math.round((r.heightEmu ?? 400000) * factor);
    }

    const shape: TableShape = {
      kind: 'table',
      id: shapeId(),
      frame: {
        x: pxToEmu(position.left),
        y: pxToEmu(position.top),
        w: pxToEmu(position.width),
        h: pxToEmu(position.height),
      },
      columnWidths,
      rows,
      hasHeader: !!(headers && headers.length),
      zebra: opts.zebra !== false,
      headerFill: opts.headerFill,
      zebraFill: opts.zebraFill,
      headerColor: opts.headerColor,
      bodyColor: opts.bodyColor,
      borderColor: opts.borderColor,
    };

    this.slide._model.shapes.push(shape);
  }
}
