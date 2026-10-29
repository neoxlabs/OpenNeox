
import type { ComposeNode, Frame, LayoutParams } from '../compose/types.js';
import { measure, type MeasureResult } from './measure.js';
import { measureText } from './text-metrics.js';
import { layout, type LayoutBox } from './layout.js';

/** 内容高度占版心的目标下限 —— 低于它就认为"版面空着", 要放间距去填 */
const TARGET_FILL = 0.86;

/** 缩排的档位。一档一档试, 取第一个装得下的 —— 不做连续二分, 因为
 *  字号是离散的排版量, 13.7pt 这种值只会让全篇字号对不齐。 */
const DENSITY_STEPS = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72] as const;

/**
 * 自动降字号的下限 (pt)。投影上 14pt 是"最后一排还能看清"的线, 再小就该改内容而不是继续缩。
 * 缩到这个下限仍然装不下 → 不再硬压, 在回执里如实说"内容超容量, 建议拆页"(Work P-07)。
 */
export const MIN_FIT_FONT_PT = 14;
/** 判"装不下"的容差 (px)。flex 撑满时 contentH 与版心高只差浮点噪声, 见 fitToBounds */
const FIT_EPS = 0.5;

/** 间距最多放大到原来的几倍 —— 再多就散架了, 各块之间失去归属感 */
const MAX_GAP_GROWTH = 2.6;

/** 单个间隙最多additional 多少 px —— 防止两块内容被推到一页的两端 */
const MAX_GAP_ADD_PX = 88;

/** 剩余空白里放在内容上方的比例。视觉中心比几何中心略高, 所以不是 0.5 */
const OPTICAL_TOP_RATIO = 0.38;

export interface FitReport {
  /** 最终采用的密度系数 (1 = 原样) */
  density: number;
  /** 内容高 / 版心高。>1 表示压出版心了 */
  fill: number;
  /** 缩到最小档仍然装不下 —— 这一页的内容真的太多了, 必须减内容 */
  overflow: boolean;
  /** 溢出的像素数 (overflow 为 true 时有意义) */
  overflowPx: number;
  /** 为了填满版面, 根级间距被放大到了多少倍 */
  gapGrowth: number;
  /** 有几处原子文本 (数字/短标签) 因为放不下被单独收了字号 */
  atomicShrunk: number;
  /** 这一页最终最小字号 (pt, 含整页密度缩放后); 没有文字时为 Infinity */
  minFontPt: number;
  /** 是被 14pt 下限截停的 (再缩就能装下, 但不该再缩) —— 上层据此建议拆页 */
  fontFloorHit: boolean;
}

export interface FitResult {
  tree: ComposeNode;
  measured: MeasureResult;
  /** 实际用于 layout 的根 frame (可能比 bounds 矮并做了光学居中) */
  rootFrame: Frame;
  report: FitReport;
}

/* ============================================================
 * 密度缩放 —— 纯函数, 不改原树
 * ============================================================ */

/**
 * 按系数 k 缩放一棵树的**排版密度**。
 * 只碰 fontSize / gap / padding / lineHeightPt, 不碰 width / height ——
 * 理由见文件头。letterSpacing 也一起走, 否则缩了字号字距会显得松。
 */
export function scaleDensity(node: ComposeNode, k: number): ComposeNode {
  if (k === 1) return node;
  const p = node.layoutParams as LayoutParams | undefined;
  const next: any = { ...node };

  if (p) {
    const np: any = { ...p };
    if (typeof np.fontSize === 'number') np.fontSize = round1(np.fontSize * k);
    if (typeof np.lineHeightPt === 'number') np.lineHeightPt = round1(np.lineHeightPt * k);
    if (typeof np.letterSpacingPt === 'number') np.letterSpacingPt = round2(np.letterSpacingPt * k);
    if (typeof np.gap === 'number') np.gap = Math.round(np.gap * k);
    if (np.padding != null) np.padding = scaleInsets(np.padding, k);
    next.layoutParams = np;
  }

  if (Array.isArray((node as any).children)) {
    next.children = (node as any).children.map((c: ComposeNode) => scaleDensity(c, k));
  }
  return next as ComposeNode;
}

