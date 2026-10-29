
export type DiffRowKind = 'ctx' | 'add' | 'del' | 'gap';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** 旧文件里的行号 (1-based); add 行没有 */
  oldNo?: number;
  /** 新文件里的行号 (1-based); del 行没有 */
  newNo?: number;
  /** kind==='gap' 时: 这里折叠了多少行未改动 */
  hidden?: number;
  /** kind==='gap' 时: 被折叠的那些行本身。
   *  留着是为了让折叠带**可点开** —— 判断一处改动对不对常常要往上下多看几行,
   *  而重新取一次文件全文只为了展开一段是舍近求远。 */
  hiddenRows?: DiffRow[];
}

/** LCS 表最多算这么多格 —— 约 4M, 在 renderer 里是几十毫秒的事。
 *  走到这一步说明这一段里连一个"两边都只出现一次"的行都没有 (整段全是 `}` / 空行
 *  这种)。那时是真的没有可靠锚点, 不是算不动。 */
const MAX_LCS_CELLS = 4_000_000;
/** 小于这个规模就别费劲找锚点了, 直接 LCS —— 结果更准, 开销也可以忽略 */
const SMALL_ENOUGH_CELLS = 40_000;
/** 改动块前后各留几行上下文 */
const CONTEXT = 3;
/** 少于这么多行的"未改动"不值得折叠 —— 折叠带本身就一行高 */
const GAP_MIN = 5;

function splitLines(s: string): string[] {
  if (!s) return [];
  const out = s.split('\n');
  /* 文件通常以 \n 结尾, split 出来最后一个空串不是真的一行 */
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

interface RawOp { kind: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }

/** patience diff 的主体: 锚点切段 → 每段 LCS。a/b 是**已经削掉公共前后缀的中段**。 */
function patienceOps(a: string[], b: string[], oldBase: number, newBase: number): RawOp[] {
  if (a.length === 0 || b.length === 0) return lcsOps(a, b, oldBase, newBase);
  /* 段够小就直接 LCS —— 锚点那一套的开销在这个规模上不划算 */
  if (a.length * b.length <= SMALL_ENOUGH_CELLS) return lcsOps(a, b, oldBase, newBase);

  /* 两边都只出现一次的行 —— 这种行几乎不可能配错, 拿来当锚 */
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  for (const l of b) countB.set(l, (countB.get(l) ?? 0) + 1);
  const posB = new Map<string, number>();
  for (let j = 0; j < b.length; j++) {
    const l = b[j]!;
    if (countB.get(l) === 1 && countA.get(l) === 1) posB.set(l, j);
  }
  /* 按 a 的顺序收集 (i, j) 对 */
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < a.length; i++) {
    const j = posB.get(a[i]!);
    if (j !== undefined) pairs.push([i, j]);
  }
  if (pairs.length === 0) return lcsOps(a, b, oldBase, newBase);

  /* j 的最长递增子序列 = 互不交叉的那组锚点 (O(n log n) patience sorting) */
  const tails: number[] = [];      /* tails[k] = 长度 k+1 的 LIS 当前最小结尾在 pairs 里的下标 */
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    if (lo === tails.length) tails.push(k); else tails[lo] = k;
  }
  const anchors: Array<[number, number]> = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) {
    anchors.push(pairs[k]!);
    if (prev[k] === -1) break;
  }
  anchors.reverse();
  if (anchors.length === 0) return lcsOps(a, b, oldBase, newBase);

  const out: RawOp[] = [];
  let ai = 0;
  let bi = 0;
  for (const [i, j] of anchors) {
    if (i > ai || j > bi) {
      out.push(...patienceOps(a.slice(ai, i), b.slice(bi, j), oldBase + ai, newBase + bi));
    }
    out.push({ kind: 'ctx', text: a[i]!, oldNo: oldBase + i, newNo: newBase + j });
    ai = i + 1;
    bi = j + 1;
  }
  if (ai < a.length || bi < b.length) {
    out.push(...patienceOps(a.slice(ai), b.slice(bi), oldBase + ai, newBase + bi));
  }
  return out;
}

