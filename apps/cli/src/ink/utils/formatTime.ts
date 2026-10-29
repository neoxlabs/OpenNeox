/**
 * Format timestamp with milliseconds for better ordering
 *
 * @param date Date object to format
 * @returns Formatted time string with milliseconds (HH:MM:SS.mmm)
 */
export function formatTime(date?: Date): string {
  const d = date || new Date();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}
