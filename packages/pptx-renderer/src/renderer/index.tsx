/**
 * pptx-renderer/render — 数据模型 → React DOM
 *
 * 单张 slide 用绝对定位 div, 内部子元素按 EMU 换算 % 定位.
 * 缩略图: 复用同一渲染, 只是外容器宽度小 —— % 定位自动缩. 抗锯齿靠 CSS transform: scale.
 *
 * 只关心画一张 slide. 缩略图列表 / 大图预览 / 键盘 / zoom 都在上层 (PptxSurfaceViewer).
 */

import React, { useLayoutEffect } from 'react';
import { clipPathForGeometry } from './geometry-css.js';
import type {
  Presentation, Slide, Shape, TextShape, PictureShape, ShapeRect, TableShape,
  Paragraph, TextRun, Frame, Fill, Theme,
} from '../model/types.js';

/** EMU → px: 914400 EMU = 1 英寸 = 96 CSS px. */
const EMU_PER_PX = 914400 / 96;
export function emuToPx(emu: number): number { return emu / EMU_PER_PX; }

/**
 * 渲染单张 slide.
 *   containerWidth: 容器宽度 (px). 高度自动按 aspectRatio 计算.
 *   一切子形状按 slideWidth/Height 比例定位, 拉伸 / 缩小容器都一致.
 */
export const SlideView: React.FC<{
  slide: Slide;
  presentation: Presentation;
  containerWidth: number;
  className?: string;
  /** 是否作为缩略图渲染: 缩略图字体较大时会溢出, 强制截断 */
  thumbnail?: boolean;
}> = ({ slide, presentation, containerWidth, className, thumbnail }) => {
  const slideWidthEmu = presentation.slideWidth;
  const slideHeightEmu = presentation.slideHeight;
  const containerHeight = containerWidth * (slideHeightEmu / slideWidthEmu);
  /* pxPerEmu = containerWidth / slideWidthEmu */
  const scale = containerWidth / slideWidthEmu;

  const bgStyle: React.CSSProperties = {};
  if (slide.background) applyFillStyle(bgStyle, slide.background);
  else bgStyle.background = '#FFFFFF';

  return (
    <div
      className={`pptx-slide ${thumbnail ? 'is-thumbnail' : ''} ${className || ''}`}
      style={{
        position: 'relative',
        width: containerWidth,
        height: containerHeight,
        overflow: 'hidden',
        boxShadow: thumbnail ? '0 1px 3px rgba(0,0,0,.15)' : '0 4px 24px rgba(0,0,0,.12)',
        borderRadius: 4,
        ...bgStyle,
      }}
    >
      {slide.shapes.map((shape, i) => (
        <ShapeView
          key={i}
          shape={shape}
          scale={scale}
          thumbnail={!!thumbnail}
          theme={presentation.theme}
        />
      ))}
    </div>
  );
};

/** 内部单个 shape. */
const ShapeView: React.FC<{ shape: Shape; scale: number; thumbnail: boolean; theme?: Theme }> = ({ shape, scale, thumbnail, theme }) => {
  const style = frameToStyle(shape.frame, scale, shape.rotation, shape.flipH, shape.flipV);
  if (shape.kind === 'text') return <TextShapeView shape={shape} style={style} scale={scale} thumbnail={thumbnail} />;
  if (shape.kind === 'picture') return <PictureShapeView shape={shape} style={style} />;
  if (shape.kind === 'shape') return <RectShapeView shape={shape} style={style} scale={scale} thumbnail={thumbnail} />;
  if (shape.kind === 'table') return <TableShapeView shape={shape} style={style} scale={scale} thumbnail={thumbnail} theme={theme} />;
  return null;
};

