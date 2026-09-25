/**
 * Jev 预判工具包的编排: 什么时候问、结果什么时候用。纯判定逻辑在 jevToolPreload.ts。
 *
 * ## 时机决定一切
 * 工具必须在**第一次请求**里就在: 结果在发出后 ~1.1s 才到的话, 模型第一步已经 tool_search 了,
 * 晚到一步等于白判, 还多一次工具集变动。
 * 而同步等它又要给每条消息的首字加 0.5–1s。所以:
 *   1. 桌面端打字期间就节流地用草稿去问 (prefetch), 结果按文本缓存。
 *   2. 本轮开始按「全文 → 打字途中的前缀 → 现问」取用, 见 beginTurn。
 *   3. 没有草稿预判 (CLI / 粘贴即发) → 现发, 不等; 晚到的结果 promote 进本轮 (runner 下一次
 *      迭代看得到) 并入账, 之后的轮次就在第一次请求里了。
 * 不能只在停顿 400ms 后问一次: 按发送时 Jev (冷连接 1.1–1.6s) 还没回来, 白等宽限。
 */
import type { ToolPack } from '../../tools/packs/toolPack.js';
import { askJev, readJevSettings, type JevSettings } from './jevClient.js';
import {
  CHAT_ONLY_QUESTION_ID,
  JevPreloadLedger,
  buildChatOnlyQuestion,
  buildPackQuestions,
  buildPreloadState,
  candidatePacks,
  chatOnlyProbability,
  namesForPicks,
  pickPacks,
  topScores,
  type PackPick,
} from './jevToolPreload.js';

/** 单次请求上限; 晚到的结果照样入账给下一轮。 */
const REQUEST_TIMEOUT_MS = 5000;
/** 草稿预判还在飞时, 发送后最多再等这么久 (网络 p50 ~500ms, 打字停顿通常已经盖掉大半)。 */
export const PREFETCH_GRACE_MS = 300;
const MIN_TEXT_LEN = 2;
const MAX_CACHED_TEXTS = 16;
/** 离最近一次请求不到这么久, 连接还热着 (空闲 ~5s 冷掉, 留余量) */
const WARM_IDLE_MS = 3000;
/** 超过这么久没请求, 连接已经冷了, 预热要连发两个 */
const COLD_AFTER_MS = 5000;
/** 打字途中的前缀预判至少覆盖全文这么多, 才拿来当本轮的预判。 */
const PREFIX_MIN_COVERAGE = 0.5;

interface Prediction {
  picks: PackPick[];
  packs: ToolPack[];
  /** 纯聊天的概率 (同一请求里的 chat_only 题), 见 jevToolPreload CHAT_ONLY_THRESHOLD */
  chatOnly: number | null;
}

interface Slot {
  promise: Promise<Prediction | null>;
  settled: boolean;
  value: Prediction | null;
}

export interface JevToolPreloaderDeps {
  getPacks: () => ToolPack[];
  alwaysActive: ReadonlySet<string>;
  log: (event: string, data: Record<string, unknown>) => void;
  info: (message: string) => void;
}

export interface TurnPreload {
  /** 建工具树前 promote: 账上的 + 本轮已到手的预判, 按入账顺序。 */
  preload: readonly string[];
  /** 本轮预判晚到时的新增工具名 (已入账), 由调用方 promote 进本轮工具树。 */
  late: Promise<string[]> | null;
  /**
   * 这句话是纯聊天的概率 —— 只取**同一段全文**已经到手的预判。前缀不算 (「你好」之后
   * 可能跟着「帮我修个 bug」), 晚到的也不等: 拿不到就是 null, 调用方按满档走。
   */
  chatOnly: number | null;
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');

export class JevToolPreloader {
  private readonly ledger = new JevPreloadLedger();
  private readonly byText = new Map<string, Slot>();
  private draftInFlight = false;
  private queuedDraft: string | null = null;
  /** 最近一次跟 Jev 有来往的时间 —— 3s 内连接还热, 不用再预热 */
  private lastActivityAt = 0;

