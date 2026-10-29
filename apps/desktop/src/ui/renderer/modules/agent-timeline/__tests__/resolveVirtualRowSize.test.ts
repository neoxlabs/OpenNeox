import { describe, expect, test } from 'vitest';
import {
  readRoBlockSize,
  resolveVirtualRowSize,
} from '../hooks/useTimelineVirtualizer';

describe('readRoBlockSize', () => {
  test('优先 borderBoxSize.blockSize', () => {
    expect(readRoBlockSize({
      borderBoxSize: [{ blockSize: 24, inlineSize: 400 }],
      contentRect: { height: 40 },
    } as unknown as ResizeObserverEntry)).toBe(24);
  });

  test('borderBoxSize 空时退回 contentRect.height', () => {
    expect(readRoBlockSize({
      borderBoxSize: [],
      contentRect: { height: 24 },
    } as unknown as ResizeObserverEntry)).toBe(24);
  });
});

describe('resolveVirtualRowSize', () => {
  test('跟流/滚动时也收下 ResizeObserver 真高 — 折叠思考不能继续按 204 占位', () => {
    expect(resolveVirtualRowSize({
      scrolling: true,
      fromRo: 24,
      cached: 204,
      estimate: 168,
    })).toBe(24);
  });

  test('滚动中没有 RO 才退回缓存, 避免读 offsetHeight', () => {
    expect(resolveVirtualRowSize({
      scrolling: true,
      fromRo: 0,
      cached: 204,
      estimate: 168,
    })).toBe(204);
  });

  test('强制校准传入 offsetHeight 时覆盖缓存', () => {
    expect(resolveVirtualRowSize({
      scrolling: true,
      fromRo: 0,
      cached: 204,
      offsetHeight: 24,
      estimate: 168,
    })).toBe(24);
  });

  test('静止时优先 RO, 其次 offsetHeight', () => {
    expect(resolveVirtualRowSize({
      scrolling: false,
      fromRo: 36,
      cached: 204,
      offsetHeight: 40,
      estimate: 168,
    })).toBe(36);
    expect(resolveVirtualRowSize({
      scrolling: false,
      fromRo: 0,
      cached: 204,
      offsetHeight: 40,
      estimate: 168,
    })).toBe(40);
  });

  test('什么都没有才用估高', () => {
    expect(resolveVirtualRowSize({
      scrolling: false,
      fromRo: 0,
      estimate: 168,
    })).toBe(168);
  });
});