/* ---------- Table ---------- */
/** hex 按比例混白 (0 = 原色, 1 = 纯白) —— 表格斑马行用主题色的浅色调 */
function tintHex(hex: string, toWhite: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * toWhite));
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 表格预览使用显式单元格底色，否则使用主题 accent1 的表头和两档斑马色。 */
const TableShapeView: React.FC<{ shape: TableShape; style: React.CSSProperties; scale: number; thumbnail: boolean; theme?: Theme }>
  = ({ shape, style, scale, thumbnail, theme }) => {
  const accent = theme?.colors?.accent1 || '#4472C4';
  const headerFill = shape.headerFill || accent;
  const bandA = shape.zebraFill || tintHex(accent, 0.72);
  const bandB = tintHex(accent, 0.86);
  const cols = shape.columnWidths.length
    ? shape.columnWidths
    : Array.from({ length: Math.max(1, ...shape.rows.map((r) => r.cells.length)) }, () => shape.frame.w / Math.max(1, shape.rows[0]?.cells.length ?? 1));
  const pad = 91440 * scale;
  return (
    <div style={{ ...style, height: 'auto', overflow: 'visible' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>{cols.map((w, i) => <col key={i} style={{ width: w * scale }} />)}</colgroup>
        <tbody>
          {shape.rows.map((row, ri) => {
            const isHeader = !!shape.hasHeader && ri === 0;
            const bodyIdx = ri - (shape.hasHeader ? 1 : 0);
            const rowFill = isHeader ? headerFill : shape.zebra ? (bodyIdx % 2 === 0 ? bandA : bandB) : undefined;
            return (
              <tr key={ri} style={{ height: row.heightEmu ? row.heightEmu * scale : undefined }}>
                {row.cells.map((cell, ci) => {
                  if (cell.merged) return null;
                  const tdStyle: React.CSSProperties = {
                    padding: `${pad / 2}px ${pad}px`,
                    border: `${Math.max(0.5, 12700 * scale)}px solid ${rowFill ? '#FFFFFF' : '#BFBFBF'}`,
                    verticalAlign: cell.vAlign === 'ctr' ? 'middle' : cell.vAlign === 'b' ? 'bottom' : 'top',
                    textAlign: cell.align === 'ctr' ? 'center' : cell.align === 'r' ? 'right' : 'left',
                    color: isHeader ? '#FFFFFF' : '#000000',
                    overflow: 'hidden',
                  };
                  if (cell.fill && cell.fill.kind !== 'none') applyFillStyle(tdStyle, cell.fill);
                  else if (rowFill) tdStyle.background = rowFill;
                  /* 表头默认加粗 (run 自己显式写了 b="0" 的除外) */
                  const paras = isHeader
                    ? (cell.paragraphs ?? []).map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, style: { bold: true, ...r.style, ...(r.style.bold === undefined ? { bold: true } : {}) } })) }))
                    : (cell.paragraphs ?? []);
                  return (
                    <td key={ci} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={tdStyle}>
                      {paras.map((p, pi) => <ParagraphView key={pi} para={p} scale={scale} thumbnail={thumbnail} />)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

function frameToStyle(frame: Frame, scale: number, rotation?: number, flipH?: boolean, flipV?: boolean): React.CSSProperties {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: frame.x * scale,
    top: frame.y * scale,
    width: frame.w * scale,
    height: frame.h * scale,
  };
  if (rotation || flipH || flipV) {
    const parts: string[] = [];
    if (rotation) parts.push(`rotate(${rotation}deg)`);
    if (flipH) parts.push('scaleX(-1)');
    if (flipV) parts.push('scaleY(-1)');
    style.transform = parts.join(' ');
    style.transformOrigin = 'center center';
  }
  return style;
}

/* ---------- Text shape ---------- */
const TextShapeView: React.FC<{ shape: TextShape; style: React.CSSProperties; scale: number; thumbnail: boolean }>
  = ({ shape, style, scale, thumbnail }) => {
  const pad = shape.padding || { l: 91440, t: 91440, r: 91440, b: 91440 };
  const shouldClip = shape.wrap === 'none' && shape.autoFit === 'none';
  /* 对明确的 shrinkText 文本框测量 DOM 高度，并按比例缩小字号以匹配
   * PowerPoint/WPS 的 normAutofit 语义。 */
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [fontScale, setFontScale] = React.useState(1);
  /* 只有模型明确声明 shrinkText 时才启用自适应，避免无意缩放大标题。 */
  const shouldShrink = shape.autoFit === 'shrinkText';
  /* 检测是否有大字号 · hero/manifesto 永不 shrink (即使 autoFit=shrinkText) */
  const hasLargeText = shape.paragraphs.some(p =>
    p.runs.some(r => (r.style?.fontSizePt ?? 0) >= 40)
  );
  useLayoutEffect(() => {
    if (!shouldShrink || hasLargeText || !containerRef.current || !contentRef.current) {
      if (fontScale !== 1) setFontScale(1);
      return;
    }
    const container = containerRef.current;
    const content = contentRef.current;
    const availH = container.clientHeight;
    const availW = container.clientWidth;
    content.style.fontSize = '';
    content.style.lineHeight = '';
    const naturalH = content.scrollHeight;
    const naturalW = content.scrollWidth;
    /* 【收紧阈值】只在超出 20%+ 才 shrink · 5% 容差常误触. scrollHeight 含 line-height 溢出.
     * 大部分场景 compose 引擎已经预留 25% 缓冲 · 这里只兜底极端情况. */
    if (naturalH <= availH * 1.20 && naturalW <= availW * 1.05) {
      if (fontScale !== 1) setFontScale(1);
      return;
    }
    const scaleH = availH / naturalH;
    const scaleW = availW / naturalW;
    const scale = Math.max(0.75, Math.min(scaleH, scaleW, 1));
    if (Math.abs(scale - fontScale) > 0.02) setFontScale(scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, scale]);

  const innerStyle: React.CSSProperties = {
    ...style,
    boxSizing: 'border-box',
    paddingLeft: pad.l * scale,
    paddingTop: pad.t * scale,
    paddingRight: pad.r * scale,
    paddingBottom: pad.b * scale,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: shape.vAlign === 'ctr' ? 'center' : shape.vAlign === 'b' ? 'flex-end' : 'flex-start',
    overflow: shouldClip ? 'hidden' : 'visible',
  };
  if (shape.fill) applyFillStyle(innerStyle, shape.fill);
  if (shape.border) {
    innerStyle.border = `${Math.max(1, shape.border.widthEmu * scale)}px solid ${shape.border.color}`;
  }
  const contentStyle: React.CSSProperties = fontScale < 1 ? {
    fontSize: `${fontScale * 100}%`,
    lineHeight: 1.4,
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  } : {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  };
  return (
    <div ref={containerRef} style={innerStyle}>
      <div ref={contentRef} style={contentStyle}>
        {shape.paragraphs.map((p, i) => (
          <ParagraphView key={i} para={p} scale={scale} thumbnail={thumbnail} />
        ))}
      </div>
    </div>
  );
};

/* ---------- Picture shape ---------- */
const PictureShapeView: React.FC<{ shape: PictureShape; style: React.CSSProperties }> = ({ shape, style }) => {
  return (
    <img
      src={shape.src}
      alt={shape.alt || ''}
      style={{
        ...style,
        objectFit: shape.objectFit || 'fill',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
      draggable={false}
    />
  );
};

/** 渐变 id 用路径内容做哈希 —— 同一张幻灯片里多个自定义形状的 <defs> id 不能撞 */
function hashPathId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 512))) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36) + s.length.toString(36);
}

/* ---------- Rect / roundRect / ellipse shape ---------- */
const RectShapeView: React.FC<{ shape: ShapeRect; style: React.CSSProperties; scale: number; thumbnail: boolean }>
  = ({ shape, style, scale, thumbnail }) => {
  /* 自定义几何使用内联 SVG，并按 preserveAspectRatio=none 拉伸到 shape frame；
   * non-scaling-stroke 保持描边宽度为屏幕像素。 */
  if (shape.geom === 'custom' && shape.customPath?.d) {
    const vb = shape.customPath.viewBox;
    const gid = `cg${hashPathId(shape.customPath.d)}`;
    let fill = 'none';
    let defs: React.ReactNode = null;
    if (!shape.customPath.strokeOnly && shape.fill) {
      if (shape.fill.kind === 'solid') {
        fill = shape.fill.color;
      } else if (shape.fill.kind === 'grad') {
        const rad = ((shape.fill.angleDeg ?? 90) * Math.PI) / 180;
        const dx = Math.cos(rad) / 2;
        const dy = Math.sin(rad) / 2;
        defs = (
          <defs>
            <linearGradient id={gid} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
              {shape.fill.stops.map((s, i) => <stop key={i} offset={`${s.pos}%`} stopColor={s.color} />)}
            </linearGradient>
          </defs>
        );
        fill = `url(#${gid})`;
      }
    }
    return (
      <div style={{ ...style, overflow: 'visible' }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${vb.width} ${vb.height}`}
          preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
          {defs}
          <path
            d={shape.customPath.d}
            fill={fill}
            stroke={shape.border ? shape.border.color : undefined}
            strokeWidth={shape.border ? Math.max(0.5, shape.border.widthEmu * scale) : undefined}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }

  const innerStyle: React.CSSProperties = {
    ...style,
    boxSizing: 'border-box',
    overflow: 'hidden',
  };
  if (shape.fill) applyFillStyle(innerStyle, shape.fill);
  if (shape.border) {
    innerStyle.border = `${Math.max(1, shape.border.widthEmu * scale)}px solid ${shape.border.color}`;
  }
  if (shape.geom === 'roundRect') {
    /* PPT 官方 roundRect 圆角默认约 shape 短边 20%; 我们简化按短边 6% 一律取, 视觉上比较自然. */
    const r = Math.min(shape.frame.w, shape.frame.h) * 0.06 * scale;
    innerStyle.borderRadius = r;
  } else if (shape.geom === 'ellipse') {
    innerStyle.borderRadius = '50%';
  } else {
    /* 预设装饰几何使用共享的 clip-path 多边形近似。 */
    const clip = clipPathForGeometry(shape.geom);
    if (clip) innerStyle.clipPath = clip;
  }

  const hasText = shape.paragraphs && shape.paragraphs.some(p => p.runs.some(r => (r.text || '').trim()));
  if (!hasText) return <div style={innerStyle} />;

  const contentStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    padding: `${91440 * scale}px`,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: shape.vAlign === 'ctr' ? 'center' : shape.vAlign === 'b' ? 'flex-end' : 'flex-start',
    boxSizing: 'border-box',
  };

  return (
    <div style={innerStyle}>
      <div style={contentStyle}>
        {shape.paragraphs!.map((p, i) => (
          <ParagraphView key={i} para={p} scale={scale} thumbnail={thumbnail} />
        ))}
      </div>
    </div>
  );
};

/* ---------- Paragraph ---------- */
const ParagraphView: React.FC<{ para: Paragraph; scale: number; thumbnail: boolean }> = ({ para, scale, thumbnail }) => {
  /* 【 确定性硬化】行高优先读模型 lineSpacingPt (<a:lnSpc><a:spcPts> 钉死值) —
   * 跟 exporter 写进 pptx 的值、compose measureText 算高度用的值是同一个数字,
   * 预览 = 导出 = 测量 三位一体. 老 pptx 没 lnSpc 时退 1.15 经验值. */
  const pinnedLineHeight = para.lineSpacingPt != null
    ? para.lineSpacingPt * EMU_PER_PT * scale /* pt → px (跟 fontSize 同一换算) */
    : undefined;
  const style: React.CSSProperties = {
    textAlign: para.align === 'ctr' ? 'center' : para.align === 'r' ? 'right' : para.align === 'just' ? 'justify' : 'left',
    marginTop: (para.spaceBeforeEmu ? para.spaceBeforeEmu * scale : 0),
    marginBottom: (para.spaceAfterEmu ? para.spaceAfterEmu * scale : 0),
    marginLeft: (para.level ? para.level * 400000 * scale : 0),
    lineHeight: pinnedLineHeight != null ? `${pinnedLineHeight}px` : (thumbnail ? 1.1 : 1.15),
  };
  if (para.runs.length === 0) return <div style={style}>&nbsp;</div>;
  return (
    <div style={style}>
      {para.bullet && para.bullet.kind === 'char' && (
        <span style={{ marginRight: 6 }}>{para.bullet.char}</span>
      )}
      {para.runs.map((r, i) => (
        <RunView key={i} run={r} scale={scale} />
      ))}
    </div>
  );
};

/* ---------- Text run ---------- */
/** 1 pt = 12700 EMU (914400 / 72). fontSize_px = pt * 12700 * scale, 其中 scale = containerWidth/slideWidthEmu. */
const EMU_PER_PT = 12700;

/** 中英兜底字体栈. python-pptx 生成的字体名很多是拉丁 (Calibri / +mn-lt), 直接用会让中文走浏览器默认字体
 * (Times New Roman 之类, 渲染丑). 我们在指定字体后强制追加 CJK 字体栈, 拉丁字符仍走首选. */
const CJK_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif';
function withCjkFallback(font?: string): string {
  if (!font || font === 'inherit') return CJK_STACK;
  /* 已经含 CJK 字体就不重叠加 */
  if (/PingFang|Hiragino|YaHei|Source Han|Noto Sans CJK|WenQuanYi|SimHei|SimSun|Songti|Kaiti|FangSong/.test(font)) return font;
  return `"${font}", ${CJK_STACK}`;
}

const RunView: React.FC<{ run: TextRun; scale: number }> = ({ run, scale }) => {
  const s = run.style;
  /* 兜底 18pt (PPT 常用默认字号). 缩略图容器小, 字自动等比小. */
  const fontSizePx = (s.fontSizePt || 18) * EMU_PER_PT * scale;
  /* 中英分排: fontLatin 在前 (拉丁字符命中), fontEast 兜 CJK — 镜像 OOXML <a:latin>/<a:ea> 语义.
   * 注意不走 withCjkFallback (它会给整串再包一层引号), 自己拼 + 追加 CJK 栈. */
  const familyChain = s.fontLatin || s.fontEast
    ? `${[s.fontLatin, s.fontEast].filter(Boolean).map((f) => `"${f}"`).join(', ')}, ${CJK_STACK}`
    : withCjkFallback(s.fontFamily);
  const style: React.CSSProperties = {
    fontFamily: familyChain,
    fontSize: fontSizePx,
    color: s.color || 'inherit',
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    textDecoration: [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    letterSpacing: s.spacing ? s.spacing * scale : undefined,
    whiteSpace: 'pre-wrap',
  };
  return <span style={style}>{run.text}</span>;
};

/* ---------- Fill helper ---------- */
function applyFillStyle(style: React.CSSProperties, fill: Fill): void {
  switch (fill.kind) {
    case 'solid':
      style.background = fill.color;
      break;
    case 'pic':
      style.backgroundImage = `url(${fill.src})`;
      style.backgroundSize = 'cover';
      style.backgroundPosition = 'center';
      break;
    case 'grad': {
      const angle = fill.angleDeg ?? 90;
      const stops = fill.stops.map(s => `${s.color} ${s.pos}%`).join(', ');
      style.background = `linear-gradient(${angle}deg, ${stops})`;
      break;
    }
    case 'none':
      /* leave undefined */
      break;
  }
}
