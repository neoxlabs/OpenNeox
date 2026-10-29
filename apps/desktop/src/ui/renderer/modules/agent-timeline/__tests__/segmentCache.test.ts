import { describe, expect, test } from 'vitest';
import { createSegmentCache } from '../segmentCache';

describe('segmentCache ctx buckets', () => {
  test('不同 ctxSig 互不踩缓存 — 主栏/IDE 窄栏 density 可同帧共存', () => {
    const cache = createSegmentCache<number, string>();
    const items = [1, 2, 3, 4];
    let computes = 0;
    const run = (sig: string) =>
      cache.run(
        items,
        (n) => n === 3,
        (seg) => {
          computes++;
          return seg.map(String);
        },
        sig,
      );

    computes = 0;
    run('density:full');
    expect(computes).toBe(2);

    computes = 0;
    run('density:minimal');
    expect(computes).toBe(2);

    computes = 0;
    run('density:full');
    /* 封口段复用, 只重算最后一段。若两 density 共用一槽, 这里会再算 2 次。 */
    expect(computes).toBe(1);
  });
});
