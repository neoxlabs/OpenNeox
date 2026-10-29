/**
 * pptx-renderer/types — 结构化数据模型
 *
 * 解析 pptx 得到 Presentation 树, 渲染层就消费这个树. 中间不再回读 XML.
 *
 * 坐标系: EMU (English Metric Unit), 914400 EMU = 1 英寸. 我们统一保存 EMU 原值,
 * 到渲染层再按目标 slide 宽高比例缩放, 保证多分辨率一致.
 *
 * 颜色: 16 进制 "#RRGGBB". 主题色/schemeClr 在 parser 里已经解析成实色, 渲染层不再关心.
 *
 * 字体: fontFamily 可能是 "+mj-ea" 这种 theme 引用, 在 parser 里已经解析成真实字体名.
 */

/** Presentation 顶级容器 */
export interface Presentation {
  /** slide 显示尺寸, EMU */
  slideWidth: number;
  slideHeight: number;
  /** 有序 slide 列表 */
  slides: Slide[];
  /** theme (colorScheme + fontScheme), 已扁平化, shapes 引用了 schemeClr 就查这里 */
  theme?: Theme;
  masters?: SlideMaster[];
  layouts?: SlideLayout[];
}

/** SlideMaster — pptx 顶级模板. 通常一份 pptx 只有 1 个 master.
 * 决定 background / theme / body 默认段落样式. */
export interface SlideMaster {
  id: string;
  /** master 自己的默认背景 */
  background?: Fill;
  /** master 级默认段落样式 (title/body 各一份), Slide 若不 override 就用它 */
  titleStyle?: TextRunStyle;
  bodyStyle?: TextRunStyle;
}

/** SlideLayout — 从 master 继承, 加上占位符位置定义. Slide 引用一个 layout,
 * 没写自己 xfrm 的 shape 会从 layout 对应 placeholder 继承坐标. */
export interface SlideLayout {
  id: string;
  masterId?: string;
  /** layout 名称 (Codex: "Title Body" 等), 展示层可用 */
  name?: string;
  placeholders: Placeholder[];
  background?: Fill;
}

/** Placeholder — layout 里的位置槽, 由 (type, idx) 匹配 slide 里的 shape.
 * 匹配到时 slide shape 自己没 xfrm 就继承 placeholder.frame, 没 style 就继承 defaultStyle. */
export interface Placeholder {
  id: string;
  /** type 属性: 'title' | 'ctrTitle' | 'subTitle' | 'body' | 'pic' | ... */
  type: string;
  /** idx 数字, 同 type 多占位符时区分 (例如两栏各一个 body) */
  idx?: number;
  /** 默认坐标 (可选, 常见于 title/body 有固定位置) */
  frame?: Frame;
  /** 默认文字样式 */
  defaultStyle?: TextRunStyle;
  /** 默认垂直对齐 */
  vAlign?: 'top' | 'ctr' | 'b';
}

export interface Theme {
  /** 6 主色 + 2 中性 + 2 hyperlink = 12 slot. 用 key -> hex 存. */
  colors: Record<string, string>;
  /** major (标题) / minor (正文) 字体家族 */
  majorFont?: string;
  minorFont?: string;
}

/** 单张 slide */
export interface Slide {
  /** 索引 (1-based, 面向用户) */
  index: number;
  /** slideN.xml 内部 id (rId 关系用) */
  id: string;
  /** slide 尺寸沿用 Presentation, 但 layout master 可 override — 简化: 只信 Presentation. */
  background?: Fill;
  /** 顶级 shape 序列, 保持 XML 中的先后, 渲染时前面的在下层 */
  shapes: Shape[];
  layoutId?: string;
  /** speaker notes (可选) */
  notes?: string;
  templateId?: string;
  transition?: { kind: 'fade' | 'push' | 'wipe'; durationMs?: number };
}

/** 形状基类. */
export type Shape = TextShape | PictureShape | ShapeRect | TableShape;

