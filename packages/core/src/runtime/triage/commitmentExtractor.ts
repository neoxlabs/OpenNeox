import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type CommitmentKind = 'follow_up' | 'reminder' | 'monitoring' | 'wait_reply' | 'periodic_check';

export interface CommitmentRecord {
  id: string;
  kind: CommitmentKind;
  summary: string;
  confidence: number;
  sourceText: string;
  dueAt?: number;
  intervalMs?: number;
  createdAt: number;
}

export interface CommitmentScheduleResolution {
  dueAt?: number;
  intervalMs?: number;
}

const CHINESE_NUM_MAP: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseChineseNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.includes('十')) {
    const [head, tail] = raw.split('十');
    const tens = head ? (CHINESE_NUM_MAP[head] || 0) : 1;
    const ones = tail ? (CHINESE_NUM_MAP[tail] || 0) : 0;
    return tens * 10 + ones;
  }
  return raw.split('').reduce((sum, char) => sum * 10 + (CHINESE_NUM_MAP[char] || 0), 0);
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function applyClock(base: Date, hour: number, minute: number): Date {
  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([零一二三四五六七八九十两\d]{1,3})点(半|([零一二三四五六七八九十两\d]{1,3})分?)?/);
  if (!match) return null;

  const period = match[1] || '';
  let hour = parseChineseNumber(match[2]);
  const minute = match[3] === '半' ? 30 : match[4] ? parseChineseNumber(match[4]) : 0;

  if ((period === '下午' || period === '晚上' || period === '傍晚') && hour < 12) {
    hour += 12;
  } else if (period === '中午' && hour < 11) {
    hour += 12;
  } else if (period === '凌晨' && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function resolveWeekday(base: Date, targetDay: number, prefix?: string, clockText?: string): number {
  const currentDay = base.getDay();
  let delta = (targetDay - currentDay + 7) % 7;

  if (prefix === '下') {
    delta = delta === 0 ? 7 : delta + 7;
  } else if (!prefix && delta === 0) {
    delta = 7;
  }

  const target = addDays(base, delta);
  const clock = clockText ? parseClock(clockText) : null;
  return clock ? applyClock(target, clock.hour, clock.minute).getTime() : target.getTime();
}

function resolveMonthEnd(base: Date, clockText?: string): number {
  const target = new Date(base.getFullYear(), base.getMonth() + 1, 0, base.getHours(), base.getMinutes(), 0, 0);
  const clock = clockText ? parseClock(clockText) : null;
  return clock ? applyClock(target, clock.hour, clock.minute).getTime() : target.getTime();
}

function hasScheduleHint(text: string): boolean {
  return /(明天|后天|下周|下个月|月初|周[一二三四五六日天]|星期[一二三四五六日天]|月底|月末|[零一二三四五六七八九十两\d]+\s*(分钟|小时|天)后|每天|每周|凌晨|早上|上午|中午|下午|傍晚|晚上|\d+点)/i.test(text);
}

export function parseCommitmentSchedule(text: string, now = Date.now()): CommitmentScheduleResolution {
  const current = new Date(now);
  const lowerText = text.toLowerCase();
  const clock = parseClock(text);

  const delayMatch = text.match(/([零一二三四五六七八九十两\d]+)\s*(分钟|小时|天)后/);
  if (delayMatch) {
    const amount = parseChineseNumber(delayMatch[1]);
    const unit = delayMatch[2];
    const unitMs = unit === '分钟' ? 60_000 : unit === '小时' ? 3_600_000 : 86_400_000;
    const delayed = new Date(now + amount * unitMs);
    if (unit === '天' && clock) {
      return { dueAt: applyClock(delayed, clock.hour, clock.minute).getTime() };
    }
    return { dueAt: delayed.getTime() };
  }

  if (text.includes('明天')) {
    const target = addDays(current, 1);
    return { dueAt: clock ? applyClock(target, clock.hour, clock.minute).getTime() : target.getTime() };
  }

  if (text.includes('后天')) {
    const target = addDays(current, 2);
    return { dueAt: clock ? applyClock(target, clock.hour, clock.minute).getTime() : target.getTime() };
  }

  const weekdayMatch = text.match(/(这|本|下)?(?:周|星期)([一二三四五六日天])/);
  if (weekdayMatch) {
    const dayMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    return {
      dueAt: resolveWeekday(current, dayMap[weekdayMatch[2]], weekdayMatch[1], clock ? `${clock.hour}点${clock.minute ? `${clock.minute}分` : ''}` : text),
    };
  }

  if (text.includes('月底') || text.includes('月末')) {
    return { dueAt: resolveMonthEnd(current, clock ? `${clock.hour}点${clock.minute ? `${clock.minute}分` : ''}` : text) };
  }

  if (lowerText.includes('every day') || text.includes('每天')) {
    const intervalMs = 86_400_000;
    const next = addDays(current, 1);
    return { intervalMs, dueAt: clock ? applyClock(next, clock.hour, clock.minute).getTime() : now + intervalMs };
  }

  if (lowerText.includes('every week') || text.includes('每周')) {
    const intervalMs = 7 * 86_400_000;
    const next = addDays(current, 7);
    return { intervalMs, dueAt: clock ? applyClock(next, clock.hour, clock.minute).getTime() : now + intervalMs };
  }

  return {};
}

const patterns: Array<{ kind: CommitmentKind; regex: RegExp; summary: (text: string) => string; confidence: number }> = [
  {
    kind: 'periodic_check',
    regex: /(每天|每周|定期|周期|按时|定时).*(提醒|检查|跟进|看看)|提醒我.*(每天|每周|定时)/i,
    summary: (text) => `周期性跟进：${text.trim()}`,
    confidence: 0.92,
  },
  {
    kind: 'monitoring',
    regex: /(持续|长期|一直|帮我盯|监控|观察|watch|monitor|track)/i,
    summary: (text) => `持续观察：${text.trim()}`,
    confidence: 0.88,
  },
  {
    kind: 'wait_reply',
    regex: /(等.*回复|跟进.*回复|有人回我|有没有回复)/i,
    summary: (text) => `等待外部回复并跟进：${text.trim()}`,
    confidence: 0.84,
  },
  {
    kind: 'reminder',
    regex: /(提醒我|记得提醒|别忘了提醒)/i,
    summary: (text) => `提醒事项：${text.trim()}`,
    confidence: 0.86,
  },
  {
    kind: 'follow_up',
    regex: /(跟进|后面再看|之后再看|晚点提醒|记着这件事)/i,
    summary: (text) => `后续跟进：${text.trim()}`,
    confidence: 0.78,
  },
];

export class CommitmentExtractor {
  extract(text: string, now = Date.now()): CommitmentRecord | null {
    const normalized = text.trim();
    if (!normalized) return null;
    const schedule = parseCommitmentSchedule(normalized, now);

    for (const rule of patterns) {
      if (rule.regex.test(normalized)) {
        return {
          id: `commitment-${Date.now()}`,
          kind: rule.kind,
          summary: rule.summary(normalized),
          confidence: rule.confidence,
          sourceText: normalized,
          ...schedule,
          createdAt: Date.now(),
        };
      }
    }

    return null;
  }

  async extractAsync(input: {
    text: string;
    now?: number;
    scheduleResolver?: (text: string, now: number) => Promise<CommitmentScheduleResolution | null>;
  }): Promise<CommitmentRecord | null> {
    const now = input.now ?? Date.now();
    const base = this.extract(input.text, now);
    if (!base) return null;
    if ((base.dueAt || base.intervalMs) || !input.scheduleResolver || !hasScheduleHint(input.text)) {
      return base;
    }

    const resolved = await input.scheduleResolver(input.text, now).catch(err => { cliLogger.debug('COMMITMENT', `Schedule resolve failed: ${err?.message}`); return null; });
    if (!resolved) return base;
    return {
      ...base,
      dueAt: resolved.dueAt ?? base.dueAt,
      intervalMs: resolved.intervalMs ?? base.intervalMs,
    };
  }
}
