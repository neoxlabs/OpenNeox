/**
 * bridge/render — 主入口. 一句话把 ComposeNode 树画到 slide.
 *
 * 用法:
 *   import { Presentation, exportPptx } from '@neoxlabs/pptx-renderer/node';
 *   import { render, VStack, Text } from '@neoxlabs/pptx-compose/node';
 *
 *   const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
 *   const slide = ppt.slides.add();
 *   slide.background.fill = '#FAF7F1';
 *
 *   render(slide, {
 *     bounds: { x: 72, y: 56, width: 1136, height: 616 },  // 内容区
 *   }, VStack({ gap: 24 }, [
 *     Text('DAY 01', { fontSize: 14, uppercase: true, color: '#C05621' }),
 *     Text('外滩不止一面', { fontSize: 36, bold: true }),
 *   ]));
 *
 *   await (await exportPptx(ppt)).save('out.pptx');
 */

import type { Slide } from '@neoxlabs/pptx-renderer';
import type { ComposeNode, Frame, TextNode } from '../compose/types.js';
import { measure } from '../layout/measure.js';
import { layout, type LayoutBox } from '../layout/layout.js';
import { assertNoOverlap, type OverlapReport } from '../layout/assert-no-overlap.js';
import { assertWithinCanvas, type OverflowItem } from '../layout/assert-within-canvas.js';
import { fitToBounds, type FitReport } from '../layout/fit.js';
import { paint } from './paint.js';
import { applyStyleTransition } from '../templates/theme.js';

export interface RenderOptions {
  /** 内容区边界 (px). 缺省 = 全 slide (1280x720). */
  bounds?: Frame;
  /** 是否运行 overlap 断言 · 默认 true. 生产环境可以关. */
  assertNoOverlap?: boolean;
  /** 关掉"内容画到版面外"的检查. 默认开 —— 背景层这类刻意出血的用 bleed 声明, 别关它 */
  assertWithinCanvas?: boolean;
  /** 检测到 overlap 时的行为: 'throw' | 'warn' | 'ignore'. 默认 'warn'. */
  overlapMode?: 'throw' | 'warn' | 'ignore';
  /** callback 拿到 overlap 报告 · 用于 inspect 集成 */
  onOverlapReport?: (report: OverlapReport) => void;
  /**
   * 关掉版面求解 (fit), 退回"声明多少排多少"。
   * 只有确实需要内容按原始密度落位的场景才关 —— 关掉之后, 内容少的页下半会空着,
   * 内容多的页会压出版心。默认开。
   */
  fit?: false;
}

/* 本次渲染的求解报告 —— 模板函数签名是 (slide, slots) => void, 没地方回传,
 * 所以跟 activeTheme 同款走一个作用域收集器: withLayoutReport(() => tpl(...))。 */
let collector: SlideLayoutReport[] | null = null;

export interface SlideLayoutReport extends FitReport {
  overlaps: number;
}

/** 收集这段渲染里每次 render() 的求解报告 (一页可能 render 多次) */
export async function withLayoutReport<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; reports: SlideLayoutReport[] }> {
  const prev = collector;
  const mine: SlideLayoutReport[] = [];
  collector = mine;
  try {
    return { result: await fn(), reports: mine };
  } finally {
    collector = prev;
  }
}