export interface ShapeBase {
  kind: 'text' | 'picture' | 'shape' | 'table';
  /** builder / inspect 用的稳定 anchor id */
  id?: string;
  /** 定位框 EMU */
  frame: Frame;
  /** rotation degree (顺时针), 可选. python-pptx 生成的一般无. */
  rotation?: number;
  /** flip 水平 / 垂直, 可选 */
  flipH?: boolean;
  flipV?: boolean;
  /** 引用哪个 placeholder (type|idx). builder 侧用于关联 layout 继承. */
  placeholder?: { type: string; idx?: number };
  /** 形状层 z-index 在 XML 里靠顺序决定, 不显式存. */
}

export interface Frame {
  /** 左上角 x, EMU */
  x: number;
  y: number;
  /** 宽高 EMU */
  w: number;
  h: number;
}

/** 纯文本框. AI 生成 PPT 里"标题 / 副标题 / 正文段落"都走这个. */
export interface TextShape extends ShapeBase {
  kind: 'text';
  paragraphs: Paragraph[];
  /** 文本框自身填充 (背景色/背景图), 可选 */
  fill?: Fill;
  /** 边框, 可选. 简化: 只支持 solid color + width EMU */
  border?: { color: string; widthEmu: number };
  /** anchor: 文本在 shape 内的垂直对齐. 'top' / 'ctr' / 'b' */
  vAlign?: 'top' | 'ctr' | 'b';
  /** 内边距 EMU. 默认 91440 (0.1 inch) 各方向 */
  padding?: { l: number; t: number; r: number; b: number };
  /** 换行策略. 'square' = 正常字体换行 (默认); 'none' = 不换行(溢出). */
  wrap?: 'square' | 'none';
  /** 显式 autoFit 策略 (Codex 三档). 默认 'none' — 不隐式缩字号, 保证视觉一致性. */
  autoFit?: 'none' | 'shrinkText' | 'resizeShapeToFitText';
}

/** 段落. */
export interface Paragraph {
  /** 该段所有 text run (每个 run 有独立字体/颜色/字号) */
  runs: TextRun[];
  /** 段落对齐 */
  align?: 'l' | 'ctr' | 'r' | 'just';
  lineSpacingPt?: number;
  /** 段落级默认 rPr — 段内 run 没设时兜底 */
  defaultRun?: Partial<TextRunStyle>;
  /** 首行缩进 EMU */
  indent?: number;
  /** 段前/段后空白 EMU */
  spaceBeforeEmu?: number;
  spaceAfterEmu?: number;
  /** bullet 类型. none = 无项目符号, buChar/buAutoNum = 有. 简化: 只做 buChar (直接用字符) */
  bullet?: { kind: 'char'; char: string } | { kind: 'auto'; scheme: string } | { kind: 'none' };
  /** 层级 (缩进), 0-based */
  level?: number;
}

/** 一个 text run. */
export interface TextRun {
  text: string;
  style: TextRunStyle;
}

export interface TextRunStyle {
  /** 字号, 点 (pt). PPT 里 sz 是 hundredths of point, 我们解析时除 100. */
  fontSizePt?: number;
  /**
   * 字体家族名 (旧字段, 仍支持, 会同时 map 到 latin+east).
   * 新代码优先用 fontLatin / fontEast 分别指定, 中英分排更精细.
   */
  fontFamily?: string;
  fontLatin?: string;
  fontEast?: string;
  /** 是否粗体 */
  bold?: boolean;
  italic?: boolean;
  /** 下划线类型简化: true/false */
  underline?: boolean;
  strike?: boolean;
  /** 颜色 hex */
  color?: string;
  /** 字符间距 EMU */
  spacing?: number;
}

/** 图片形状. blipFill 引用 embed rId → 我们在 parser 里已经 resolve 成 dataUrl / blobUrl. */
export interface PictureShape extends ShapeBase {
  kind: 'picture';
  /** data URL 或 blob URL, 直接可以给 <img src> 用 */
  src: string;
  /** alt 文本, 可选 */
  alt?: string;
  srcRect?: { l: number; t: number; r: number; b: number };
  /** stretch 全填充 (默认) → 'fill'; blipFill 不带 stretch (罕见) → 'cover' 更自然 */
  objectFit?: 'cover' | 'fill' | 'contain';
  filter?: {
    grayscale?: boolean;
    duotone?: { dark: string; light: string };
    biLevel?: { threshold: number };
    lum?: { brightness?: number; contrast?: number };
  };
  /** picture 也支持 effectLst (跟 ShapeRect.effects 同结构) */
  effects?: {
    outerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    innerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    glow?: { blur?: number; color?: string; alpha?: number };
    softEdge?: { radius?: number };
  };
}

