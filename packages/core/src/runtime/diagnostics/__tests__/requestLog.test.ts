import { describe, expect, it } from 'vitest';
import { classifyCacheBreak, summarizeRequests, type RequestRecord } from '../requestLog.js';

describe('classifyCacheBreak', () => {
  it('系统提示 > 工具表 > 历史改写 > 过期 > 上游没命中', () => {
    expect(classifyCacheBreak({ systemChanged: true, toolsChanged: true, sysDiff: { curSnip: 'time: 10:05' } }, 0))
      .toEqual({ code: 'system', detail: 'time: 10:05' });
    expect(classifyCacheBreak({ toolsChanged: true, firstDivergentMsgIdx: 3 }, 0).code).toBe('tools');
    expect(classifyCacheBreak({ firstDivergentMsgIdx: 4, divergentRole: 'user' }, 0)).toEqual({ code: 'history', detail: '#4 user' });
    expect(classifyCacheBreak({ firstDivergentMsgIdx: -1 }, 12 * 60_000)).toEqual({ code: 'expired', detail: '12m' });
    expect(classifyCacheBreak({ firstDivergentMsgIdx: -1 }, 30_000).code).toBe('upstream');
    expect(classifyCacheBreak(undefined, 30_000).code).toBe('upstream');
  });
});

describe('summarizeRequests', () => {
  it('主/子 agent 算命中率; 侧路和 Jev 按用途分组; 失效按原因计数, 新的在前', () => {
    const rs: RequestRecord[] = [
      { t: 1, kind: 'main', label: 'Neox', input: 1000, cacheRead: 900, ok: true },
      { t: 2, kind: 'sub', label: 'Agent-1', input: 1000, cacheRead: 100, ok: true, cacheBreak: { code: 'tools', lost: 5000 } },
      { t: 3, kind: 'side', label: 'session-title', ms: 800, ok: true },
      { t: 4, kind: 'side', label: 'session-title', ms: 1200, ok: false, error: 'timeout' },
      { t: 5, kind: 'jev', label: 'on_track', ms: 400, ok: true },
      { t: 6, kind: 'main', label: 'Neox', input: 2000, cacheRead: 0, ok: true, cacheBreak: { code: 'expired', lost: 9000, detail: '20m' } },
    ];
    const s = summarizeRequests(rs, 0);
    expect(s.agent).toEqual({ count: 3, input: 4000, cacheRead: 1000 });
    expect(s.kinds.side).toEqual({ count: 2, fails: 1, avgMs: 1000 });
    expect(s.sideCalls[0]).toMatchObject({ kind: 'side', label: 'session-title', count: 2, fails: 1, lastError: 'timeout' });
    expect(s.breakCounts).toEqual({ tools: 1, expired: 1 });
    expect(s.breaks.map((b) => b.code)).toEqual(['expired', 'tools']);
  });
});
