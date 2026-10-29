
export type UsageRangeKind = '7d' | '30d' | 'custom';

export interface UsageRange {
  kind: UsageRangeKind;
  /** 'YYYY-MM-DD', 含当天 */
  startDay: string;
  /** 'YYYY-MM-DD', 含当天 */
  endDay: string;
  /** 闭区间天数, 至少 1 */
  days: number;
}

/** 本地时区的 YYYY-MM-DD —— 不能用 toISOString(), 那是 UTC, 会让东八区的今天变成昨天。 */
export function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 闭区间天数 —— 7/1 到 7/1 是 1 天, 不是 0 天。 */
export function daysBetween(startDay: string, endDay: string): number {
  const s = parseDayKey(startDay); const e = parseDayKey(endDay);
  if (!s || !e) return 1;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
}

export function presetRange(kind: '7d' | '30d'): UsageRange {
  const days = kind === '7d' ? 7 : 30;
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { kind, startDay: toDayKey(start), endDay: toDayKey(end), days };
}

/**
 * 自定义区间 —— 顺手把用户可能填反的两个日期正过来。
 *
 *   上限 366 天: 再长的窗口在这个尺寸的折线图里一天不到一个像素, 画出来是噪声不是信息;
 *   而且本地库按天聚合, 拉两年的数据只为了画一条糊线不划算。
 */
export const MAX_RANGE_DAYS = 366;

export function customRange(startDay: string, endDay: string): UsageRange | null {
  const s = parseDayKey(startDay); const e = parseDayKey(endDay);
  if (!s || !e) return null;
  const [lo, hi] = s.getTime() <= e.getTime() ? [s, e] : [e, s];
  /* 未来的日期没有数据, 夹到今天 —— 让用户选了也不至于看到一段空白 */
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hiClamped = hi.getTime() > today.getTime() ? today : hi;
  let loClamped = lo;
  const span = Math.round((hiClamped.getTime() - loClamped.getTime()) / 86_400_000) + 1;
  if (span > MAX_RANGE_DAYS) {
    loClamped = new Date(hiClamped.getTime() - (MAX_RANGE_DAYS - 1) * 86_400_000);
  }
  return {
    kind: 'custom',
    startDay: toDayKey(loClamped),
    endDay: toDayKey(hiClamped),
    days: daysBetween(toDayKey(loClamped), toDayKey(hiClamped)),
  };
}

/** 标题上那句话 —— 预设档说"近 N 天", 自定义档直接把区间摆出来。 */
export function rangeLabel(r: UsageRange, zh: boolean): string {
  if (r.kind === '7d') return zh ? '近 7 天' : 'Last 7 days';
  if (r.kind === '30d') return zh ? '近 30 天' : 'Last 30 days';
  const short = (k: string) => { const [, m, d] = k.split('-'); return `${Number(m)}/${Number(d)}`; };
  return `${short(r.startDay)} – ${short(r.endDay)}`;
}

/**
 * 把 getDailyUsage 拉回来的稀疏行裁到区间内并补齐缺失的天。
 *
 *   缺的那天必须补成 0 而不是跳过 —— 跳过会让折线把两个远端点直接连起来,
 *   视觉上假装中间一直在用 (UsageTrendChart 里原本就有同款 fillGaps, 这里抽出来共用)。
 */
export function sliceToRange<T extends { day: string }>(
  rows: T[],
  range: UsageRange,
  makeEmpty: (day: string) => T,
): T[] {
  const byDay = new Map(rows.map(r => [r.day, r]));
  const start = parseDayKey(range.startDay);
  if (!start) return [];
  const out: T[] = [];
  for (let i = 0; i < range.days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = toDayKey(d);
    out.push(byDay.get(key) ?? makeEmpty(key));
  }
  return out;
}
