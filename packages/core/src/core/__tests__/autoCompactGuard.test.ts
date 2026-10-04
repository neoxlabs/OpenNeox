import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldAutoCompact,
  acquireCompactLock,
  recordCompactSuccess,
  recordCompactFailure,
  releaseCompactLock,
  resetAutoCompactState,
  resetCircuitBreaker,
  getAutoCompactThreshold,
  getEffectiveContextWindow,
  calculateTokenWarningState,
  getAutoCompactState,
  calibrateEstimatedTokens,
} from '@neoxlabs/kernel/core/autoCompactGuard.js';

describe('AutoCompactGuard', () => {
  beforeEach(() => {
    resetAutoCompactState();
  });

  describe('getEffectiveContextWindow', () => {
    it('subtracts summary reservation', () => {
      expect(getEffectiveContextWindow(200_000)).toBe(180_000);
    });

    it('returns 0 for small context windows', () => {
      expect(getEffectiveContextWindow(0)).toBe(0);
      expect(getEffectiveContextWindow(-1)).toBe(0);
    });
  });

  describe('getAutoCompactThreshold', () => {
    it('calculates threshold correctly', () => {
      // 200K - 20K (summary) - 13K (buffer) = 167K
      expect(getAutoCompactThreshold(200_000)).toBe(167_000);
    });

    it('caps large windows at 85% instead of a fixed 33K reserve', () => {
      // 1M: min(1M-33K=967K, 1M×0.85=850K) = 850K —— 修复前是 967K
      expect(getAutoCompactThreshold(1_000_000)).toBe(850_000);
      // 500K: min(467K, 425K) = 425K —— 修复前是 467K (93.4%)
      expect(getAutoCompactThreshold(500_000)).toBe(425_000);
    });

    /* 交叉点 ~220K (cw - 33K = cw × 0.85)。小于它的窗口必须一个 token 都不变,
     * 否则等于悄悄改了所有 200K/128K 用户的压缩时机。 */
    it('leaves windows below the ~220K crossover untouched', () => {
      expect(getAutoCompactThreshold(200_000)).toBe(167_000); // 绝对预留仍主导
      expect(getAutoCompactThreshold(128_000)).toBe(95_000);
      expect(getAutoCompactThreshold(64_000)).toBe(31_000);
    });

    it('falls back to 60% of window when the fixed reserve exceeds it', () => {
      expect(getAutoCompactThreshold(30_000)).toBe(18_000);
      expect(getAutoCompactThreshold(10_000)).toBe(6_000);
    });

    it('never returns negative, and stays 0 without a window', () => {
      expect(getAutoCompactThreshold(0)).toBe(0);
      expect(getAutoCompactThreshold(-5)).toBe(0);
    });
  });

  describe('shouldAutoCompact', () => {
    it('returns true when above threshold', () => {
      const result = shouldAutoCompact(170_000, 200_000);
      expect(result.should).toBe(true);
    });

    it('returns false when below threshold', () => {
      const result = shouldAutoCompact(100_000, 200_000);
      expect(result.should).toBe(false);
    });

    it('blocks for compact query source', () => {
      const result = shouldAutoCompact(170_000, 200_000, 'compact');
      expect(result.should).toBe(false);
      expect(result.reason).toContain('blocked query source');
    });

    it('blocks for session_memory query source', () => {
      const result = shouldAutoCompact(170_000, 200_000, 'session_memory');
      expect(result.should).toBe(false);
    });

    it('blocks when already compacting', () => {
      acquireCompactLock();
      const result = shouldAutoCompact(170_000, 200_000);
      expect(result.should).toBe(false);
      expect(result.reason).toContain('already compacting');
      releaseCompactLock();
    });
  });

  describe('Circuit Breaker', () => {
    it('opens after 3 consecutive failures', () => {
      acquireCompactLock();
      recordCompactFailure(new Error('fail 1'));

      acquireCompactLock();
      recordCompactFailure(new Error('fail 2'));

      acquireCompactLock();
      recordCompactFailure(new Error('fail 3'));

      const result = shouldAutoCompact(170_000, 200_000);
      expect(result.should).toBe(false);
      expect(result.reason).toContain('circuit breaker open');
      expect(getAutoCompactState().circuitOpen).toBe(true);
    });

    it('resets on success', () => {
      acquireCompactLock();
      recordCompactFailure(new Error('fail 1'));
      acquireCompactLock();
      recordCompactFailure(new Error('fail 2'));

      // Success resets counter
      acquireCompactLock();
      recordCompactSuccess();

      expect(getAutoCompactState().consecutiveFailures).toBe(0);
      expect(getAutoCompactState().circuitOpen).toBe(false);
    });

    it('can be manually reset', () => {
      acquireCompactLock();
      recordCompactFailure();
      acquireCompactLock();
      recordCompactFailure();
      acquireCompactLock();
      recordCompactFailure();

      expect(getAutoCompactState().circuitOpen).toBe(true);

      resetCircuitBreaker();
      expect(getAutoCompactState().circuitOpen).toBe(false);

      const result = shouldAutoCompact(170_000, 200_000);
      expect(result.should).toBe(true);
    });
  });

  describe('calculateTokenWarningState', () => {
    it('calculates warning states correctly', () => {
      // threshold = 167K, warning = 167K - 20K = 147K
      const state = calculateTokenWarningState(150_000, 200_000);
      expect(state.isAboveWarningThreshold).toBe(true);
      expect(state.isAboveAutoCompactThreshold).toBe(false);
      expect(state.percentLeft).toBeGreaterThan(0);
    });

    it('detects blocking limit', () => {
      // blocking = effective - 3K = 177K
      const state = calculateTokenWarningState(178_000, 200_000);
      expect(state.isAtBlockingLimit).toBe(true);
    });
  });
  describe('calibrateEstimatedTokens', () => {
    it('压缩后估算掉下去, 校准值跟着掉 (2026-09-11 实拍: 卡片报释放 5.1K, 实际 56K)', () => {
      const after = calibrateEstimatedTokens(19_539, 91_235, 49_671);
      expect(after).toBeLessThan(40_000);
      expect(Math.abs(after - 35_160) / 35_160).toBeLessThan(0.05);
      /* 永远不低于裸估算 */
      expect(calibrateEstimatedTokens(1_000, 91_235, 49_671)).toBeGreaterThanOrEqual(1_000);
    });

    it('没有配对样本时原样返回 — 退化成旧行为, 绝不更差', () => {
      expect(calibrateEstimatedTokens(50_000, 0, 0)).toBe(50_000);
      expect(calibrateEstimatedTokens(50_000, 100_000, 0)).toBe(50_000);
      expect(calibrateEstimatedTokens(50_000, 0, 60_000)).toBe(50_000);
    });

    it('用真实实测数据校准 (估算 62731 / 实测 109097)', () => {
      const measured = 109_097, estAtM = 62_731;
      expect(calibrateEstimatedTokens(estAtM, measured, estAtM)).toBe(measured);
      /* 估算又长了 10K → 按比值放大那 10K */
      const grown = calibrateEstimatedTokens(estAtM + 10_000, measured, estAtM);
      expect(grown).toBe(Math.round(measured + 10_000 * (measured / estAtM)));
      expect(grown).toBeGreaterThan(measured);
    });

    it('比值夹在 [1,4] — 坏样本不能把阈值推到荒谬值', () => {
      expect(calibrateEstimatedTokens(80_000, 10_000, 80_000)).toBe(80_000);
      /* 比值 20 这种只可能是坏样本 → 夹到 4 */
      const r = calibrateEstimatedTokens(30_000, 200_000, 10_000);
      expect(r).toBe(Math.round(200_000 + 20_000 * 4));
    });

    it('结果永不低于裸估算 — 两者都是下界, 取更紧的那个', () => {
      for (const [raw, m, e] of [[90_000, 50_000, 80_000], [10_000, 1, 1], [70_000, 60_000, 65_000]]) {
        expect(calibrateEstimatedTokens(raw, m, e)).toBeGreaterThanOrEqual(raw);
      }
    });

    it('校准后过阈值 / 校准前不过 — 这就是"晚 40%"的真身', () => {
      const contextWindow = 128_000;
      const threshold = getAutoCompactThreshold(contextWindow);   // 95_000
      const rawEstimate = 62_731;
      expect(rawEstimate).toBeLessThan(threshold);                 // 旧行为: 不压
      const calibrated = calibrateEstimatedTokens(rawEstimate, 109_097, 62_731);
      expect(calibrated).toBeGreaterThan(threshold);               // 新行为: 该压了
    });
  });
});
