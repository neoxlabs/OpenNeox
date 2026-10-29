/**
 * 首字时间 (code:CLI-02): 从 run_result.iterationPerf 取这一轮的首字, 并给日志 / 状态行用。
 */
import { describe, expect, it } from 'vitest';
import {
  formatPerfLog,
  formatTtft,
  getLastTurnTtft,
  recordTurnPerf,
  summarizeTurnPerf,
  type IterationPerf,
} from '../turnPerf.js';

const iter = (over: Partial<IterationPerf>): IterationPerf => ({
  iteration: 1,
  durationMs: 1000,
  ttftMs: null,
  firstKind: null,
  toolMs: 0,
  toolCalls: 0,
  textChars: 0,
  ...over,
});

describe('summarizeTurnPerf', () => {
  it('取第一次请求的首字 (用户等的就是这一下)', () => {
    const perf = summarizeTurnPerf([
      iter({ iteration: 1, ttftMs: 1200, firstKind: 'text', durationMs: 2000, toolMs: 300 }),
      iter({ iteration: 2, ttftMs: 400, firstKind: 'tool_call', durationMs: 1500, toolMs: 700 }),
    ]);
    expect(perf).toEqual({ ttftMs: 1200, firstKind: 'text', iterations: 2, llmMs: 3500, toolMs: 1000 });
  });

  it('第一次没测到就退到后面第一个测到的值', () => {
    const perf = summarizeTurnPerf([
      iter({ iteration: 1, ttftMs: null }),
      iter({ iteration: 2, ttftMs: 900, firstKind: 'reasoning' }),
    ]);
    expect(perf?.ttftMs).toBe(900);
    expect(perf?.firstKind).toBe('reasoning');
  });

  it('一次都没测到 → ttft 是 null (不用 0 充数)', () => {
    expect(summarizeTurnPerf([iter({})])?.ttftMs).toBeNull();
  });

  it('空数组 / 没传 → null', () => {
    expect(summarizeTurnPerf([])).toBeNull();
    expect(summarizeTurnPerf(undefined)).toBeNull();
  });
});

describe('formatTtft', () => {
  it('不足一秒写毫秒, 否则写秒', () => {
    expect(formatTtft(0)).toBe('0ms');
    expect(formatTtft(820)).toBe('820ms');
    expect(formatTtft(1234)).toBe('1.2s');
    expect(formatTtft(12_345)).toBe('12s');
  });
});

describe('formatPerfLog', () => {
  it('一条可搜索的结构化日志, 含首字 / 首字类型 / 轮次 / 耗时拆分', () => {
    const log = formatPerfLog({ ttftMs: 1200, firstKind: 'text', iterations: 3, llmMs: 4200, toolMs: 800 });
    expect(log).toBe('ttft=1200ms first=text iterations=3 llm=4200ms tools=800ms label=Main');
  });

  it('没测到首字也照实写 n/a, 不编数字', () => {
    const log = formatPerfLog({ ttftMs: null, firstKind: null, iterations: 1, llmMs: 500, toolMs: 0 }, 'Explore');
    expect(log).toContain('ttft=n/a');
    expect(log).toContain('label=Explore');
  });
});

describe('最近一轮首字 (状态行读这份)', () => {
  it('记一轮后能读到; 下一轮空指标会把旧值清掉', () => {
    recordTurnPerf([iter({ ttftMs: 1500 })]);
    expect(getLastTurnTtft()).toBe(1500);

    recordTurnPerf(null);
    expect(getLastTurnTtft()).toBeNull();
  });
});
