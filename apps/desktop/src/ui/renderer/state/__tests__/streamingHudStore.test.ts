import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setStreamingTokensHud, getStreamingTokensHud, subscribeStreamingTokensHud,
} from '../streamingHudStore';

describe('streamingHudStore 合帧', () => {
  let frames: Array<() => void>;
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
    setStreamingTokensHud(0); /* 归零是立即生效的, 顺便当 reset */
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const runFrame = () => { const fs = frames; frames = []; fs.forEach((f) => f()); };

  it('一帧内多次 delta 只 notify 一次', () => {
    const seen = vi.fn();
    const off = subscribeStreamingTokensHud(seen);
    for (let i = 0; i < 50; i++) setStreamingTokensHud((p) => p + 1);
    expect(seen).toHaveBeenCalledTimes(0); /* 还没到帧边界, 一次都不该响 */
    runFrame();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('合帧期内的连续 +1 一个都不丢', () => {
    for (let i = 0; i < 50; i++) setStreamingTokensHud((p) => p + 1);
    runFrame();
    expect(getStreamingTokensHud()).toBe(50);
  });

  it('归零同帧可见 —— 新一轮不许看到上一轮的残留数字', () => {
    for (let i = 0; i < 10; i++) setStreamingTokensHud((p) => p + 1);
    runFrame();
    expect(getStreamingTokensHud()).toBe(10);
    setStreamingTokensHud(0);
    expect(getStreamingTokensHud()).toBe(0); /* 不等下一帧 */
  });
});