  constructor(private readonly deps: JevToolPreloaderDeps) {}

  /**
   * 输入框草稿预判 (打字期间节流地一直发)。没开 Jev / 太短 / 同一段已问过 → 什么都不做。
   * 同时只飞一个: 在飞时只记下最新草稿, 回来再发 —— 串行才能一直复用同一条热连接
   * (冷连接首包 1.3–3.4s, 热连接 0.4–0.55s)。
   */
  prefetch(text: string): void {
    const key = normalize(text);
    if (key.length < MIN_TEXT_LEN) {
      if (key.length > 0) this.warm();
      return;
    }
    if (this.byText.has(key)) return;
    if (this.draftInFlight) {
      this.queuedDraft = key;
      return;
    }
    const settings = this.settings();
    if (!settings) return;
    this.draftInFlight = true;
    void this.start(key, settings, 'draft').promise.then(() => this.drainDraftQueue());
  }

  /**
   * 刚开始打字就先把连接热起来。新连接上前两个请求 1.0–1.7s, 之后 ~0.4s, 空闲 ~5s 又冷掉;
   * 两个几乎不花钱的小请求就能热起来 (之后整包预判 0.38–0.42s)。不然短句打完时,
   * 预判还卡在冷连接的第二个请求上, 只能晚到。
   */
  private warm(): void {
    const idle = Date.now() - this.lastActivityAt;
    if (this.draftInFlight || idle < WARM_IDLE_MS) return;
    const settings = this.settings();
    if (!settings) return;
    this.draftInFlight = true;
    this.lastActivityAt = Date.now();
    const ping = () => askJev(settings, { x: '' }, { warm: { type: 'noul', instructions: 'Is `x` empty?' } }, { timeoutMs: REQUEST_TIMEOUT_MS })
      .catch(() => null);
    /* 还热着 (输入框聚焦时的保温) 一个就够; 已经冷了要两个 */
    const warming = idle < COLD_AFTER_MS ? ping() : ping().then(ping);
    void warming.then(() => this.drainDraftQueue());
  }

  private drainDraftQueue(): void {
    this.draftInFlight = false;
    this.lastActivityAt = Date.now();
    const next = this.queuedDraft;
    this.queuedDraft = null;
    if (next) this.prefetch(next);
  }

  /**
   * 本轮开始时调用, 建工具树之前。`ask=false` (续跑 / 重试 / 无工具轮) 只照账返回, 不问 Jev。
   *
   * 取用顺序:
   *   1. 同一段文字的预判已到手 → 用; 还在飞 → 最多等 PREFETCH_GRACE_MS。
   *   2. 打字途中某段前缀的预判已到手 (覆盖一半以上) → 直接用, 不等; 全文再补问一次, 晚到补差。
   *      要用哪类工具通常前半句就定了 (「读一下 xx.xlsx…」), 用户按发送往往比最后一次预判快。
   *   3. 都没有 → 现问, 不等, 晚到补差。
   */
  async beginTurn(
    sessionId: string,
    prompt: string,
    available: ReadonlySet<string>,
    ask: boolean,
  ): Promise<TurnPreload> {
    /* 关掉就是关掉: 打字时缓存下的预判、账上的名字都不用 (否则关了开关照样按旧预判 promote) */
    const settings = this.settings();
    if (!settings) return { preload: [], late: null, chatOnly: null };
    const key = normalize(prompt);
    if (!ask || key.length < MIN_TEXT_LEN) return { preload: this.ledger.get(sessionId), late: null, chatOnly: null };
    const apply = (prediction: Prediction | null): string[] => {
      if (!prediction) return [];
      const names = namesForPicks(prediction.picks, prediction.packs, this.ledger.get(sessionId), available);
      return this.ledger.add(sessionId, names);
    };
    const lateFor = (slot: Slot): Promise<string[]> => slot.promise.then((prediction) => {
      const added = apply(prediction);
      this.deps.log('JEV_PRELOAD_APPLY', { sessionId, when: 'late', added });
      return added;
    });

    const exact = this.byText.get(key);
    if (exact && !exact.settled) {
      await Promise.race([exact.promise, new Promise((r) => setTimeout(r, PREFETCH_GRACE_MS))]);
    }
    if (exact?.settled) {
      const added = apply(exact.value);
      this.deps.log('JEV_PRELOAD_APPLY', { sessionId, when: 'prefetched', added });
      return { preload: this.ledger.get(sessionId), late: null, chatOnly: exact.value?.chatOnly ?? null };
    }

    const prefix = this.bestSettledPrefix(key);
    if (prefix) {
      const added = apply(prefix.value);
      this.deps.log('JEV_PRELOAD_APPLY', { sessionId, when: 'prefix', coverage: prefix.coverage, added });
    }
    const pending = exact ?? this.start(key, settings, 'turn');
    return { preload: this.ledger.get(sessionId), late: lateFor(pending), chatOnly: null };
  }

