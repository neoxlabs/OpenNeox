import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  getTimelineFeed,
  getTimelineFeedSessionId,
  publishTimelineFeed,
  subscribeTimelineFeed,
} from '../timelineFeedStore';
import type { TimelineEntry } from '../../utils/workspaceUtils';

function entry(id: string): TimelineEntry {
  return { id, type: 'assistant_message', sessionId: 's1' } as unknown as TimelineEntry;
}

describe('timelineFeedStore', () => {
  beforeEach(() => {
    publishTimelineFeed(null, [], { immediate: true });
  });

  afterEach(() => {
    publishTimelineFeed(null, [], { immediate: true });
  });

  test('immediate publish updates snapshot same turn', () => {
    const rows = [entry('a'), entry('b')];
    publishTimelineFeed('s1', rows, { immediate: true });
    expect(getTimelineFeed()).toBe(rows);
    expect(getTimelineFeedSessionId()).toBe('s1');
  });

  test('rAF coalesce keeps last pending only', async () => {
    vi.useFakeTimers();
    const a = [entry('a')];
    const b = [entry('b')];
    const seen: TimelineEntry[][] = [];
    const unsub = subscribeTimelineFeed(() => {
      seen.push(getTimelineFeed());
    });

    publishTimelineFeed('s1', a);
    publishTimelineFeed('s1', b);
    expect(getTimelineFeed()).toEqual([]);

    await vi.runAllTimersAsync();
    /* rAF polyfill in vitest often maps to timers */
    expect(getTimelineFeed()).toBe(b);
    expect(seen.at(-1)).toBe(b);
    unsub();
    vi.useRealTimers();
  });
});