/** 通用 shape (矩形 / 圆 / 线 / 箭头 / 星等), 有 fill 有 border. */
export interface ShapeRect extends ShapeBase {
  kind: 'shape';
  geom: 'rect' | 'roundRect' | 'ellipse'
      | 'line' | 'straightConnector1'
      | 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow'
      | 'chevron' | 'homePlate' | 'star5' | 'star6' | 'pentagon' | 'hexagon' | 'triangle'
      | 'diagonalStripe' | 'plaque' | 'ribbon2'
      | 'custom'
      | 'other';
  customPath?: {
    /** SVG path 的 d 属性 */
    d: string;
    /** path 所在的用户坐标系尺寸 (viewBox 的 w/h) */
    viewBox: { width: number; height: number };
    /** 只描边不填充 (分隔线这种) */
    strokeOnly?: boolean;
  };
  /** 圆角半径 EMU (roundRect) */
  cornerRadius?: number;
  fill?: Fill;
  border?: { color: string; widthEmu: number };
  /** 内部可能有文本 (title in shape 场景), 用 paragraphs 承接 */
  paragraphs?: Paragraph[];
  /** anchor 文字垂直对齐 */
  vAlign?: 'top' | 'ctr' | 'b';
  effects?: {
    outerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    innerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    glow?: { blur?: number; color?: string; alpha?: number };
    softEdge?: { radius?: number };
  };
}

export interface TableShape extends ShapeBase {
  kind: 'table';
  /** 列宽 EMU · 长度 = 列数 */
  columnWidths: number[];
  /** 行 · 每行 cells 长度 = 列数 */
  rows: TableRow[];
  /** 头行样式 (第一行) · 深色底 + 白字, 默认开. */
  hasHeader?: boolean;
  /** 隔行斑马 · 默认开 */
  zebra?: boolean;
  /** 表格外框线颜色 · 默认 subtle. 内边线更淡 */
  borderColor?: string;
  /** 表头 / 斑马行底色 —— 让表格跟着 deck 的主题走, 不写死暖色 */
  headerFill?: string;
  zebraFill?: string;
  headerColor?: string;
  bodyColor?: string;
}

export interface TableRow {
  /** 行高 EMU (默认 40kEMU ≈ 42px) */
  heightEmu?: number;
  cells: TableCell[];
}

export interface TableCell {
  /** 单元格文本, 每段一个 Paragraph */
  paragraphs?: Paragraph[];
  /** 单元格 fill 覆盖 (斑马/header 之外的自定义) */
  fill?: Fill;
  /** 水平对齐 (默认 l, 数字类推荐 r) */
  align?: 'l' | 'ctr' | 'r';
  /** 垂直对齐 */
  vAlign?: 'top' | 'ctr' | 'b';
  /** 合并单元格 · 横跨几列 */
  colSpan?: number;
  /** 合并单元格 · 纵跨几行 */
  rowSpan?: number;
  /** 被别的格合并掉的延续格 (OOXML hMerge / vMerge), 渲染时跳过 */
  merged?: boolean;
}

/** 填充类型. solid = 纯色 (hex); pic = 图片; grad = 简化线性渐变 (可选); none = 透明. */
export type Fill =
  | { kind: 'solid'; color: string }
  | { kind: 'pic'; src: string; alt?: string }
  /* radial 给出中心点 (0~1 归一化). 给了它就是**径向**渐变, angleDeg 被忽略。
   * 球体感 / 光晕 / 柔光全靠它 —— 线性渐变做不出"从一点往外散"。 */
  | { kind: 'grad'; stops: Array<{ pos: number; color: string }>; angleDeg?: number;
      radial?: { cx: number; cy: number } }
  | { kind: 'none' };

/** 解析出来的 media 索引 — rId → dataUrl. Shape parser 查这个. */
export interface MediaMap {
  [rId: string]: string;
}
