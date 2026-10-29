
/** 多久以内的同名汇报算同一件事 */
export const DEDUPE_WINDOW_MS = 6 * 3600_000;

export interface DedupeCandidate {
  id: string;
  sessionId: string | null;
  status: string;
  title: string;
  at: number;
  lastAt?: number;
  answer?: string;
}

/** 只留字母数字和汉字, 小写 —— 标点、空格、全半角括号不影响判断 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 标题里的数 (阿拉伯 / 中文数字): 「第四杯」「第五杯」是两件事, 字面再像也不能并 */
function numbersIn(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+/g) ?? [];
}

const NUM = '[\\d零〇一二两三四五六七八九十百千万]+';
const ORDINAL = new RegExp(`第${NUM}|${NUM}(?:杯|次|轮|个|份|单|号|笔|张|台|件|位|条|项|天|周|月|期)`, 'g');
/** 序号类的数 (第N / N杯 / N次…) —— 区分"哪一件"的; 路径名里的数字 (shift-test3) 不算 */
function ordinalsIn(s: string): string[] {
  return (s.match(ORDINAL) ?? []).sort();
}

function numbersCovered(shorter: string[], longer: string[]): boolean {
  const pool = [...longer];
  for (const n of shorter) {
    const i = pool.indexOf(n);
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}

export function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const ns = numbersIn(short);
  const nl = numbersIn(long);
  /* 包含: 长的多出来的部分可以有数 (目录名), 但不能多出"第几件"——「拿铁下单成功」不吞「第五杯拿铁下单成功」 */
  if (short.length >= 4 && long.includes(short)) return ordinalsIn(short).join() === ordinalsIn(long).join();
  if (ns.length !== nl.length || !numbersCovered(ns, nl)) return false;
  let p = 0;
  while (p < short.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < short.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  if (p < 2 && x.length - p - s > 0 && y.length - p - s > 0) return false;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  for (const [g, n] of bx) overlap += Math.min(n, by.get(g) ?? 0);
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0);
  return total > 0 && (2 * overlap) / total >= 0.6;
}

export function findDuplicate<T extends DedupeCandidate>(
  list: T[],
  next: { sessionId: string | null; status: string; title: string },
  now: number = Date.now(),
): T | null {
  return list.find((r) =>
    r.sessionId === next.sessionId
    && r.status === next.status
    && now - (r.lastAt ?? r.at) <= DEDUPE_WINDOW_MS
    && !(r.status === 'blocked' && r.answer)
    && sameTitle(r.title, next.title),
  ) ?? null;
}
