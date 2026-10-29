
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CRASH_LIMITS, type CrashReportPayload } from './types.js';

export interface QueuedCrashReport {
  file: string;
  enqueuedAt: number;
  report: CrashReportPayload;
}

/** 文件名前缀就是入队时间 —— 排序和过期都靠它, 不依赖 mtime (测试里可注入时间)。 */
function enqueuedAtFromName(name: string): number | null {
  const m = /^(\d{10,16})-[0-9a-f]+\.json$/.exec(name);
  return m ? Number(m[1]) : null;
}

export class CrashQueue {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 落一条待发。返回文件名 (便于测试), 失败返回 null。 */
  enqueue(report: CrashReportPayload): string | null {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const at = this.now();
      const file = path.join(this.dir, `${at}-${randomUUID().slice(0, 8)}.json`);
      fs.writeFileSync(file, JSON.stringify({ enqueuedAt: at, report }), 'utf-8');
      this.prune();
      return file;
    } catch {
      return null;
    }
  }

  /** 按入队时间从旧到新列出。坏文件直接删掉 (留着也发不出去)。 */
  list(): QueuedCrashReport[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const rows: QueuedCrashReport[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const at = enqueuedAtFromName(name);
      if (at === null) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed?.report && typeof parsed.report === 'object') {
          rows.push({ file, enqueuedAt: at, report: parsed.report as CrashReportPayload });
        } else {
          this.remove(file);
        }
      } catch {
        this.remove(file);
      }
    }
    return rows.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  remove(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 已经被删 / 无权限 */
    }
  }

  /** 清过期 (7 天) 与超量 (50 条, 删最旧)。 */
  prune(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    const now = this.now();
    const keep: Array<{ name: string; at: number }> = [];
    for (const name of names) {
      const at = enqueuedAtFromName(name);
      if (at === null) {
        this.remove(path.join(this.dir, name));
        continue;
      }
      if (now - at > CRASH_LIMITS.queueTtlMs) {
        this.remove(path.join(this.dir, name));
        continue;
      }
      keep.push({ name, at });
    }
    keep.sort((a, b) => a.at - b.at);
    const overflow = keep.length - CRASH_LIMITS.queueMaxFiles;
    for (let i = 0; i < overflow; i++) this.remove(path.join(this.dir, keep[i].name));
  }
}