function scaleInsets(pad: any, k: number): any {
  if (typeof pad === 'number') return Math.round(pad * k);
  const out: any = {};
  for (const key of ['top', 'right', 'bottom', 'left']) {
    if (typeof pad[key] === 'number') out[key] = Math.round(pad[key] * k);
  }
  return out;
}

/**
 * 放大根节点各子块之间的间距, 把富余高度吃掉。
 * 只动根这一层 —— 往下递归会把每个小分组也撑开, 内容就失去成组关系了
 * (一页 PPT 里"标题和它的正文靠得近"本身就是信息)。
 */
function growRootGap(node: ComposeNode, extraPerGap: number): ComposeNode {
  const p = (node.layoutParams ?? {}) as LayoutParams & { gap?: number };
  const base = p.gap ?? 0;
  const grown = Math.min(
    base + extraPerGap,
    base > 0 ? base * MAX_GAP_GROWTH : extraPerGap,
    base + MAX_GAP_ADD_PX,
  );
  return { ...node, layoutParams: { ...p, gap: Math.round(grown) } } as ComposeNode;
}

/* ============================================================
 * 主求解
 * ============================================================ */

/**
 * 试排一次, 返回内容真正占到哪里。
 *
 * 不能拿 measure 的返回高度当内容高: 它被 maxHeight 夹过 (VStack 自己的高度
 * `min(maxHeight, 内容和)`), 内容超了也只报版心高度, 溢出永远测不出来。
 * 子节点的尺寸没被夹, 所以排完之后走一遍布局树取最大底边, 才是事实。
 */
function probe(tree: ComposeNode, bounds: Frame): {
  measured: MeasureResult; laid: LayoutBox; contentH: number;
} {
  const measured = measure(tree, {
    minWidth: 0, maxWidth: bounds.width,
    minHeight: 0, maxHeight: bounds.height,
  });
  const laid = layout(measured, { ...bounds });
  const contentH = maxBottom(laid) - bounds.y;
  /* 诊断 (NEOX_FIT_DEBUG=1): 哪些叶子压出了版心底 —— "整页被降密度"时第一个要问的问题 */
  if (contentH > bounds.height + FIT_EPS && typeof process !== 'undefined' && process.env?.NEOX_FIT_DEBUG) {
    const out: string[] = [];
    const walk = (b: LayoutBox, depth: number) => {
      const bottom = b.frame.y + b.frame.height;
      if (bottom > bounds.y + bounds.height + 0.5) {
        const txt = (b.node as any).text ? ` "${String((b.node as any).text).slice(0, 16)}"` : '';
        out.push(`${'  '.repeat(depth)}${b.node.kind}${txt} y=${Math.round(b.frame.y)} h=${Math.round(b.frame.height)} bottom=${Math.round(bottom)}`);
      }
      for (const c of b.children ?? []) walk(c, depth + 1);
    };
    walk(laid, 0);
    console.warn(`[fit] contentH ${Math.round(contentH)} > ${bounds.height}:\n${out.slice(0, 30).join('\n')}`);
  }
  return { measured, laid, contentH };
}

/**
 * 这棵树有没有声明"我要占满可用高度"?
 *
 * 判据只看根节点这一层: 根显式给了 height, 或者根的直接子里有 flex>0 的。
 * 不递归 —— 深层的 flex 是在**它自己的容器**里分配空间, 跟根框该多高无关;
 * 递归会把一堆本该居中的短内容页误判成要撑满。
 */
function declaresFill(tree: ComposeNode): boolean {
  const p = (tree.layoutParams ?? {}) as any;
  if (typeof p.height === 'number') return true;
  if (tree.kind !== 'vstack' && tree.kind !== 'zstack' && tree.kind !== 'grid') return false;
  return (tree.children ?? []).some((c) => ((c.layoutParams as any)?.flex ?? 0) > 0);
}

