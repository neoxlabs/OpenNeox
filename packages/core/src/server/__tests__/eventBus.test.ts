import { describe, it, expect } from 'vitest';
import { EventBus } from '../eventBus.js';

// 创建测试事件
function makeEvent(sessionId: string, type: string): Parameters<EventBus['publish']>[0] {
  return {
    sessionId,
    type,
    data: { type } as any,
    timestamp: Date.now(),
  };
}

describe('EventBus seq-num', () => {
  it('assigns monotonically increasing seq numbers', () => {
    const bus = new EventBus();
    const received: number[] = [];
    const sub = bus.subscribe('s1');

    bus.publish(makeEvent('s1', 'a'));
    bus.publish(makeEvent('s1', 'b'));
    bus.publish(makeEvent('s1', 'c'));

    // Consume
    const iter = sub[Symbol.asyncIterator]();
    const collect = async () => {
      const r1 = await iter.next();
      const r2 = await iter.next();
      const r3 = await iter.next();
      return [r1.value.seq, r2.value.seq, r3.value.seq];
    };

    return collect().then(seqs => {
      expect(seqs[0]).toBe(1);
      expect(seqs[1]).toBe(2);
      expect(seqs[2]).toBe(3);
      sub.close();
      bus.dispose();
    });
  });

  it('currentSeq reflects latest seq', () => {
    const bus = new EventBus();
    expect(bus.currentSeq).toBe(0);

    bus.publish(makeEvent('s1', 'x'));
    expect(bus.currentSeq).toBe(1);

    bus.publish(makeEvent('s2', 'y'));
    expect(bus.currentSeq).toBe(2);

    bus.dispose();
  });
});

describe('EventBus seq-num replay', () => {
  it('replayFrom returns events after specified seq', () => {
    const bus = new EventBus();
    bus.publish(makeEvent('s1', 'a')); // seq=1
    bus.publish(makeEvent('s1', 'b')); // seq=2
    bus.publish(makeEvent('s1', 'c')); // seq=3
    bus.publish(makeEvent('s2', 'd')); // seq=4 (different session)

    const replay = bus.replayFrom('s1', 1);
    expect(replay.length).toBe(2); // seq 2 and 3
    expect(replay[0].seq).toBe(2);
    expect(replay[1].seq).toBe(3);

    bus.dispose();
  });

  it('replayFrom returns empty for unknown session', () => {
    const bus = new EventBus();
    expect(bus.replayFrom('unknown', 0)).toEqual([]);
    bus.dispose();
  });

  it('replayFrom returns empty when fromSeq >= highwater', () => {
    const bus = new EventBus();
    bus.publish(makeEvent('s1', 'a')); // seq=1
    expect(bus.replayFrom('s1', 1)).toEqual([]);
    expect(bus.replayFrom('s1', 99)).toEqual([]);
    bus.dispose();
  });
});

describe('EventBus subscribe with fromSeq', () => {
  it('pre-populates queue with replay events', async () => {
    const bus = new EventBus();
    bus.publish(makeEvent('s1', 'old1')); // seq=1
    bus.publish(makeEvent('s1', 'old2')); // seq=2
    bus.publish(makeEvent('s1', 'old3')); // seq=3

    // Subscribe from seq=1, should get seq 2 and 3
    const sub = bus.subscribe('s1', 1);
    const iter = sub[Symbol.asyncIterator]();

    const r1 = await iter.next();
    expect(r1.value.seq).toBe(2);
    expect(r1.value.type).toBe('old2');

    const r2 = await iter.next();
    expect(r2.value.seq).toBe(3);
    expect(r2.value.type).toBe('old3');

    sub.close();
    bus.dispose();
  });
});

describe('EventBus getSeqHighWater', () => {
  it('returns 0 for unknown session', () => {
    const bus = new EventBus();
    expect(bus.getSeqHighWater('nope')).toBe(0);
    bus.dispose();
  });

  it('tracks per-session high water', () => {
    const bus = new EventBus();
    bus.publish(makeEvent('s1', 'a'));
    bus.publish(makeEvent('s2', 'b'));
    bus.publish(makeEvent('s1', 'c'));

    expect(bus.getSeqHighWater('s1')).toBe(3);
    expect(bus.getSeqHighWater('s2')).toBe(2);
    bus.dispose();
  });
});

describe('EventBus clearSessionBuffer', () => {
  it('clears only specified session', () => {
    const bus = new EventBus();
    bus.publish(makeEvent('s1', 'a'));
    bus.publish(makeEvent('s2', 'b'));

    bus.clearSessionBuffer('s1');
    expect(bus.replayFrom('s1', 0)).toEqual([]);
    expect(bus.getSeqHighWater('s1')).toBe(0);

    // s2 unaffected
    expect(bus.replayFrom('s2', 0).length).toBe(1);
    bus.dispose();
  });
});

describe('EventBus sub-agent mirror', () => {
  it('镜像事件进 * 和 session:<id> —— 桌面直播靠 *', async () => {
    const bus = new EventBus();
    const star = bus.subscribe();
    const scoped = bus.subscribe('child-sid');

    bus.publish({
      sessionId: 'child-sid',
      type: 'tool_call_start',
      data: {
        type: 'tool_call_start',
        sessionId: 'child-sid',
        __subAgentMirror: true,
      } as any,
      timestamp: Date.now(),
    });

    const starIter = star[Symbol.asyncIterator]();
    const scopedIter = scoped[Symbol.asyncIterator]();
    const [starEvt, scopedEvt] = await Promise.all([starIter.next(), scopedIter.next()]);

    expect(starEvt.done).toBe(false);
    expect((starEvt.value.data as { __subAgentMirror?: boolean }).__subAgentMirror).toBe(true);
    expect(starEvt.value.sessionId).toBe('child-sid');
    expect(scopedEvt.value.sessionId).toBe('child-sid');
    expect((scopedEvt.value.data as { __subAgentMirror?: boolean }).__subAgentMirror).toBe(true);

    star.close();
    scoped.close();
    bus.dispose();
  });
});
