
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRASH_LIMITS } from './types.js';

type RateState = Record<string, number[]>;

export class RateLimiter {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): RateState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RateState;
    } catch {
      /* 首次 / 文件坏了 → 当空表, 不让限频把上报堵死 */
    }
    return {};
  }

  private write(state: RateState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(state), 'utf-8');
    } catch {
      /* 限频状态写不进去不该影响上报本身 */
    }
  }

  private recent(state: RateState, key: string, now: number): number[] {
    return (state[key] ?? []).filter((t) => now - t >= 0 && now - t < CRASH_LIMITS.dedupeWindowMs);
  }

  /** 这个 dedupeKey 现在还允许上报吗。 */
  shouldSend(key: string): boolean {
    const now = this.now();
    return this.recent(this.read(), key, now).length < CRASH_LIMITS.perDedupePerDay;
  }

  /** 记一次上报 (顺手清掉过期窗口的记录, 文件不会越滚越大)。 */
  record(key: string): void {
    const now = this.now();
    const state = this.read();
    const next: RateState = {};
    for (const [k, times] of Object.entries(state)) {
      if (!Array.isArray(times)) continue;
      const kept = times.filter((t) => typeof t === 'number' && now - t >= 0 && now - t < CRASH_LIMITS.dedupeWindowMs);
      if (kept.length) next[k] = kept;
    }
    next[key] = [...(next[key] ?? []), now];
    this.write(next);
  }
}
