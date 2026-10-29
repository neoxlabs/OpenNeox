/* 聚光卡调度 —— 弹哪张、能不能弹。纯函数 + 一小块本地存储, 不碰 DOM。
 *
 *   「随机」但不能烦人, 规矩写死在这里:
 *     · 装好后的第一段时间 (FIRST_RUN_GRACE_MS) 不弹 —— 人刚走完引导, 还在找北;
 *     · 两张卡之间至少隔 COOLDOWN_MS —— 一天最多一张;
 *     · 一张卡默认只出一次 (repeatAfterDays 另说);
 *     · 用户点了「不再提示」就全关。
 *   在符合条件的卡里按 weight 加权随机抽一张。
 *
 *   状态放 localStorage: 这是"这台机器上这个人看过哪些提示", 丢了最坏就是再看一遍, 不值得进主进程。
 */
import type { SpotlightCardDef, SpotlightContext } from './spotlightCards';

export const COOLDOWN_MS = 20 * 60 * 60 * 1000;
export const FIRST_RUN_GRACE_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'neox.spotlight.v1';

export interface SpotlightState {
  /** 第一次见到调度器的时间 —— 近似"装好的时间" */
  firstSeenAt: number;
  /** 上一次弹卡 */
  lastShownAt: number;
  seen: Record<string, number>;
  /** 用户选了不再提示 */
  off: boolean;
}

export function emptyState(now: number): SpotlightState {
  return { firstSeenAt: now, lastShownAt: 0, seen: {}, off: false };
}

export function isCardEligible(card: SpotlightCardDef, state: SpotlightState, ctx: SpotlightContext): boolean {
  const last = state.seen[card.id];
  if (last) {
    if (!card.repeatAfterDays) return false;
    if (ctx.now - last < card.repeatAfterDays * DAY_MS) return false;
  }
  if (card.startsAt && ctx.now < Date.parse(card.startsAt)) return false;
  if (card.endsAt && ctx.now > Date.parse(card.endsAt)) return false;
  if (card.when && !card.when(ctx)) return false;
  return true;
}

/** 这一刻该不该弹、弹哪张。不该弹就是 null。rand 注入只为测试。 */
export function pickSpotlight(
  cards: SpotlightCardDef[],
  state: SpotlightState,
  ctx: SpotlightContext,
  rand: () => number = Math.random,
): SpotlightCardDef | null {
  if (state.off) return null;
  if (!ctx.modelReady) return null;
  if (ctx.now - state.firstSeenAt < FIRST_RUN_GRACE_MS) return null;
  if (state.lastShownAt && ctx.now - state.lastShownAt < COOLDOWN_MS) return null;
  const pool = cards.filter((c) => isCardEligible(c, state, ctx));
  if (pool.length === 0) return null;
  const total = pool.reduce((n, c) => n + Math.max(0, c.weight ?? 1), 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const c of pool) {
    r -= Math.max(0, c.weight ?? 1);
    if (r < 0) return c;
  }
  return pool[pool.length - 1];
}

export function markShown(state: SpotlightState, id: string, now: number): SpotlightState {
  return { ...state, lastShownAt: now, seen: { ...state.seen, [id]: now } };
}

export function loadSpotlightState(now: number): SpotlightState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SpotlightState>;
      return {
        firstSeenAt: typeof s.firstSeenAt === 'number' ? s.firstSeenAt : now,
        lastShownAt: typeof s.lastShownAt === 'number' ? s.lastShownAt : 0,
        seen: s.seen && typeof s.seen === 'object' ? s.seen : {},
        off: s.off === true,
      };
    }
  } catch { /* 读不到就当第一次 */ }
  const fresh = emptyState(now);
  saveSpotlightState(fresh);
  return fresh;
}

export function saveSpotlightState(state: SpotlightState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 存不下就下次再看一遍 */ }
}