const CONTAINER_KINDS = new Set(['vstack', 'hstack', 'zstack', 'grid']);

function isNumericToken(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length > 14) return false;
  const digits = (t.match(/[0-9]/g) ?? []).length;
  if (digits === 0) return false;
  /* 数字占比够高 = 这是个数值, 不是一句话。"¥1,240亿" 5/7, "34.5%" 3/5,
   * "目标市场规模" 0/6 直接出局, "首年目标 10 万席位" 2/10 也出局。 */
  return digits / t.replace(/\s/g, '').length >= 0.34;
}

/**
 * 角色签名 —— 决定谁和谁必须保持同样大小。
 *
 * 【这是"同一页字体有大有小"的正解】字号不是每个元素自己的属性, 是**一套页面共享
 * 的尺度**。6 张 KPI 卡的数值是同一个角色, 它们必须同进同退: 要缩一起缩, 取组内
 * 最小的那个比例。上一版按每个节点自己的框宽独立算, 6 张卡算出 6 个比例
 * (42.2/43.1/42.4/44.8), 单看每张都"刚好放得下", 合起来就是类型尺度被拆了 ——
 * 而类型尺度恰恰是"看起来像设计过"的第一来源。
 */
function roleKey(p: any): string {
  return [p.fontSize ?? 16, p.bold ? 'b' : '', p.color ?? '', p.fontEast ?? '', p.fontLatin ?? ''].join('|');
}

/** 单个原子文本最多缩到原字号的多少 —— 再小就和旁边的说明文字一样大了, 失去主次 */
const ATOMIC_MIN_SCALE = 0.62;

/**
 * 原子文本的安全余量 —— 只要求它占到框宽的 92% 以内, 不是 100%。
 * 按 100% 判定时求解器认为 "10.0%" 已经放得下, 但 LibreOffice 里照样折成两行:
 * 我们的 advance 表和渲染端对字距的算法差几个百分点, 边界情况就翻车。
 * 数字窄 8% 没人看得出来, 数字被折断一眼就看得出来 —— 余量给在这一侧。
 */
const ATOMIC_SAFE_RATIO = 0.92;

/**
 * 找出被折断的数值文本, 按**角色**给出统一的收缩比例。
 * 返回 node → scale; 同一角色的所有节点 (包括本来放得下的那些) 都会拿到同一个比例,
 * 这样它们缩完仍然一样大。
 */
function atomicShrinkMap(box: LayoutBox): Map<ComposeNode, number> {
  /* 第一遍: 按角色分组, 记下每个角色需要的最小比例 + 该角色的全部节点 */
  const byRole = new Map<string, { ratio: number; nodes: ComposeNode[] }>();
  const walk = (b: LayoutBox) => {
    if (b.node.kind === 'text' && b.frame.width > 0) {
      const text = String((b.node as any).text ?? '');
      const p = (b.node.layoutParams ?? {}) as any;
      /* 同角色的**全部**文字都进组, 不只是数值那些 —— 否则会出现"一堆副标签是 14pt,
       * 其中含数字的那条被单独收成 12.3pt"。只有数值型的成员**触发**收缩,
       * 但收缩要落到整组身上, 尺度才不会花。 */
      const key = roleKey(p);
      let g = byRole.get(key);
      if (!g) { g = { ratio: 1, nodes: [] }; byRole.set(key, g); }
      g.nodes.push(b.node);
      if (isNumericToken(text)) {
        const natural = measureText(text, p.fontSize ?? 16, Infinity, {
          fontLatin: p.fontLatin, fontEast: p.fontEast,
          bold: p.bold, letterSpacingPt: p.letterSpacingPt,
          lineHeightPt: p.lineHeightPt, singleLine: true,
        }).width;
        const budget = b.frame.width * ATOMIC_SAFE_RATIO;
        if (natural > budget) {
          g.ratio = Math.min(g.ratio, Math.max(ATOMIC_MIN_SCALE, budget / natural));
        }
      }
    }
    for (const c of b.children ?? []) walk(c);
  };
  walk(box);

  /* 第二遍: 把组内最小比例发给该角色的每一个节点 —— 一起缩才不会花 */
  const out = new Map<ComposeNode, number>();
  for (const g of byRole.values()) {
    if (g.ratio >= 1) continue;
    for (const n of g.nodes) out.set(n, g.ratio);
  }
  return out;
}

