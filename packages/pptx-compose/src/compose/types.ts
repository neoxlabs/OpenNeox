/**
 * compose/types — 声明式 layout DSL 核心类型.
 *
 * 心智对齐 SwiftUI / Compose / React Native Flexbox. Agent 描述结构和意图,
 * 布局引擎负责测量 · 分配 · 定位. Overlap 在架构上不可能发生 · Content 自适应.
 */

import type { ImageAddOptions } from '@neoxlabs/pptx-renderer';

/** CSS px @ 96 DPI 幸运的是跟 Codex 一致 (1280×720 默认画布) */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 约束 · 传给 measure 函数 · 表示"你能占多大" */
export interface Constraints {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

/** 测量结果 · 每个 node 报告 · 表示"我想占多大" */
export interface Measured {
  width: number;
  height: number;
}

/** 每个 layout node 都会实现的接口 */
export interface LayoutNode {
  /** node 类别 · 用于渲染分发 */
  readonly kind: string;
  /** 布局参数 (padding, size, flex 等) · 可选 */
  layoutParams?: LayoutParams;
  /** children (容器 node 用) */
  children?: LayoutNode[];
}

/** 布局参数 · 每个 node 都可以设 */
export interface LayoutParams {
  /** 内边距 · 4 边 */
  padding?: number | Partial<Insets>;
  /** 外边距 (跟 padding 反向, 只在 stack 场景生效) */
  margin?: number | Partial<Insets>;
  /** 显式尺寸 (px) · 优先级最高 */
  width?: number;
  height?: number;
  /** 最小尺寸 (px) */
  minWidth?: number;
  minHeight?: number;
  /** 最大尺寸 (px) */
  maxWidth?: number;
  maxHeight?: number;
  /** flex 权重 · 在 stack 里瓜分剩余空间. 0=不 flex (按 preferred), >0=按权重瓜分 */
  flex?: number;
  gapFixed?: boolean;
  /**
   * 交叉轴对齐 —— 注意这是**"我怎么摆我的孩子"**, 不是"我自己怎么被摆"。
   * 想让某个子节点在父容器里单独换一种对齐, 用 alignSelf。
   */
  align?: 'start' | 'center' | 'end' | 'stretch';
  alignSelf?: 'start' | 'center' | 'end' | 'stretch';
  /** 背景色 (会作为 rect 绘制在 node 边界内) */
  background?: string;
  /** 圆角半径 (仅 background 生效) */
  cornerRadius?: number;
  /** 边框 · shape 边框 */
  border?: { color: string; width: number };
  /** shape 效果 · 阴影/发光 (透传到 pptx effectLst) */
  effects?: {
    outerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    innerShadow?: { blur?: number; distance?: number; angle?: number; color?: string; alpha?: number };
    glow?: { blur?: number; color?: string; alpha?: number };
    softEdge?: { radius?: number };
  };
  /** 满出血 · 用于 backdrop / hero 图片贴到 slide 边缘 */
  bleed?: boolean | Partial<{ top: boolean; right: boolean; bottom: boolean; left: boolean }>;
}

/* ============================================================
 * 容器 node
 * ============================================================ */

export interface StackParams extends LayoutParams {
  /** 主轴 gap · 元素之间间距 */
  gap?: number;
  /** 主轴对齐 (VStack: 垂直. HStack: 水平) */
  justify?: 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround' | 'spaceEvenly';
}

export interface VStackNode extends LayoutNode {
  kind: 'vstack';
  layoutParams?: StackParams;
  children: LayoutNode[];
}

export interface HStackNode extends LayoutNode {
  kind: 'hstack';
  layoutParams?: StackParams;
  children: LayoutNode[];
}

export interface ZStackNode extends LayoutNode {
  kind: 'zstack';
  layoutParams?: LayoutParams & { align?: 'start' | 'center' | 'end' };
  children: LayoutNode[];
}

export interface GridNode extends LayoutNode {
  kind: 'grid';
  layoutParams?: LayoutParams & {
    columns: number;
    rowGap?: number;
    colGap?: number;
  };
  children: LayoutNode[];
}

/** Spacer · flex=1 占位 · 常用于 stack 里"推开" */
export interface SpacerNode extends LayoutNode {
  kind: 'spacer';
  layoutParams?: LayoutParams & { minLength?: number };
}

/* ============================================================
 * 内容 node
 * ============================================================ */

export interface TextParams extends Omit<LayoutParams, 'align'> {
  /** 字号 pt */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  /** 字体角色 · 决定用 display / text / numeric 家族 */
  role?: 'display' | 'text' | 'numeric';
  /** 中英分排显式指定 · 优先 role */
  fontLatin?: string;
  fontEast?: string;
  /** 字距 pt */
  letterSpacingPt?: number;
  /** 显式行高 pt · 缺省由 resolveLineHeightPt 策略决定.
   * 这个值是"钉死值": measure 用它算高度, exporter 把它写进 <a:lnSpc><a:spcPts>,
   * 预览 line-height 也用它 — 三处一致, WPS/Office 打开必须遵守. */
  lineHeightPt?: number;
  /** 文本内部水平对齐 (跟 LayoutParams.align 不同 · 这个是段落内对齐) */
  textAlign?: 'l' | 'ctr' | 'r' | 'just';
  /** 垂直对齐 */
  vAlign?: 'top' | 'ctr' | 'b';
  /** 是否强制单行 (超出裁切 · 不换行) */
  singleLine?: boolean;
  /** 最大行数 · 超过截断 (ellipsis) */
  maxLines?: number;
  /** 大写化 (kicker 用) */
  uppercase?: boolean;
}

export interface TextNode extends LayoutNode {
  kind: 'text';
  text: string;
  layoutParams?: TextParams;
}

export interface ImageParams extends LayoutParams {
  fit?: 'cover' | 'contain' | 'fill';
  /** 图片滤镜 · 透传到 pptx blip filter */
  filter?: ImageAddOptions['filter'];
  /** 期望宽高比 · 用于 measure 阶段推断 */
  aspectRatio?: number;
}

export interface ImageNode extends LayoutNode {
  kind: 'image';
  source: NonNullable<ImageAddOptions['source']>
        | { blob: ArrayBuffer | Uint8Array; contentType: string }
        | { dataUrl: string }
        | { uri: string }
        | null; /* null → fallback (背景色 · 边框) */
  layoutParams?: ImageParams;
}

export interface ShapeParams extends LayoutParams {
  geometry?: 'rect' | 'roundRect' | 'ellipse'
           | 'line' | 'straightConnector1'
           | 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow'
           | 'chevron' | 'star5' | 'star6' | 'pentagon' | 'hexagon' | 'triangle'
           /* 任意矢量路径 —— 形态语言 (motif) 全靠它落到 pptx 上, 且仍是可编辑图形 */
           | 'custom';
  fill?: string;
  customPath?: { d: string; viewBox: { width: number; height: number }; strokeOnly?: boolean };
  /**
   * 渐变填充 (pos 0~1, angleDeg 90 = 上到下). fill 是平涂, 这个才有纵深。
   *
   * 给了 `radial` 就是**径向**渐变, 中心点 (cx,cy) 归一化到 0~1, angleDeg 被忽略。
   * 球体感 / 光晕 / 柔光只能靠它 —— 线性渐变做不出"从一点往外散"。
   * 停靠点顺序是 pos 0 = 中心 → pos 1 = 边缘 (和 CSS radial-gradient 一致)。
   */
  gradient?: {
    stops: Array<{ pos: number; color: string }>;
    angleDeg?: number;
    radial?: { cx: number; cy: number };
  };
  /** 水平/垂直镜像 —— 同一个 motif 形状可以左右/上下互为镜像, 不必再画一条路径 */
  flipH?: boolean;
  flipV?: boolean;
}

export interface ShapeNode extends LayoutNode {
  kind: 'shape';
  layoutParams?: ShapeParams;
}

/** Table node · 走 pptx 原生 <a:tbl> */
export interface TableParams extends LayoutParams {
  columnWidths?: number[]; /* 相对权重 · 自动归一 */
  columnAlign?: Array<'l' | 'ctr' | 'r'>;
  zebra?: boolean;
  borderColor?: string;
  headerFill?: string;
  zebraFill?: string;
}

export interface TableNode extends LayoutNode {
  kind: 'table';
  headers: string[];
  rows: string[][];
  layoutParams?: TableParams;
}

export type ComposeNode =
  | VStackNode | HStackNode | ZStackNode | GridNode | SpacerNode
  | TextNode | ImageNode | ShapeNode | TableNode;
