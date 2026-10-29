import { describe, expect, test } from 'vitest';
import { mapTimelineEntries, __resetFormatClockCacheForTests } from '../mapTimeline';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

/** 老实现 — 逐行复刻, 作为对拍基准 */
function formatClockLegacy(ts: number, isZh: boolean): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const locale = isZh ? 'zh-CN' : 'en-US';
  const time = d.toLocaleTimeString(locale, isZh
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: 'numeric', minute: '2-digit', hour12: true });
  if (isToday) return time;
  const day = d.toLocaleDateString(locale, isZh ? { month: 'long', day: 'numeric' } : { weekday: 'long' });
  return `${day} ${time}`;
}

/* mapTimelineEntries 内部按 timestamp 排序, 返回顺序 ≠ 输入顺序 —
 * 逐条映射才能和输入一一对上。 */
function stampFor(ts: number): string | undefined {
  const entry = {
    id: 'e0', type: 'tool_call', toolName: 'read_file', title: 'read_file',
    detail: '/repo/f0.ts', timestamp: ts,
  } as TimelineEntry;
  const out = mapTimelineEntries([entry], '/repo')[0];
  if (!out) return undefined;
  return out.kind === 'message' ? out.timestamp : (out as { timestamp?: string }).timestamp;
}

function stampsFor(tsList: number[]): Array<string | undefined> {
  return tsList.map(stampFor);
}

describe('formatClock 缓存化后与老实现逐条等价', () => {
  test('今天 / 昨天 / 上周 / 去年 / 边界', () => {
    __resetFormatClockCacheForTests();
    const now = Date.now();
    const d = new Date(now);
    const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();

    const cases = [
      now,
      todayStart,                 // 今日零点整
      todayEnd - 1,               // 今日最后一毫秒
      todayStart - 1,             // 昨日最后一毫秒
      todayStart - 3600_000,      // 昨天
      now - 3 * 86400_000,        // 三天前
      now - 30 * 86400_000,       // 一个月前
      now - 400 * 86400_000,      // 去年
      todayStart + 13 * 3600_000, // 今天下午
    ];

    const isZh = true; /* 测试环境 getGlobalLanguage 默认 zh */
    const got = stampsFor(cases);
    const want = cases.map((ts) => formatClockLegacy(ts, isZh));
    expect(got).toEqual(want);
  });

  test('记忆缓存不串味: 同一 ts 反复映射结果稳定', () => {
    __resetFormatClockCacheForTests();
    const ts = Date.now() - 5 * 86400_000;
    const first = stampsFor([ts])[0];
    for (let i = 0; i < 50; i++) stampsFor([ts]);
    expect(stampsFor([ts])[0]).toBe(first);
    expect(first).toBe(formatClockLegacy(ts, true));
  });

  test('大批量: 200 个随机时间戳全等价', () => {
    __resetFormatClockCacheForTests();
    const base = Date.now() - 200 * 86400_000;
    const list = Array.from({ length: 200 }, (_, i) => base + i * 97 * 60_000);
    expect(stampsFor(list)).toEqual(list.map((ts) => formatClockLegacy(ts, true)));
  });
});