/** 按映射逐个缩字号, 其它节点原样传递 */
function applyAtomicShrink(node: ComposeNode, map: Map<ComposeNode, number>): ComposeNode {
  const k = map.get(node);
  const kids = (node as any).children as ComposeNode[] | undefined;
  if (k == null && !kids) return node;
  const next: any = { ...node };
  if (k != null) {
    const p = (node.layoutParams ?? {}) as any;
    next.layoutParams = {
      ...p,
      fontSize: round1((p.fontSize ?? 16) * k),
      /* 字距也跟着收, 否则缩了字号字还是撑出去 */
      letterSpacingPt: typeof p.letterSpacingPt === 'number'
        ? round2(p.letterSpacingPt * k) : p.letterSpacingPt,
    };
  }
  if (kids) next.children = kids.map((c) => applyAtomicShrink(c, map));
  return next as ComposeNode;
}

/**
 * 内容真正占到的最低点。
 *
 * 只算**会落到 pptx 上的东西** —— 叶子节点, 以及带背景色的容器。容器自己的 frame
 * 是"分给它多大", 不是"它用了多大": 根容器的 frame 恒等于版心, 把它算进来的话
 * contentH 永远等于版心高, fill 永远是 1.00, 装不满这个方向就彻底测不出来
 * (第一版就是这么写的, 9 个用例全报 1.00 才发现)。
 */
function maxBottom(box: LayoutBox): number {
  const p = (box.node.layoutParams ?? {}) as { background?: string; bleed?: unknown };
  if (p.bleed) return -Infinity;
  const paints = !CONTAINER_KINDS.has(box.node.kind) || p.background != null;
  let b = paints ? box.frame.y + box.frame.height : -Infinity;
  for (const c of box.children ?? []) b = Math.max(b, maxBottom(c));
  return b;
}