/** 经典 LCS 回溯, 只在小段上调用 (patienceOps 已经用锚点切过) */
function lcsOps(a: string[], b: string[], oldBase: number, newBase: number): RawOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((t, i) => ({ kind: 'add' as const, text: t, newNo: newBase + i }));
  if (m === 0) return a.map((t, i) => ({ kind: 'del' as const, text: t, oldNo: oldBase + i }));

  if (n * m > MAX_LCS_CELLS) {
    /* 太大就不逐行配对了 —— 见文件头的说明 */
    return [
      ...a.map((t, i) => ({ kind: 'del' as const, text: t, oldNo: oldBase + i })),
      ...b.map((t, i) => ({ kind: 'add' as const, text: t, newNo: newBase + i })),
    ];
  }

  /* (n+1) × (m+1) 的表压成一维 */
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * W + j]!, dp[i * W + (j + 1)]!);
    }
  }

  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i]!, oldNo: oldBase + i, newNo: newBase + j });
      i++; j++;
    } else if (dp[(i + 1) * W + j]! >= dp[i * W + (j + 1)]!) {
      ops.push({ kind: 'del', text: a[i]!, oldNo: oldBase + i });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j]!, newNo: newBase + j });
      j++;
    }
  }
  while (i < n) { ops.push({ kind: 'del', text: a[i]!, oldNo: oldBase + i }); i++; }
  while (j < m) { ops.push({ kind: 'add', text: b[j]!, newNo: newBase + j }); j++; }
  return ops;
}

export interface CommitDiff {
  rows: DiffRow[];
  add: number;
  del: number;
  /** 两边完全一样 (只改了模式 / 是二进制) */
  identical: boolean;
  /** 看着像二进制, 不该按文本渲染 */
  binary: boolean;
  /** 两侧全文 —— 语法高亮要按**整份文件**做词法分析, 不能一行一行喂。
   *  一行一行的话, 块注释 / 模板字符串 / 多行字符串的中段会被当成代码染色,
   *  而 diff 里恰恰到处是"从中间截出来的几行"。这两个字段本来就在内存里, 白拿。 */
  original: string;
  modified: string;
}

function looksBinary(s: string): boolean {
  /* 只嗅前 8KB: 真二进制的 NUL 几乎总在开头 */
  const head = s.slice(0, 8192);
  return head.indexOf('\u0000') >= 0;
}

export function computeCommitDiff(original: string, modified: string): CommitDiff {
  if (looksBinary(original) || looksBinary(modified)) {
    return { rows: [], add: 0, del: 0, identical: false, binary: true, original, modified };
  }
  const a = splitLines(original);
  const b = splitLines(modified);

  /* 公共前缀 / 后缀 —— 大文件全靠这一步把中段削小 */
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
         && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midOps = patienceOps(
    a.slice(pre, a.length - suf),
    b.slice(pre, b.length - suf),
    pre,
    pre,
  );

  const ops: RawOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: 'ctx', text: a[i]!, oldNo: i, newNo: i });
  ops.push(...midOps);
  for (let i = 0; i < suf; i++) {
    const oi = a.length - suf + i;
    const ni = b.length - suf + i;
    ops.push({ kind: 'ctx', text: a[oi]!, oldNo: oi, newNo: ni });
  }

  const add = ops.reduce((s, o) => s + (o.kind === 'add' ? 1 : 0), 0);
  const del = ops.reduce((s, o) => s + (o.kind === 'del' ? 1 : 0), 0);
  if (add === 0 && del === 0) {
    return { rows: [], add: 0, del: 0, identical: true, binary: false, original, modified };
  }

  /* 折叠远离改动的上下文 —— 标记每个 ctx 是否在某个改动块的 CONTEXT 行以内 */
  const keep = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === 'ctx') continue;
    keep[i] = 1;
    for (let k = 1; k <= CONTEXT; k++) {
      if (i - k >= 0) keep[i - k] = 1;
      if (i + k < ops.length) keep[i + k] = 1;
    }
  }

  const rows: DiffRow[] = [];
  let runStart = -1;
  const flushRun = (endExclusive: number) => {
    if (runStart < 0) return;
    const len = endExclusive - runStart;
    const asCtx = (k: number): DiffRow => {
      const o = ops[k]!;
      return { kind: 'ctx', text: o.text, oldNo: (o.oldNo ?? 0) + 1, newNo: (o.newNo ?? 0) + 1 };
    };
    if (len >= GAP_MIN) {
      const hiddenRows: DiffRow[] = [];
      for (let k = runStart; k < endExclusive; k++) hiddenRows.push(asCtx(k));
      rows.push({ kind: 'gap', text: '', hidden: len, oldNo: (ops[runStart]!.oldNo ?? 0) + 1, hiddenRows });
    } else {
      for (let k = runStart; k < endExclusive; k++) rows.push(asCtx(k));
    }
    runStart = -1;
  };
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) { if (runStart < 0) runStart = i; continue; }
    flushRun(i);
    const o = ops[i]!;
    rows.push({
      kind: o.kind,
      text: o.text,
      oldNo: o.oldNo === undefined ? undefined : o.oldNo + 1,
      newNo: o.newNo === undefined ? undefined : o.newNo + 1,
    });
  }
  flushRun(ops.length);

  return { rows, add, del, identical: false, binary: false, original, modified };
}