  /** 已到手、是 key 的前缀、且覆盖一半以上长度的预判里最长的那个。 */
  private bestSettledPrefix(key: string): { value: Prediction; coverage: number } | null {
    let best: { value: Prediction; coverage: number } | null = null;
    for (const [text, slot] of this.byText) {
      if (!slot.settled || !slot.value || !key.startsWith(text)) continue;
      const coverage = text.length / key.length;
      if (coverage >= PREFIX_MIN_COVERAGE && (!best || coverage > best.coverage)) {
        best = { value: slot.value, coverage: Math.round(coverage * 100) / 100 };
      }
    }
    return best;
  }

  /** 会话被 host 淘汰时清账。 */
  forget(sessionId: string): void {
    this.ledger.delete(sessionId);
  }

  private settings(): JevSettings | null {
    try {
      return readJevSettings();
    } catch {
      return null; /* 读盘失败 = 当没开 */
    }
  }

  private start(key: string, settings: JevSettings, source: 'draft' | 'turn'): Slot {
    const packs = candidatePacks(this.deps.getPacks(), this.deps.alwaysActive);
    const slot: Slot = { promise: Promise.resolve(null), settled: false, value: null };
    /* 纯聊天题跟工具包题同一个请求: 多题并行, 不多花一次往返 */
    const questions = { ...buildPackQuestions(packs), [CHAT_ONLY_QUESTION_ID]: buildChatOnlyQuestion() };
    slot.promise = askJev(settings, buildPreloadState(key), questions, { timeoutMs: REQUEST_TIMEOUT_MS })
        .then((result): Prediction => {
          const picks = pickPacks(result, packs);
          const top = topScores(result);
          const chatOnly = chatOnlyProbability(result);
          this.deps.log('JEV_PRELOAD', {
            source, ms: result.ms, model: result.model, inputTokens: result.inputTokens,
            candidates: packs.length, picks, top, chatOnly,
          });
          this.deps.info(`Jev 预判 (${source}) ${result.ms}ms: `
            + `${picks.length ? picks.map((p) => `${p.packId}(${p.p.toFixed(2)})`).join(', ') : '无'} · top ${top.join(' ')}`
            + ` · 纯聊天 ${chatOnly === null ? '?' : chatOnly.toFixed(2)}`);
          return { picks, packs, chatOnly };
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.log('JEV_PRELOAD', { source, error: message });
          this.deps.info(`Jev 预判失败, 照原路径: ${message}`);
          /* 失败的不留缓存 —— 同一段文字发送时再试一次 */
          this.byText.delete(key);
          return null;
        })
      .then((value) => {
        slot.settled = true;
        slot.value = value;
        this.lastActivityAt = Date.now();
        return value;
      });
    this.byText.set(key, slot);
    while (this.byText.size > MAX_CACHED_TEXTS) {
      const oldest = this.byText.keys().next().value;
      if (oldest === undefined) break;
      this.byText.delete(oldest);
    }
    return slot;
  }
}
