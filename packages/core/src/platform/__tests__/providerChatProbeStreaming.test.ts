import { describe, expect, it } from 'vitest';
import { judgeStreaming } from '../providerChatProbe.js';

const at = (start: number, gaps: number[], chars = 6) => gaps.map((g, i) => ({ t: start + gaps.slice(0, i + 1).reduce((a, b) => a + b, 0) + g * 0, chars }));

describe('judgeStreaming', () => {
  it('真流式: 字一点点来, 首字早于总耗时', () => {
    const arrivals = at(1000, Array(30).fill(40)); // 30 块, 每块 6 字, 间隔 40ms
    const v = judgeStreaming(arrivals, 0);
    expect(v.verdict).toBe('real');
    expect(v.chunks).toBe(30);
    expect(v.spreadMs).toBeGreaterThan(1000);
  });

  it('整段一次给 (1~2 块) → 假流式', () => {
    expect(judgeStreaming([{ t: 3200, chars: 180 }], 0).verdict).toBe('buffered');
  });

  it('块很多但 150ms 内全到齐 → 攒完再吐', () => {
    const arrivals = Array.from({ length: 40 }, (_, i) => ({ t: 3000 + i * 2, chars: 5 }));
    expect(judgeStreaming(arrivals, 0)).toMatchObject({ verdict: 'buffered', firstTokenMs: 3000 });
  });

  it('回复太短判不了 → unknown, 不瞎报', () => {
    expect(judgeStreaming([{ t: 500, chars: 12 }], 0).verdict).toBe('unknown');
    expect(judgeStreaming([], 0)).toMatchObject({ verdict: 'unknown', firstTokenMs: null });
  });
});
