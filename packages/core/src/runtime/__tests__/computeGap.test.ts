import { describe, it, expect } from 'vitest';
import { computeGap } from '../agentMetricsCollector.js';

describe('computeGap — 死空档计算 (稳定性核心)', () => {
  it('无任何活动 → 整轮都是 gap', () => {
    const r = computeGap(1000, [], []);
    expect(r.gapMs).toBe(1000);
    expect(r.maxGapMs).toBe(1000);
  });

  it('一个工具铺满整轮 → gap 0', () => {
    const r = computeGap(1000, [[0, 1000]], []);
    expect(r.gapMs).toBe(0);
    expect(r.maxGapMs).toBe(0);
  });

  it('两个工具中间有空档 → gap = 空档和, maxGap = 单个最长', () => {
    // [0-200] 忙, [200-500] 空, [500-700] 忙, [700-1000] 空(尾)
    const r = computeGap(1000, [[0, 200], [500, 700]], []);
    expect(r.gapMs).toBe(600); // 300 + 300
    expect(r.maxGapMs).toBe(300);
  });

  it('并行工具重叠 → 用并集不重复计忙碌 (gap 不会变负)', () => {
    // 两个工具 [0-600] 和 [100-800] 重叠, 并集 = [0-800] 忙, gap = 200
    const r = computeGap(1000, [[0, 600], [100, 800]], []);
    expect(r.gapMs).toBe(200);
    expect(r.maxGapMs).toBe(200); // 尾部 800-1000
  });

  it('推理区间算忙碌: 推理→工具无缝, 无 gap', () => {
    // 推理从 0 开始, 工具从 300 开始跑到 1000 → 推理[0-300]+工具[300-1000] 全覆盖
    const r = computeGap(1000, [[300, 1000]], [0]);
    expect(r.gapMs).toBe(0);
  });

  it('推理后到工具之间有空档 (卡在等工具) → 计入 gap', () => {
    // 推理[0-?], 首工具 500 开始 → 推理算到 500; 工具[500-700]; 尾 700-1000 空
    // 推理[0-500] + 工具[500-700] 覆盖 0-700, gap = 300 (尾)
    const r = computeGap(1000, [[500, 700]], [0]);
    expect(r.gapMs).toBe(300);
    expect(r.maxGapMs).toBe(300);
  });

  it('起点前有空档 (首个动作延迟) 计入 maxGap', () => {
    // 没有推理标记, 工具 400 才开始 → [0-400] 是 gap
    const r = computeGap(1000, [[400, 1000]], []);
    expect(r.maxGapMs).toBe(400);
    expect(r.gapMs).toBe(400);
  });

  it('防御: 负/异常输入不炸, clamp 到 [0,duration]', () => {
    const r = computeGap(500, [[-100, 9999]], [-50]);
    expect(r.gapMs).toBeGreaterThanOrEqual(0);
    expect(r.maxGapMs).toBeGreaterThanOrEqual(0);
    expect(r.gapMs).toBeLessThanOrEqual(500);
  });
});
