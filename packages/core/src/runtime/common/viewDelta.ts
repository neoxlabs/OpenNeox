
export interface ViewItem {
  /** 元素编号 (computer 的 id / browser 的 ref)。差异按它对齐。 */
  id: number;
  /** 给模型看的那一行, 含编号本身。 */
  line: string;
}

export type ViewDelta =
  | { mode: 'full' }
  | {
      mode: 'delta';
      /** 跟完整清单比没变的元素个数 */
      unchanged: number;
      /** 编号还是那个, 但那一行变了 (标签/状态) */
      changed: string[];
      /** 完整清单里没有的新元素 */
      added: string[];
      /** 完整清单里有、现在没了的编号, 压成区间: "12-15, 40" */
      removed: string;
      /** 其余字段 (摘要/结构…) 里跟完整那份不同的; 相同的不在这里 */
      extras: Record<string, string>;
    };

interface Base {
  items: Map<number, string>;
  extras: Record<string, string>;
  at: number;
  deltasSince: number;
}

export interface ViewDeltaOptions {
  /** 一份完整清单之后最多再发几次差异, 到了就整份重发 (防压缩/截断把那份完整的挤掉) */
  maxDeltasPerFull?: number;
  /** 完整清单多久之后不再拿来当底 */
  maxAgeMs?: number;
  /** 差异行数超过完整清单的这个比例就不值得了, 直接发全量 */
  maxDeltaRatio?: number;
  /** 清单太短 (几行) 就没必要发差异 */
  minItemsForDelta?: number;
}

const DEFAULTS: Required<ViewDeltaOptions> = {
  maxDeltasPerFull: 6,
  maxAgeMs: 8 * 60_000,
  maxDeltaRatio: 0.45,
  minItemsForDelta: 8,
};

/** 编号压成区间: [3,4,5,9,12,13] → "3-5, 9, 12-13" */
export function compressIds(ids: number[]): string {
  const xs = [...new Set(ids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
    out.push(i === j ? String(xs[i]) : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

export class ViewDeltaTracker {
  private readonly opts: Required<ViewDeltaOptions>;
  /** scope → (viewKey → 底) */
  private readonly bases = new Map<string, Map<string, Base>>();

  constructor(opts: ViewDeltaOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * 这一次该发全量还是差异。返回 full 时这份就成了新的底。
   * `forceFull`: 模型明确要整份 (它手里那份丢了), 或调用方自己没把握。
   */
  next(
    scope: string | undefined,
    viewKey: string,
    items: ViewItem[],
    extras: Record<string, string | undefined>,
    opts: { forceFull?: boolean; now?: number } = {},
  ): ViewDelta {
    const now = opts.now ?? Date.now();
    const cleanExtras: Record<string, string> = {};
    for (const [k, v] of Object.entries(extras)) if (typeof v === 'string' && v) cleanExtras[k] = v;
    const asFull = (): ViewDelta => {
      if (scope) this.remember(scope, viewKey, items, cleanExtras, now);
      return { mode: 'full' };
    };
    if (!scope || opts.forceFull) return asFull();
    const base = this.bases.get(scope)?.get(viewKey);
    if (!base) return asFull();
    if (now - base.at > this.opts.maxAgeMs) return asFull();
    if (base.deltasSince >= this.opts.maxDeltasPerFull) return asFull();
    if (base.items.size < this.opts.minItemsForDelta && items.length < this.opts.minItemsForDelta) return asFull();

    const changed: string[] = [];
    const added: string[] = [];
    const seen = new Set<number>();
    for (const it of items) {
      seen.add(it.id);
      const was = base.items.get(it.id);
      if (was === undefined) added.push(it.line);
      else if (was !== it.line) changed.push(it.line);
    }
    const removedIds: number[] = [];
    for (const id of base.items.keys()) if (!seen.has(id)) removedIds.push(id);
    const deltaExtras: Record<string, string> = {};
    for (const [k, v] of Object.entries(cleanExtras)) if (base.extras[k] !== v) deltaExtras[k] = v;
    for (const k of Object.keys(base.extras)) if (!(k in cleanExtras)) deltaExtras[k] = '(gone)';

    /* 差异的代价按"行"算: 改/增各一行, 删掉的编号压成区间几乎不占地方, 记 1/4 行 */
    const cost = changed.length + added.length + removedIds.length / 4;
    if (cost > Math.max(items.length, base.items.size) * this.opts.maxDeltaRatio) return asFull();

    base.deltasSince += 1;
    return {
      mode: 'delta',
      unchanged: items.length - changed.length - added.length,
      changed,
      added,
      removed: compressIds(removedIds),
      extras: deltaExtras,
    };
  }

  /** 丢掉一个作用域的全部底 (会话结束 / 测试) */
  reset(scope?: string): void {
    if (scope === undefined) this.bases.clear();
    else this.bases.delete(scope);
  }

  private remember(scope: string, viewKey: string, items: ViewItem[], extras: Record<string, string>, now: number): void {
    let m = this.bases.get(scope);
    if (!m) {
      m = new Map();
      this.bases.set(scope, m);
      /* 会话数封顶: 长跑的桌面进程里会话只增不减 */
      if (this.bases.size > 64) {
        const oldest = this.bases.keys().next().value;
        if (oldest !== undefined) this.bases.delete(oldest);
      }
    }
    m.delete(viewKey);
    m.set(viewKey, { items: new Map(items.map((i) => [i.id, i.line])), extras, at: now, deltasSince: 0 });
    /* 每个会话记最近 8 个窗口/页面 —— 来回切换时还能对上, 又不会无限涨 */
    while (m.size > 8) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }
}
