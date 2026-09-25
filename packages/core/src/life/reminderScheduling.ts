/**
 * Reminder recurrence — 纯函数, 只算下一次触发时间.
 *
 * 从当前 fired 时间 + recurrence 规则 → 下一次 scheduled_at epoch ms;
 * 无下一次 (once / 已过 endsAt) → null. JobRunner 拿 null 就不建后续 event.
 *
 * 时间基准: 用户本地时区 (Date 各方法), cron/weekly spec 也按本地时区解释.
 * 不引三方库: 只支持简单 recurrence (once/daily/weekly/monthly); cron 表达式
 * 走已有的 cronTools.parseCronExpression / nextCronRunMs (5 段 cron).
 */

import type { ReminderRecurrence } from './lifeEventsTypes.js';
/* Use a static ESM import; cronTools does not depend on life modules, so this has no
 * cycle and keeps cron recurrence calculation available at runtime. */
import { nextCronRunMs } from '../tools/cronTools.js';

/**
 * 从 `from` (通常是本次 fired 时刻) 算下一次触发时间.
 *   - once      → null (一次性)
 *   - daily     → from + 24h
 *   - weekly    → 下一个匹配星期几 (spec 是 [0-6] 数组, 0=Sun, 1=Mon,...);
 *                 spec 空 → 视为 [周几(from)] (每周同一天)
 *   - monthly   → 下个月同一天; 目标月无同日 (2/30) → 该月最后一天
 *   - cron      → 交给 cronTools.nextCronRunMs (5 段 cron); spec 是 string
 * endsAt < 计算结果 → null (超期终止)
 */
export function computeNextFire(
  recurrence: ReminderRecurrence | null | undefined,
  from: number,
): number | null {
  if (!recurrence) return null;
  const { kind, spec, endsAt } = recurrence;
  let next: number | null = null;
  const d = new Date(from);

  switch (kind) {
    case 'once':
      return null;

    case 'daily':
      next = from + 86400_000;
      break;

    case 'weekly': {
      const daysArg = Array.isArray(spec) ? spec.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
      const wantedDays: number[] = daysArg.length > 0 ? [...new Set(daysArg)].sort() : [d.getDay()];
      /* 找下一个 wantedDays 中的日子 (至少 1 天后, 避免同日重发) */
      for (let addDays = 1; addDays <= 14; addDays++) {
        const cand = new Date(from);
        cand.setDate(cand.getDate() + addDays);
        if (wantedDays.includes(cand.getDay())) {
          /* 保持同一时刻 (h/m/s/ms) */
          cand.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
          next = cand.getTime();
          break;
        }
      }
      break;
    }

    case 'monthly': {
      const targetDay = d.getDate();
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
      /* 下月天数: setDate 到 0 = 上月最后一天; 这里我们要"下月天数" */
      const daysInNextMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
      nextMonth.setDate(Math.min(targetDay, daysInNextMonth));
      next = nextMonth.getTime();
      break;
    }

    case 'cron': {
      /* cron 表达式支持 5 段, 复用 cronTools 已有实现 (静态 import, 见文件头).
       * 不再 try/catch: nextCronRunMs 是纯函数, 表达式非法时它自己返回 null,
       * 真抛异常说明是代码 bug, 应该炸出来而不是被吞成"只响一次". */
      if (typeof spec !== 'string' || !spec.trim()) return null;
      next = nextCronRunMs(spec, from + 1000);
      break;
    }
  }

  if (next == null) return null;
  if (typeof endsAt === 'number' && endsAt > 0 && next > endsAt) return null;
  return next;
}

/**
 * 相对时间 → 绝对时间 epoch ms.
 *   支持:
 *     - ISO 8601 (T09:00:00 /)
 *     - "in N minutes" / "in N hours" / "in N days"
 *     - "tomorrow 9am" / "next Wednesday 20:00"
 *   不认识 → null (调用方兜底或让 agent 传更明确格式)
 *
 * 时间基准: 本地时区.
 */
export function parseWhen(when: string, now: number = Date.now()): number | null {
  if (!when || typeof when !== 'string') return null;
  const w = when.trim();

  /* ISO 8601 优先: 让 Date 直接解 */
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/.test(w)) {
    const t = new Date(w).getTime();
    return Number.isFinite(t) ? t : null;
  }

  /* "in N minutes/hours/days" */
  const inMatch = /^in\s+(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/i.exec(w);
  if (inMatch) {
    const n = parseFloat(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const mul: Record<string, number> = { second: 1000, minute: 60_000, hour: 3600_000, day: 86400_000, week: 7 * 86400_000 };
    return now + n * mul[unit];
  }

  /* "tomorrow 9am" / "tomorrow 09:00" / "tonight 8pm" */
  const dayMatch = /^(today|tonight|tomorrow)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(w);
  if (dayMatch) {
    const dayWord = dayMatch[1].toLowerCase();
    let h = parseInt(dayMatch[2], 10);
    const m = dayMatch[3] ? parseInt(dayMatch[3], 10) : 0;
    const ampm = dayMatch[4]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const d = new Date(now);
    if (dayWord === 'tomorrow') d.setDate(d.getDate() + 1);
    if (dayWord === 'tonight' && h < 6) h = 20; // "tonight" 默认 8pm 除非明说
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  /* "next Wednesday 20:00" / "next mon 9am" */
  const nextDayMatch = /^next\s+(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(w);
  if (nextDayMatch) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const target = days.indexOf(nextDayMatch[1].slice(0, 3).toLowerCase());
    if (target < 0) return null;
    let h = parseInt(nextDayMatch[2], 10);
    const m = nextDayMatch[3] ? parseInt(nextDayMatch[3], 10) : 0;
    const ampm = nextDayMatch[4]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const d = new Date(now);
    let addDays = (target - d.getDay() + 7) % 7;
    if (addDays === 0) addDays = 7;   // "next" 语义 = 至少 7 天后
    d.setDate(d.getDate() + addDays);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  /* 兜底: 交给 Date 解 (会认识 "Jan 5 2026 9am" 之类) */
  const t = Date.parse(w);
  return Number.isFinite(t) ? t : null;
}

/**
 * Boot 时策略: 过期 reminder 怎么处理.
 *   - 'fire'    (到期 <= graceMs): 正常触发, 不额外说明
 *   - 'overdue' (到期 >  graceMs): **仍然触发**, 但通知里必须写明"本该在 X 点响".
 *
 *  调整： 之前 'overdue' 被 JobRunner 直接 transition('dismissed') 静默丢弃 —
 * 用户设的提醒因为关机 6h+ 就当没发生过, 连"漏了"都不知道, 而且 recurring 提醒会
 * 就此断链 (dismissed 不走 computeNextFire). 现在 overdue 只是"迟到"标记, 不是"丢弃"。
 * graceMs 默认 6h.
 */
export const OVERDUE_GRACE_MS = 6 * 3600_000;
export function classifyOverdue(scheduledAt: number, now: number = Date.now(), graceMs: number = OVERDUE_GRACE_MS): 'fire' | 'overdue' {
  return (now - scheduledAt) > graceMs ? 'overdue' : 'fire';
}
