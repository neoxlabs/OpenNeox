import { describe, expect, it } from 'vitest';
import { abortComputerSession, beginComputerSession, mergeAbortSignals } from '../computerAbort.js';

describe('computerAbort', () => {
  it('begin 之后 abort, 当前 signal 被掐, 下一轮是新的', () => {
    const first = beginComputerSession();
    expect(first.aborted).toBe(false);
    abortComputerSession();
    expect(first.aborted).toBe(true);
    const second = beginComputerSession();
    expect(second.aborted).toBe(false);
    expect(second).not.toBe(first);
  });

  it('mergeAbortSignals 任一 aborted 则合并后 aborted', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal)!;
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);
  });
});