/** 主入口: 声明式树 → 求解 → 布局 → 绘 pptx shapes */
export function render(slide: Slide, tree: ComposeNode, opts?: RenderOptions): void {
  const bounds = opts?.bounds ?? { x: 0, y: 0, width: 1280, height: 720 };

  const fitted = opts?.fit === false
    ? null
    : fitToBounds(tree, bounds);

  const measured = fitted
    ? fitted.measured
    : measureFallback(tree, bounds);
  const rootFrame: Frame = fitted
    ? fitted.rootFrame
    : {
        x: bounds.x,
        y: bounds.y,
        width: measured.size.width < bounds.width && (tree.layoutParams as any)?.width == null
          ? bounds.width
          : measured.size.width,
        height: measured.size.height < bounds.height && (tree.layoutParams as any)?.height == null
          ? bounds.height
          : measured.size.height,
      };
  const laid = layout(measured, rootFrame);

  /* 排版跑偏时唯一靠得住的手段: 把 frame 打出来。靠读代码推 flex 分配推错过两次
   * (以为补了 height 就会撑开, 实际没有), 留个开关比每次临时改代码强。
   *   NEOX_DEBUG_LAYOUT=1 node your-probe.mjs */
  if (process.env.NEOX_DEBUG_LAYOUT) dumpLayout(laid, 0);

  if (opts?.assertNoOverlap !== false) {
    const report = assertNoOverlap(laid);
    if (opts?.onOverlapReport) opts.onOverlapReport(report);
    if (collector && fitted) {
      collector.push({ ...fitted.report, overlaps: report.overlaps.length });
    }
    if (report.hasOverlap) {
      const mode = opts?.overlapMode ?? 'warn';
      const summary = report.overlaps.slice(0, 5).map((o) =>
        `  · ${o.a.kind}[${o.a.frame.x.toFixed(0)},${o.a.frame.y.toFixed(0)}] × ${o.b.kind}[${o.b.frame.x.toFixed(0)},${o.b.frame.y.toFixed(0)}] IoU=${(o.iou * 100).toFixed(1)}%`
      ).join('\n');
      const msg = `[compose] ${report.overlaps.length} unintended overlap(s) detected:\n${summary}`;
      if (mode === 'throw') throw new Error(msg);
      if (mode === 'warn') console.warn(msg);
    }
  }

  /* 3b. 版面溢出断言 —— overlap 断言只管"叠", 溢出它一个都抓不到。
   * 只看内容叶子: 装饰形状出血是设计手段 (封面背景层刻意超出版面 180px)。 */
  if (opts?.assertWithinCanvas !== false) {
    const canvas = { width: 1280, height: 720 };
    const of = assertWithinCanvas(laid, canvas);
    if (of.hasOverflow) {
      const SIDE: Record<OverflowItem['side'], string> = { top: '上', right: '右', bottom: '下', left: '左' };
      const summary = of.items.slice(0, 5).map((o: OverflowItem) =>
        `  · ${o.kind}${o.text ? ` "${o.text}"` : ''} 超出${SIDE[o.side]}边缘 ${o.by}px`
      ).join('\n');
      console.warn(`[compose] ${of.items.length} 处内容画到版面外 (这部分观众看不到):\n${summary}`);
    }
  }

  if (opts?.assertNoOverlap !== false) {
    let contentLeaves = 0;
    const countContent = (b: LayoutBox): void => {
      const k = b.node.kind;
      if (k === 'text') { if (String((b.node as TextNode).text ?? '').trim()) contentLeaves++; }
      else if (k === 'image' || k === 'table') contentLeaves++;
      for (const c of b.children ?? []) countContent(c);
    };
    countContent(laid);
    if (contentLeaves === 0) {
      console.warn('[compose] 这一次 render 没有画出任何内容 —— '
        + '八成是槽位给了空集合或形状不对 (比如 cards: [] / columns 传了字符串数组 / steps 缺 label)。');
    }
  }

  /* 4. Paint · walk 树 · 每 node 落 pptx shape */
  paint(slide, laid);

  /* 5. 换页动画 —— 挂在 render() 而不是各模板里, 也不是 deck 工具里。
   *
   * render() 是**所有模板的唯一咽喉**: 20 个模板没有一个不调它。挂在这里, 两条
   * 使用路径 (deck_add_slide 工具 / SKILL 里的 deck.mjs 直调模板) 都自动拿到动画。
   * 我第一版接在 deck 工具里, 结果 deck.mjs 那条路完全没有 —— 又是"做完了但那条
   * 路调不到"。一页 render 多次时重复赋同一个值, 无副作用。
   *
   * 动画跟着**冻结的风格**走, 不是逐页参数: 同一份 deck 里第 3 页淡入、第 7 页推入
   * 是最典型的拼凑感。 */
  applyStyleTransition(slide as unknown as { transition?: unknown });
}

function dumpLayout(box: { node: ComposeNode; frame: Frame; children?: any[] }, depth: number): void {
  const f = box.frame;
  const p = (box.node.layoutParams ?? {}) as any;
  const tag = [
    p.flex ? `flex:${p.flex}` : '',
    p.align ? `align:${p.align}` : '',
    p.height != null ? `h!:${p.height}` : '',
  ].filter(Boolean).join(' ');
  console.log(
    `${'  '.repeat(depth)}${box.node.kind} ` +
    `[${f.x.toFixed(0)},${f.y.toFixed(0)} ${f.width.toFixed(0)}×${f.height.toFixed(0)}] ${tag}`,
  );
  for (const c of box.children ?? []) dumpLayout(c, depth + 1);
}

/** fit:false 时的老路径 —— 保留原语义, 只为需要原始密度落位的场景 */
function measureFallback(tree: ComposeNode, bounds: Frame) {
  return measure(tree, {
    minWidth: 0, maxWidth: bounds.width,
    minHeight: 0, maxHeight: bounds.height,
  });
}
