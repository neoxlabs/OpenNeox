/**
 * 滑动窗口调度器 —— Deep Research 的并发执行引擎。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 调度器始终保持 K 个 worker 在飞；任务完成后立即收割结果、更新队列并补充 worker，
 * 填坑, 直到终止条件命中, 最后统一汇总。总 worker 数可以累计到几十个, 瞬时并发恒为 K。
 *
 * 滑动窗口避免波次模型等待整批完成，并使后续 worker 能看到已收割的结果。
 *
 * 这里**不碰模型、不碰网络**: 干活的是注入进来的 dispatch。调度逻辑因此可以脱离模型单测,
 * 也让 BYOK / 订阅两种模型来源的差异完全留在调用方。
 *
 * 硬规则全在代码里, 不在提示词里 —— 派几个、派到多深、什么时候停, 模型说了都不算。
 */

/** 一个待查的子问题 */
export interface SubQuestion {
  id: string;
  question: string;
  /** 从哪条线索来的 (根问题没有) */
  parentId?: string;
  /** 0 = 开局拆出来的; 每跟一条线索 +1 */
  depth: number;
  /** 为什么要查这个 —— 进 worker 提示词, 也方便复盘 */
  why?: string;
}

/** worker 干完一条子问题之后回传的东西。**正文不回传** —— 证据已经写进账本了。 */
export interface WorkerOutcome {
  subQuestionId: string;
  ok: boolean;
  /** 一句话结论 (进主上下文的就这一句) */
  summary: string;
  sourcesAdded: number;
  claimsAdded: number;
  /** 查的过程中冒出来的新线索 —— 调度器据此补队列 */
  followUps?: Array<{ question: string; why: string }>;
  error?: string;
}

export interface SchedulerLimits {
  /** 瞬时并发 K */
  concurrency: number;
  /** 总 worker 上限 —— 花出去的钱的硬顶 */
  maxWorkers: number;
  /** 线索能跟多深 */
  maxDepth: number;
  /** 墙钟预算 (ms) */
  wallClockMs: number;
}

/**
 * 规模档按查询复杂度分配 worker 数量、深度和预算。
 */
/* 墙钟预算按 worker 的实际执行时长设置，必须允许多个种子角度依次完成。 */
export const SCALE_PRESETS = {
  /** 查证一件事 */
  simple: { concurrency: 1, maxWorkers: 2, maxDepth: 0, wallClockMs: 6 * 60_000 },
  /** 几个东西对比 */
  compare: { concurrency: 3, maxWorkers: 8, maxDepth: 1, wallClockMs: 15 * 60_000 },
  /** 开放式深挖 */
  deep: { concurrency: 4, maxWorkers: 14, maxDepth: 1, wallClockMs: 25 * 60_000 },
} as const satisfies Record<string, SchedulerLimits>;

export type ScaleName = keyof typeof SCALE_PRESETS;

export interface SchedulerState {
  dispatched: number;
  completed: number;
  failed: number;
  queued: number;
  inFlight: number;
  elapsedMs: number;
}

export type StopReason =
  /** 队列空了, 没有新线索 —— 正常收敛 */
  | 'converged'
  /** 撞上总 worker 上限 */
  | 'worker-cap'
  /** 撞上墙钟预算 */
  | 'time-budget'
  /** 调用方叫停 (用户取消 / 外部 abort) */
  | 'aborted';

export interface SchedulerResult {
  outcomes: WorkerOutcome[];
  stopReason: StopReason;
  state: SchedulerState;
  /** 排队但没来得及查的 —— 报告里要如实说"还有 N 条没查", 不许假装查完了 */
  unexplored: SubQuestion[];
}

export interface SchedulerDeps {
  /** 真正干活的: 派一个 worker 去查这条子问题 */
  dispatch: (q: SubQuestion) => Promise<WorkerOutcome>;
  /** 每收割一条就回调一次 —— 用来实时更新看板 */
  onOutcome?: (outcome: WorkerOutcome, state: SchedulerState) => void;
  /**
   * gap 闸: 这条新线索值不值得进队列。默认全收 (去重之后)。
   * 调用方可以在这里接"已经有足够证据了就别查了"之类的判断。
   */
  admitFollowUp?: (candidate: { question: string; why: string; depth: number }, state: SchedulerState) => boolean;
  /**
   * 一条问题**进队列**就回调 —— 不是派出去才回调 (用户点的那件事)。
   *
   * 排队的问题也要出现在界面上；并发限制只约束同时运行的 worker。
   */
  onQueued?: (q: SubQuestion) => void;
  /** 外部取消 */
  signal?: { aborted: boolean };
  /** 测试注入 */
  now?: () => number;
}