export function fitToBounds(tree: ComposeNode, bounds: Frame): FitResult {
  /* ── 1. 原样试排一次 ─────────────────────────────────── */
  let density = 1;
  let work = tree;
  let { measured, laid, contentH } = probe(work, bounds);

  /* ── 2. 竖向装不下: 一档一档缩整页密度 ─────────────────── */
  let overflow = false;
  let fontFloorHit = false;
  if (contentH > bounds.height + FIT_EPS) {
    /* 这一页能把整页密度降到多低而不把正文压到 14pt 以下 —— 见 minAllowedDensity */
    const floor = minAllowedDensity(tree);
    for (const k of DENSITY_STEPS) {
      if (k >= 1) continue;
      if (k + 1e-9 < floor) {
        /* 再降一档就跌破 14pt 了: 停在这里, 后面更小的档位也只会更小 */
        fontFloorHit = true;
        break;
      }
      density = k;
      work = scaleDensity(tree, k);
      ({ measured, laid, contentH } = probe(work, bounds));
      if (contentH <= bounds.height + FIT_EPS) break;
    }
    /* 缩到下限仍装不下 = 内容量本身超了。不再硬压 —— 继续缩只会把字压到看不清,
     * 且仍然溢出。如实报出去, 让上层决定是拆页还是删内容。 */
    overflow = contentH > bounds.height + FIT_EPS;
    if (!overflow) fontFloorHit = false;
  }

  /* ── 3. 装不满: 放间距 ───────────────────────────────── */
  let gapGrowth = 1;
  const rootChildren = ((work as any).children ?? []) as ComposeNode[];
  const canDistribute =
    work.kind === 'vstack' && rootChildren.length > 1 && !overflow
    /* gapFixed = 这一层的 gap 是图形结构, 撑开就画坏了 (见 LayoutParams.gapFixed) */
    && !((work.layoutParams ?? {}) as LayoutParams & { gapFixed?: boolean }).gapFixed;

  if (canDistribute && contentH < bounds.height * TARGET_FILL) {
    const gaps = rootChildren.length - 1;
    const extraPerGap = (bounds.height - contentH) / gaps;
    const before = ((work.layoutParams ?? {}) as LayoutParams & { gap?: number }).gap ?? 0;
    work = growRootGap(work, extraPerGap);
    const after = ((work.layoutParams ?? {}) as LayoutParams & { gap?: number }).gap ?? 0;
    gapGrowth = before > 0 ? after / before : 1;
    ({ measured, laid, contentH } = probe(work, bounds));
  }

  let atomicShrunk = 0;
  for (let round = 0; round < 3; round++) {
    const map = atomicShrinkMap(laid);
    if (map.size === 0) break;
    atomicShrunk = Math.max(atomicShrunk, map.size);
    work = applyAtomicShrink(work, map);
    ({ measured, laid, contentH } = probe(work, bounds));
  }

  const fills = declaresFill(work);
  const residual = Math.max(0, bounds.height - contentH);
  const rootFrame: Frame = {
    x: bounds.x,
    y: fills ? bounds.y : bounds.y + Math.round(residual * OPTICAL_TOP_RATIO),
    width: bounds.width,
    height: overflow ? contentH : (fills ? bounds.height : Math.min(contentH, bounds.height)),
  };

  return {
    tree: work,
    measured,
    rootFrame,
    report: {
      density,
      fill: bounds.height > 0 ? contentH / bounds.height : 0,
      overflow,
      overflowPx: overflow ? Math.round(contentH - bounds.height) : 0,
      gapGrowth: round2(gapGrowth),
      atomicShrunk,
      minFontPt: minTextFontPt(work),
      fontFloorHit,
    },
  };
}

/**
 * 整页密度最多能降到多少 —— 受 14pt 下限约束。
 *
 * 只约束**本来就不小于 14pt** 的文字: 模板里 10-12pt 的图注 / 坐标轴 / 页脚是设计意图,
 * 它们跟着整页按比例缩是原有行为, 拿下限去卡它们等于一页有图注就整页不能缩 (比现在更糟)。
 */
function minAllowedDensity(tree: ComposeNode): number {
  /* 0 = 还没碰到任何约束; 末尾 clamp 到 1 */
  let k = 0;
  const walk = (n: any): void => {
    const p = (n.layoutParams ?? {}) as LayoutParams;
    if (n.kind === 'text' && String(n.text ?? '').trim()) {
      const size = typeof (p as any).fontSize === 'number' ? (p as any).fontSize : 16;
      /* k 必须**同时**满足每个节点: 取最大的约束 (不是最小) ——
       * 取最小等于按"最宽松的那行字"放行, 16pt 正文就跟着 28pt 标题一起被压到 0.72。 */
      if (size >= MIN_FIT_FONT_PT) k = Math.max(k, MIN_FIT_FONT_PT / size);
    }
    for (const c of (n.children ?? []) as ComposeNode[]) walk(c);
  };
  walk(tree);
  return k === 0 ? 1 : Math.min(1, k);
}

/** 这棵树里内容文字的最小字号 (pt); 没有文字时 Infinity */
function minTextFontPt(tree: ComposeNode): number {
  let min = Infinity;
  const walk = (n: any): void => {
    const p = (n.layoutParams ?? {}) as any;
    if (n.kind === 'text' && String(n.text ?? '').trim() && typeof p.fontSize === 'number') {
      min = Math.min(min, p.fontSize);
    }
    for (const c of (n.children ?? []) as ComposeNode[]) walk(c);
  };
  walk(tree);
  return Number.isFinite(min) ? Math.round(min * 10) / 10 : Infinity;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
