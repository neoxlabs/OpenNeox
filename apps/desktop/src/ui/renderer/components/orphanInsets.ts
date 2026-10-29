
/** 纯判定: 顶边落在正文底边之下 (容差 tolerance px) 的是孤儿; 并且**一旦有一张是孤儿,
 *  它后面的全是** —— 它们在同一根右柱里, 后面的只会更低。 */
export function pickOrphanInsets(textBottom: number, tops: number[], tolerance = 4): boolean[] {
  let orphaned = false;
  return tops.map((top) => {
    if (!orphaned && top >= textBottom - tolerance) orphaned = true;
    return orphaned;
  });
}

const ORPHAN_CLASS = 'is-orphan';

/** 通栏插图 (柱/线/热力图、wide 图片): 不浮动, 本来就铺满, 不参与孤儿回填 */
function isWideInset(w: HTMLElement): boolean {
  return !!w.querySelector('.is-wide, .ncard__figure--wide');
}

export const RAIL_GAP_MIN = 20;
export const RAIL_PULL_MAX = 240;

/** 纯判定: 给右栏里依次的插图 [top,bottom], 返回**第一张**该往上贴的下标 (每次只挪一张,
 *  挪完重量再来), 没有则 -1。 */
export function pickRailPull(
  boxes: Array<{ top: number; bottom: number }>,
  gapMin = RAIL_GAP_MIN,
  pullMax = RAIL_PULL_MAX,
): number {
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i].top - boxes[i - 1].bottom;
    if (gap > gapMin && gap <= pullMax) return i;
  }
  return -1;
}

export type Side = 'right' | 'left';

export const LEFT_FLOAT_MAX_HEIGHT = 170;

export function pickSide(args: { top: number; lastSide: Side; leftBottom: number; rightBottom: number; height?: number; slack?: number }): Side {
  const slack = args.slack ?? 8;
  const activeL = args.leftBottom > args.top + slack;
  const activeR = args.rightBottom > args.top + slack;
  if (activeL && !activeR) return 'left';
  if (activeR && !activeL) return 'right';
  if (activeL && activeR) return args.leftBottom <= args.rightBottom ? 'left' : 'right';
  const short = (args.height ?? Infinity) <= LEFT_FLOAT_MAX_HEIGHT;
  return args.lastSide === 'right' && short ? 'left' : 'right';
}

function assignSides(container: HTMLElement): void {
  const floats = Array.from(container.querySelectorAll<HTMLElement>('.ncard-wrap'))
    .filter((w) => !w.classList.contains(ORPHAN_CLASS)
      && !w.querySelector('.is-strip, .is-wide, .ncard__figure--wide')
      && (w.dataset.side || getComputedStyle(w).float !== 'none'));
  let lastSide: Side = 'left'; /* 第一张落右 */
  const bottom: Record<Side, number> = { left: -Infinity, right: -Infinity };
  for (const w of floats) {
    const r = w.getBoundingClientRect();
    /* 本张的"自然顶": 它前面被 clear 推下去过, r.top 已经不是原位; 它所属的那段正文
     * (紧随其后的兄弟) 的顶边才是它该出现的高度 */
    const next = w.nextElementSibling as HTMLElement | null;
    const top = Math.min(r.top, next ? next.getBoundingClientRect().top : r.top);
    if (w.dataset.side === 'right' || w.dataset.side === 'left') {
      lastSide = w.dataset.side;
      bottom[lastSide] = Math.max(bottom[lastSide], r.bottom);
      continue;
    }
    const side = pickSide({ top, lastSide, leftBottom: bottom.left, rightBottom: bottom.right, height: r.height });
    w.dataset.side = side;
    lastSide = side;
    /* 定边后它会被 clear 推到那一栏最后一张之下: 底边 = max(栏底, 自然顶) + 自身高 */
    bottom[side] = Math.max(bottom[side], top) + r.height;
  }
}

function packInsetRail(container: HTMLElement): number {
  let moved = 0;
  for (let pass = 0; pass < 12; pass++) {
    /* 打包只在**同一边**的插图之间做 —— 左右两根柱各自缝合 */
    const all = Array.from(container.querySelectorAll<HTMLElement>('.ncard-wrap'))
      .filter((w) => !w.classList.contains(ORPHAN_CLASS) && getComputedStyle(w).float !== 'none');
    const side = pass % 2 === 0 ? 'right' : 'left';
    const rail = all.filter((w) => getComputedStyle(w).float === side);
    const boxes = rail.map((w) => { const r = w.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const i = pickRailPull(boxes);
    if (i < 0) { if (pass >= 1 && moved === 0) break; continue; }
    const prev = rail[i - 1];
    const cur = rail[i];
    if (prev.nextElementSibling === cur) continue; /* 已经相邻还留缝 = 缝来自别处, 不是挪能解决的 */
    prev.after(cur);
    moved += 1;
  }
  return moved;
}

/** 容器里"正文"的底边: 除插图/浮动元素之外, 所有有高度的直接子块的最大 bottom。 */
function lastTextBottom(container: HTMLElement): number {
  let bottom = -Infinity;
  for (const child of Array.from(container.children) as HTMLElement[]) {
    if (child.classList.contains('ncard-wrap')) continue;
    const cs = getComputedStyle(child);
    if (cs.float !== 'none' || cs.position === 'absolute') continue;
    const r = child.getBoundingClientRect();
    if (r.height <= 0) continue;
    bottom = Math.max(bottom, r.bottom);
  }
  return bottom;
}

/**
 * 在一个 .markdown-content 上跑一遍孤儿判定并落 DOM。
 * @returns 本次新判成孤儿的数量 (用于测试 / 调试, 调用方不必关心)
 */
export function settleOrphanInsets(container: HTMLElement): number {
  /* 先定边 (左右交替), 再把两根柱各自打包 (缝合上), 最后判孤儿 —— 打包之后正文能绕的更多, 孤儿更少 */
  assignSides(container);
  packInsetRail(container);
  for (const w of Array.from(container.querySelectorAll<HTMLElement>(`.ncard-wrap.${ORPHAN_CLASS}`))) {
    if (isWideInset(w)) w.classList.remove(ORPHAN_CLASS);
  }
  const wraps = Array.from(container.querySelectorAll<HTMLElement>('.ncard-wrap'))
    .filter((w) => !isWideInset(w))
    .filter((w) => w.classList.contains(ORPHAN_CLASS) || getComputedStyle(w).float !== 'none');
  if (wraps.length === 0) return 0;
  const textBottom = lastTextBottom(container);
  if (!Number.isFinite(textBottom)) return 0;
  const tops = wraps.map((w) => w.getBoundingClientRect().top);
  const flags = pickOrphanInsets(textBottom, tops);
  let changed = 0;
  wraps.forEach((w, i) => {
    if (!flags[i] || w.classList.contains(ORPHAN_CLASS)) return;
    w.classList.add(ORPHAN_CLASS);
    /* 挪到容器末尾, 保持彼此的原始顺序 (forEach 按 DOM 序, 依次 append 即保序) */
    container.appendChild(w);
    changed += 1;
  });
  return changed;
}
