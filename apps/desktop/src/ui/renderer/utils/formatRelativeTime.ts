import { getGlobalLanguage } from '../hooks/useI18n';

type RelLang = 'zh' | 'en';

export function formatRelativeTime(
  input: number | string | null | undefined,
  lang?: RelLang,
): string {
  if (input === null || input === undefined || input === '') return '';
  const t = typeof input === 'number' ? input : Date.parse(input);
  if (!t || Number.isNaN(t)) return '';
  const zh = (lang ?? getGlobalLanguage()) !== 'en';
  const now = Date.now();
  const rawDiff = now - t;
  /* 未来时间 (提醒 scheduledAt 常见) 走"N 后"分支, 别再用 max(0,...) 把未来一律显示 "刚刚".
   * scheduled reminder 卡曾经全显 "刚刚" 让用户误以为提醒已触发. */
  if (rawDiff < 0) {
    const sec = Math.floor(-rawDiff / 1000);
    if (sec < 60) return zh ? '马上' : 'soon';
    const min = Math.floor(sec / 60);
    if (min < 60) return zh ? `${min}分后` : `in ${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return zh ? `${hr}小时后` : `in ${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return zh ? `${day}天后` : `in ${day}d`;
    const wk = Math.floor(day / 7);
    if (wk < 4) return zh ? `${wk}周后` : `in ${wk}w`;
    const mo = Math.max(1, Math.floor(day / 30));
    if (mo < 12) return zh ? `${mo}月后` : `in ${mo}mo`;
    return zh ? `${Math.floor(day / 365)}年后` : `in ${Math.floor(day / 365)}y`;
  }
  const sec = Math.floor(rawDiff / 1000);
  if (sec < 60) return zh ? '刚刚' : 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return zh ? `${min}分` : `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return zh ? `${hr}小时` : `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return zh ? `${day}天` : `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 4) return zh ? `${wk}周` : `${wk}w`;
  const mo = Math.max(1, Math.floor(day / 30));
  if (mo < 12) return zh ? `${mo}月` : `${mo}mo`;
  const yr = Math.floor(day / 365);
  return zh ? `${yr}年` : `${yr}y`;
}
