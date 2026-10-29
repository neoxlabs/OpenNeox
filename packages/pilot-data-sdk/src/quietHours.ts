
export type QuietHours = {
  enabled: boolean;
  /** 'HH:mm' 24 小时制, 含起点 */
  start: string;
  /** 'HH:mm' 24 小时制, 不含终点 */
  end: string;
};

export const QUIET_HOURS_START = '22:30';
export const QUIET_HOURS_END = '07:30';

/** 夜里不打扰是默认行为 —— 用户不用先去设置里找开关 */
export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  start: QUIET_HOURS_START,
  end: QUIET_HOURS_END,
};

/** 'HH:mm' → 当天第几分钟; 不合法返回 null */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 当天第几分钟 → 'HH:mm' */
export function formatMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Date → 本地 'HH:mm' */
export function hhmmOf(d: Date): string {
  return formatMinutes(d.getHours() * 60 + d.getMinutes());
}

/** 此刻在不在免打扰窗口里. start=end 视为全天; 支持跨零点. */
export function inQuietWindow(now: string | Date, q: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const cur = minutesOfDay(typeof now === 'string' ? now : hhmmOf(now));
  const s = minutesOfDay(q.start);
  const e = minutesOfDay(q.end);
  if (cur === null || s === null || e === null) return false;
  if (s === e) return true;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** 补全一份配置: 时间不合法就退回统一默认, 存盘的半份也能用 */
export function normalizeQuietHours(p?: Partial<QuietHours> | null): QuietHours {
  const s = minutesOfDay(p?.start ?? '');
  const e = minutesOfDay(p?.end ?? '');
  return {
    enabled: p?.enabled ?? DEFAULT_QUIET_HOURS.enabled,
    start: s === null ? DEFAULT_QUIET_HOURS.start : formatMinutes(s),
    end: e === null ? DEFAULT_QUIET_HOURS.end : formatMinutes(e),
  };
}
