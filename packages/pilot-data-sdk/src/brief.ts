/**
 * 早报 (pilot:P-01): 每天 08:00 前后 5 分钟内到, 最多三件。
 *
 * 服务端每分钟问一次「该发了吗」(与触发引擎同一个 now = 本地 day + time), 客户端页面显示
 * 同一个钟点。归口在这里, 免得 8:00 / 3 件 / ±5 分钟各写一份。
 *
 * 内容怎么挑不在这里: 见 triggers.ts 的 composeBrief (今天的事 → 夜里攒下的 → 洞察, 封顶三件)。
 */
import { minutesOfDay } from './quietHours.js';

export const BRIEF_DEFAULT_TIME = '08:00';
/** 验收口径: 8:00 ±5 分钟都算准点 */
export const BRIEF_ON_TIME_MINUTES = 5;
export const BRIEF_MAX_ITEMS = 3;
/** 错过太久就不补发 (跟 pilot:P-10 同一口径), 免得下午收到早上的早报 */
export const BRIEF_CATCH_UP_MINUTES = 180;

/** 档案 pilot.brief = 'off' 才算关 (没写过 = 开) */
export function briefEnabled(facts: Record<string, unknown>): boolean {
  return facts['pilot.brief'] !== 'off';
}

/** 档案 pilot.brief_time 可改钟点; 写坏了退回 08:00 */
export function briefTimeOf(facts: Record<string, unknown>): string {
  const t = facts['pilot.brief_time'];
  return typeof t === 'string' && minutesOfDay(t) !== null ? t.trim() : BRIEF_DEFAULT_TIME;
}

export type BriefNow = { day: string; time: string };

/**
 * 此刻该不该发: 开着 + 今天还没发过 + 到点 + 没超过补发期限。
 * lastSentDay 是上一次发出去的本地日期 ('YYYY-MM-DD'), 由调用方按 trigger_runs 去重。
 */
export function briefDue(p: {
  facts: Record<string, unknown>;
  now: BriefNow;
  lastSentDay?: string | null;
}): boolean {
  if (!briefEnabled(p.facts)) return false;
  if (p.lastSentDay && p.lastSentDay === p.now.day) return false;
  const at = minutesOfDay(briefTimeOf(p.facts));
  const cur = minutesOfDay(p.now.time);
  if (at === null || cur === null) return false;
  const late = cur - at;
  return late >= 0 && late <= BRIEF_CATCH_UP_MINUTES;
}

/** 到达时间算不算准点 (8:00 ±5 分钟) */
export function briefOnTime(facts: Record<string, unknown>, sentTime: string): boolean {
  const at = minutesOfDay(briefTimeOf(facts));
  const cur = minutesOfDay(sentTime);
  if (at === null || cur === null) return false;
  const late = cur - at;
  return late >= -BRIEF_ON_TIME_MINUTES && late <= BRIEF_ON_TIME_MINUTES;
}

/** 下一次该发的本地「日期 钟点」, 用于自动化页 / 服务端排期 */
export function nextBriefAt(p: { facts: Record<string, unknown>; now: BriefNow }): string | null {
  if (!briefEnabled(p.facts)) return null;
  const at = minutesOfDay(briefTimeOf(p.facts));
  const cur = minutesOfDay(p.now.time);
  if (at === null || cur === null) return null;
  /* 今天还没过点就是今天, 否则明天 */
  const next = new Date(`${p.now.day}T00:00:00Z`);
  if (cur >= at) next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)} ${briefTimeOf(p.facts)}`;
}
