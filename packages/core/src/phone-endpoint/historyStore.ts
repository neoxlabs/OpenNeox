import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HistoryEvent } from './sessionEventTranslator.js';

export interface PhoneHistoryStore {
  /** 读出已落盘的历史 (旧 → 新) */
  load(): HistoryEvent[];
  /** 追加一条 (调用方保证 seq 递增) */
  append(e: HistoryEvent): void;
}

/** 跟 SessionEventTranslator 的内存上限一致 */
export const MAX_PERSISTED_EVENTS = 2000;

export class FilePhoneHistoryStore implements PhoneHistoryStore {
  private count = 0;

  constructor(private readonly filePath: string) {}

  load(): HistoryEvent[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const out: HistoryEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (typeof e?.seq !== 'number' || typeof e?.kind !== 'string') continue;
          if (!e.payload || typeof e.payload !== 'object') continue;
          out.push({
            seq: e.seq,
            ts: typeof e.ts === 'number' ? e.ts : 0,
            kind: e.kind,
            payload: e.payload,
          });
        } catch { /* 半行 (写到一半断电) 丢掉, 其余照读 */ }
      }
      this.count = out.length;
      return out.slice(-MAX_PERSISTED_EVENTS);
    } catch {
      this.count = 0;
      return [];
    }
  }

  append(e: HistoryEvent): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.filePath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
      this.count++;
      if (this.count > MAX_PERSISTED_EVENTS * 2) this.trim();
    } catch { /* 落盘失败不影响当前这一轮 */ }
  }

  private trim(): void {
    try {
      const keep = this.load().slice(-MAX_PERSISTED_EVENTS);
      const body = keep.map((e) => `${JSON.stringify(e)}\n`).join('');
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.count = keep.length;
    } catch { /* 下次 append 再试 */ }
  }
}