const SEED_GRACE_FACTOR = 1.5;

/** 同一个问题换个说法不该查两遍 */
function questionKey(q: string): string {
  return q.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 跑一轮滑动窗口调研。
 *
 * 注意 dispatch **永远不会被 reject 影响整体**: 单个 worker 炸了算它这条失败,
 * 其余继续 —— 调研本来就是有的查得到有的查不到, 一条网络错误不该毁掉整轮。
 */
export async function runSlidingWindow(
  seeds: SubQuestion[],
  limits: SchedulerLimits,
  deps: SchedulerDeps,
): Promise<SchedulerResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  const queue: SubQuestion[] = [...seeds];
  const seen = new Set<string>(seeds.map((s) => questionKey(s.question)));
  const outcomes: WorkerOutcome[] = [];
  const inFlight = new Map<Promise<WorkerOutcome>, SubQuestion>();

  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  let stopReason: StopReason | null = null;
  let nextId = seeds.length + 1;

  const state = (): SchedulerState => ({
    dispatched, completed, failed,
    queued: queue.length,
    inFlight: inFlight.size,
    elapsedMs: now() - startedAt,
  });

  /** @param exemptFromClock 种子角度豁免墙钟 —— 见 fill() 里的说明 */
  const budgetHit = (exemptFromClock = false): StopReason | null => {
    if (deps.signal?.aborted) return 'aborted';
    const elapsed = now() - startedAt;
    /* 种子只豁免正常墙钟预算，仍受硬超时、总量限制和用户取消约束。 */
    const clockLimit = exemptFromClock ? limits.wallClockMs * SEED_GRACE_FACTOR : limits.wallClockMs;
    if (elapsed >= clockLimit) return 'time-budget';
    if (dispatched >= limits.maxWorkers) return 'worker-cap';
    return null;
  };

  const fill = () => {
    while (inFlight.size < limits.concurrency && queue.length > 0) {
      /* 每次填坑前重新看预算 —— 不许因为队列还有货就突破上限。
       *
       * 时间预算不应跳过种子角度；种子代表用户明确要求的研究方向，
       * 墙钟只砍 followUp (depth > 0); worker 总量和用户取消对种子照样有效 —— 那两条是
       * 花钱和意愿的硬顶, 不是"来不及"。 */
      const isSeed = queue[0]!.depth === 0;
      const hit = budgetHit(isSeed);
      if (hit) { if (!stopReason) stopReason = hit; return; }
      const q = queue.shift()!;
      dispatched += 1;
      /* dispatch 自己抛错也算这条失败, 不冒泡 */
      const p = deps.dispatch(q).catch((e: any): WorkerOutcome => ({
        subQuestionId: q.id,
        ok: false,
        summary: '',
        sourcesAdded: 0,
        claimsAdded: 0,
        error: e?.message ? String(e.message) : String(e),
      }));
      inFlight.set(p, q);
    }
  };

  fill();

  while (inFlight.size > 0) {
    /* 谁先回来就先收割 —— 这就是"滑动"的那一下 */
    const settled = await Promise.race(
      [...inFlight.keys()].map((p) => p.then((o) => ({ p, o }))),
    );
    const finished = inFlight.get(settled.p)!;
    inFlight.delete(settled.p);

    const outcome = settled.o;
    outcomes.push(outcome);
    if (outcome.ok) completed += 1; else failed += 1;
    deps.onOutcome?.(outcome, state());

    /* 收割到的新线索立刻进队列 —— 后面派出去的 worker 因此知道前面查到了什么 */
    const childDepth = finished.depth + 1;
    if (outcome.ok && childDepth <= limits.maxDepth) {
      for (const f of outcome.followUps ?? []) {
        const key = questionKey(f.question);
        if (!f.question.trim() || seen.has(key)) continue;
        if (deps.admitFollowUp && !deps.admitFollowUp({ ...f, depth: childDepth }, state())) continue;
        seen.add(key);
        const child: SubQuestion = {
          id: `Q${nextId++}`, question: f.question, why: f.why, depth: childDepth, parentId: finished.id,
        };
        queue.push(child);
        deps.onQueued?.(child);
      }
    }

    fill();
  }

  /* 被叫停优先于"队列空了": 停的那一刻队列可能正好是空的, 这时报 converged 等于
   * 把"用户叫停"说成"查完了"。 */
  if (!stopReason && deps.signal?.aborted) stopReason = 'aborted';
  if (!stopReason) stopReason = queue.length === 0 ? 'converged' : (budgetHit() ?? 'converged');

  return { outcomes, stopReason, state: state(), unexplored: queue };
}
