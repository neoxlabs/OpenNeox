/** 把 [start, end] 区间按天展开成 ISO 日期字符串 */
export function enumerateDays(startISO, endISO) {
  const days = [];
  const end = new Date(endISO);
  for (let cursor = new Date(startISO); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

/** 月份键, 用于按月分桶 */
export function monthKey(dateISO) {
  const date = new Date(dateISO);
  return `${date.getFullYear()}-${date.getMonth()}`;
}
