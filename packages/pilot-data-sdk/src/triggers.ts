import type { Insight } from './insights.js';
import { BRIEF_MAX_ITEMS } from './brief.js';
import { inQuietWindow } from './quietHours.js';

export type TriggerSpec = {
  /** 稳定 id: 记录 id, 或生日的 'birthday:<名>' */
  id: string;
  when: 'yearly' | 'date' | 'weekly';
  /** yearly 'MM-DD' / date 'YYYY-MM-DD' */
  date?: string;
  weekday?: number;
  /** 'HH:mm', 默认 09:00 */
  time?: string;
  text: string;
  leadDays?: number;
};

export type Occurrence = {
  /** trigger_runs 去重 key: '<id>|<本地日期>|day' 或 '|lead' */
  key: string;
  triggerId: string;
  /** 'day' = 正日子, 'lead' = 提前提醒 */
  phase: 'day' | 'lead';
  /** 通知上的那句话 */
  text: string;
};

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' 是周几 (1 周一 ~ 7 周日) */
export function isoWeekday(day: string): number {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 某时刻在某时区的本地日期和钟点 */
export function localParts(ms: number, tz: string): { day: string; time: string } {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function normTime(t: string | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? '').trim());
  return m ? `${pad(Math.min(23, Number(m[1])))}:${m[2]}` : '09:00';
}

/** 这一天是不是这条的正日子 */
function isDay(t: TriggerSpec, day: string): boolean {
  if (t.when === 'weekly') return isoWeekday(day) === t.weekday;
  if (t.when === 'yearly') return !!t.date && day.slice(5) === t.date.slice(-5);
  return t.date === day;
}

/**
 * 此刻 (本地 day + time) 该响的: 正日子或提前那天, 且钟点已过。
 * 一天之内过了点都算 —— 引擎停了几分钟 / 几小时回来也补上, 不会漏; 重复由调用方的 key 去重。
 */
export function dueOccurrences(triggers: TriggerSpec[], now: { day: string; time: string }): Occurrence[] {
  const out: Occurrence[] = [];
  for (const t of triggers) {
    if (!t.text?.trim()) continue;
    if (now.time < normTime(t.time)) continue;
    if (isDay(t, now.day)) {
      out.push({ key: `${t.id}|${now.day}|day`, triggerId: t.id, phase: 'day', text: t.text.trim() });
      continue;
    }
    const lead = t.when === 'weekly' ? 0 : Math.max(0, Math.min(60, t.leadDays ?? 0));
    if (lead > 0 && isDay(t, addDays(now.day, lead))) {
      out.push({ key: `${t.id}|${now.day}|lead`, triggerId: t.id, phase: 'lead', text: `还有 ${lead} 天：${t.text.trim()}` });
    }
  }
  return out;
}

/** 档案里的生日 → yearly 触发 (提前 3 天 + 当天上午 9 点) */
export function birthdayTriggers(facts: Record<string, unknown>): TriggerSpec[] {
  const out: TriggerSpec[] = [];
  for (const [k, v] of Object.entries(facts)) {
    const m = /^person\.(.+)\.birthday$/.exec(k);
    const d = typeof v === 'string' ? /(\d{1,2})-(\d{1,2})$/.exec(v.trim()) : null;
    if (!m || !d) continue;
    out.push({ id: `birthday:${m[1]}`, when: 'yearly', date: `${pad(Number(d[1]))}-${pad(Number(d[2]))}`, time: '09:00', leadDays: 3, text: `${m[1]}生日` });
  }
  return out;
}

/** 记录里的 trigger → TriggerSpec (地点 / 人类的跳过) */
export function triggerSpecOf(id: string, data: Record<string, unknown>): TriggerSpec | null {
  if (data.paused === true) return null;
  const when = data.when;
  if (when !== 'yearly' && when !== 'date' && when !== 'weekly') return null;
  return {
    id, when,
    date: typeof data.date === 'string' ? data.date : undefined,
    weekday: typeof data.weekday === 'number' ? data.weekday : undefined,
    time: typeof data.time === 'string' ? data.time : undefined,
    text: String(data.text ?? ''),
    leadDays: typeof data.leadDays === 'number' ? data.leadDays : undefined,
  };
}

/** 免打扰: 22:30 ~ 7:30 响的先攒着, 进早上的简报 (默认值见 quietHours.ts) */
export function inQuietHours(time: string): boolean {
  return inQuietWindow(time);
}

export type Brief = { title: string; body: string; items: string[] };

/**
 * 晨间简报: 一条通知说清今天。顺序 = 今天的事 (触发) → 夜里攒下的 → 它发现的 (要留神的在前), 最多三件。
 * 什么都没有就返回 null —— 没事不打扰。
 */
export function composeBrief(p: { today: string[]; deferred: string[]; insights: Insight[] }): Brief | null {
  const items: string[] = [];
  const push = (s: string) => { const t = s.trim(); if (t && !items.includes(t)) items.push(t); };
  for (const s of p.today) push(s);
  for (const s of p.deferred) push(s);
  /* 要留神的加一点分, 但分很低的「留神」压不过三天后的生日 */
  const rank = (i: Insight) => i.score + (i.tone === 'watch' ? 0.15 : 0);
  const ranked = [...p.insights].sort((a, b) => rank(b) - rank(a));
  for (const i of ranked) {
    if (items.length >= BRIEF_MAX_ITEMS) break;
    /* 「知道一下」的不进简报 */
    if (i.tone === 'info' && !i.action) continue;
    push(i.title);
  }
  const top = items.slice(0, BRIEF_MAX_ITEMS);
  if (!top.length) return null;
  return { title: top.length === 1 ? '早上好 · 今天一件事' : `早上好 · 今天 ${top.length} 件事`, body: top.join('；'), items: top };
}
