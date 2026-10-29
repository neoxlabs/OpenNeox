
/** 一段的缓存条目: 输入元素快照 + 输出结果 */
interface Segment<TIn, TOut> {
  input: TIn[];
  output: TOut[];
  /** 算这一段时它是不是最后一段 (活跃 turn)。
   *  封口后要重算一次 —— 折叠只对已封口的 turn 生效, 而"最后一段"这个身份会随
   *  新 turn 到来而失效。不记这个标志的话, 上一轮的 turn 会永远停在未折叠状态:
   *  它的输入区间没变, 复用检查会一路放行。 */
  computedAsLast: boolean;
}

export interface SegmentCache<TIn, TOut> {
  run(
    items: TIn[],
    isBoundary: (item: TIn) => boolean,
    /** prevOutput = 上一帧**同一段**算出来的结果 (首元素身份判同); 没有则 null。
     *  给需要"只增不改"单调性的判定用 —— 见 timelineRows 的折叠单调闩。 */
    compute: (segment: TIn[], isLast: boolean, prevOutput: TOut[] | null) => TOut[],
    ctxSig: string,
  ): TOut[];
  reset(): void;
  readonly stats: { segments: number; reused: number; recomputed: number };
}

const MAX_CTX_BUCKETS = 8;

interface CtxBucket<TIn, TOut> {
  segments: Array<Segment<TIn, TOut>>;
  flat: TOut[];
}

export function createSegmentCache<TIn, TOut>(): SegmentCache<TIn, TOut> {
  const buckets = new Map<string, CtxBucket<TIn, TOut>>();
  const stats = { segments: 0, reused: 0, recomputed: 0 };

  /* 边界索引复用同一个数组, 避免每帧分配 (长会话有几千段) */
  const bounds: number[] = [];

  const touchBucket = (ctxSig: string): CtxBucket<TIn, TOut> => {
    const existing = buckets.get(ctxSig);
    if (existing) {
      buckets.delete(ctxSig);
      buckets.set(ctxSig, existing);
      return existing;
    }
    const created: CtxBucket<TIn, TOut> = { segments: [], flat: [] };
    buckets.set(ctxSig, created);
    while (buckets.size > MAX_CTX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (!oldest || oldest === ctxSig) break;
      buckets.delete(oldest);
    }
    return created;
  };

  return {
    stats,
    reset() {
      buckets.clear();
    },
    run(items, isBoundary, compute, ctxSig) {
      const bucket = touchBucket(ctxSig);
      let cachedSegments = bucket.segments;
      let cachedFlat = bucket.flat;

      bounds.length = 0;
      for (let i = 0; i < items.length; i++) {
        if (isBoundary(items[i]!) && i > 0) bounds.push(i);
      }
      const segCount = items.length === 0 ? 0 : bounds.length + 1;
      stats.segments = segCount;
      stats.reused = 0;
      stats.recomputed = 0;

      if (segCount === 0) {
        bucket.segments = [];
        bucket.flat = [];
        return [];
      }

      const segStart = (k: number) => (k === 0 ? 0 : bounds[k - 1]!);
      const segEnd = (k: number) => (k === segCount - 1 ? items.length : bounds[k]!);

      /** 纯指针比较 —— 全流程唯一保留的 O(n), 2 万次约 50µs */
      const sameRange = (cached: TIn[], start: number, end: number): boolean => {
        if (cached.length !== end - start) return false;
        for (let i = 0; i < cached.length; i++) {
          if (cached[i] !== items[start + i]) return false;
        }
        return true;
      };

      /* 先判定每一段是否可复用; 全部可复用时直接返回上一帧的扁平数组 */
      let allReused = cachedSegments.length === segCount && cachedFlat.length > 0;
      const reusable: boolean[] = new Array(segCount);
      for (let k = 0; k < segCount; k++) {
        const prev = cachedSegments[k];
        /* 最后一段是活跃 turn, 永远重算 */
        const isActive = k === segCount - 1;
        const ok = !isActive && !!prev && !prev.computedAsLast
          && sameRange(prev.input, segStart(k), segEnd(k));
        reusable[k] = ok;
        if (!ok) allReused = false;
      }
      if (allReused) {
        stats.reused = segCount;
        return cachedFlat;
      }

      const nextCache: Array<Segment<TIn, TOut>> = new Array(segCount);
      const out: TOut[] = [];
      for (let k = 0; k < segCount; k++) {
        if (reusable[k]) {
          const prev = cachedSegments[k]!;
          nextCache[k] = prev;
          for (let i = 0; i < prev.output.length; i++) out.push(prev.output[i]!);
          stats.reused++;
          continue;
        }
        const slice = items.slice(segStart(k), segEnd(k));
        const isLast = k === segCount - 1;
        /* 只在**确认是同一段**时才把上一帧结果交出去 —— 用首元素 (那条 user 消息)
         * 的对象身份判同。光按下标取会在段数变化 / 换会话时串到别的段上。 */
        const prevSeg = cachedSegments[k];
        const sameSegment = !!prevSeg && prevSeg.input.length > 0
          && slice.length > 0 && prevSeg.input[0] === slice[0];
        const output = compute(slice, isLast, sameSegment ? prevSeg.output : null);
        nextCache[k] = { input: slice, output, computedAsLast: isLast };
        for (let i = 0; i < output.length; i++) out.push(output[i]!);
        stats.recomputed++;
      }
      bucket.segments = nextCache;
      bucket.flat = out;
      return out;
    },
  };
}
