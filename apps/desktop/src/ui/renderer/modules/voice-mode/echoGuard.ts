
const STRIP = /[\s\p{P}\p{S}]/gu;

function norm(s: string): string {
  return s.replace(STRIP, '').toLowerCase();
}

/** transcript 里被 source 中连续片段 (≥ minRun 字) 覆盖的字数占比 */
export function echoCoverage(transcript: string, source: string, minRun = 3): number {
  const t = norm(transcript);
  const s = norm(source);
  if (!t || !s) return 0;
  let covered = 0;
  let i = 0;
  while (i < t.length) {
    /* 从 i 起, 在 source 里能找到的最长前缀 */
    let len = 0;
    while (i + len < t.length && s.includes(t.slice(i, i + len + 1))) len += 1;
    if (len >= minRun) {
      covered += len;
      i += len;
    } else {
      i += 1;
    }
  }
  return covered / t.length;
}

export interface SpokenLine {
  text: string;
  at: number;
}

export function isLikelyEcho(
  transcript: string,
  recent: readonly SpokenLine[],
  now: number,
  opts: { windowMs?: number; threshold?: number } = {},
): boolean {
  const windowMs = opts.windowMs ?? 15_000;
  const threshold = opts.threshold ?? 0.6;
  if (norm(transcript).length < 4) return false;
  const joined = recent.filter((l) => now - l.at <= windowMs).map((l) => l.text).join('');
  if (!joined) return false;
  return echoCoverage(transcript, joined) >= threshold;
}
