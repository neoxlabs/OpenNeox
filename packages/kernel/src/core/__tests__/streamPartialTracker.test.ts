/**
 * Q3 StreamPartialTracker 单元测试
 *
 * 覆盖:
 *   - start / append / markComplete / markInterrupted / reset 状态机
 *   - 中断后 partial 保留 + wasInterrupted=true
 *   - 正常完成 partial 仍可访问 (但调用方应丢弃, 模块不强制清)
 *   - 多次 start = 重置
 *   - 未 start 直接 append silently no-op (防御)
 *   - shouldUsePrefillContinuation 阈值
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StreamPartialTracker,
  shouldUsePrefillContinuation,
  providerSupportsPrefill,
} from '../streamPartialTracker.js';

describe('StreamPartialTracker', () => {
  let tracker: StreamPartialTracker;

  beforeEach(() => {
    tracker = new StreamPartialTracker();
  });

  // ============================================================================
  // 状态机基础
  // ============================================================================

  describe('lifecycle', () => {
    it('未 start 时 isStreamActive=false, partial=""', () => {
      expect(tracker.isStreamActive()).toBe(false);
      expect(tracker.getPartial()).toBe('');
      expect(tracker.wasInterrupted()).toBe(false);
    });

    it('start 后 isStreamActive=true', () => {
      tracker.start();
      expect(tracker.isStreamActive()).toBe(true);
      expect(tracker.getPartial()).toBe('');
    });

    it('append 累积 partial 字符串 + chunkCount', () => {
      tracker.start();
      tracker.append('Hello, ');
      tracker.append('world!');
      expect(tracker.getPartial()).toBe('Hello, world!');
      expect(tracker.snapshot().chunkCount).toBe(2);
    });

    it('空 chunk 计 chunkCount 但不加 partial 内容', () => {
      tracker.start();
      tracker.append('');
      tracker.append('A');
      tracker.append('');
      expect(tracker.getPartial()).toBe('A');
      expect(tracker.snapshot().chunkCount).toBe(3);
    });

    it('markComplete → isStreamActive=false, wasInterrupted=false', () => {
      tracker.start();
      tracker.append('done content');
      tracker.markComplete();
      expect(tracker.isStreamActive()).toBe(false);
      expect(tracker.wasInterrupted()).toBe(false);
      expect(tracker.getPartial()).toBe('done content'); // partial 仍可访问
    });

    it('markInterrupted → wasInterrupted=true, partial 保留 + reason 标记', () => {
      tracker.start();
      tracker.append('partial output here');
      tracker.markInterrupted('watchdog_timeout');
      expect(tracker.isStreamActive()).toBe(false);
      expect(tracker.wasInterrupted()).toBe(true);
      expect(tracker.getPartial()).toBe('partial output here');
      expect(tracker.snapshot().interruptReason).toBe('watchdog_timeout');
    });

    it('未 start 直接 append → silently no-op (防御)', () => {
      tracker.append('ignored');
      expect(tracker.getPartial()).toBe('');
      expect(tracker.snapshot().chunkCount).toBe(0);
    });

    it('markComplete 后 append → silently no-op', () => {
      tracker.start();
      tracker.append('A');
      tracker.markComplete();
      tracker.append('B');  /* 应被忽略 */
      expect(tracker.getPartial()).toBe('A');
    });

    it('markInterrupted 后 append → silently no-op', () => {
      tracker.start();
      tracker.append('A');
      tracker.markInterrupted('network_error');
      tracker.append('B');
      expect(tracker.getPartial()).toBe('A');
    });
  });

  // ============================================================================
  // 重置 / 多次 start
  // ============================================================================

  describe('reset / restart', () => {
    it('多次 start = 重置上次状态', () => {
      tracker.start();
      tracker.append('first stream');
      tracker.markInterrupted('network_error');

      tracker.start();
      expect(tracker.getPartial()).toBe('');
      expect(tracker.wasInterrupted()).toBe(false);
      expect(tracker.isStreamActive()).toBe(true);
    });

    it('reset 清状态 + isActive=false', () => {
      tracker.start();
      tracker.append('xx');
      tracker.markInterrupted('abort_signal');

      tracker.reset();
      expect(tracker.getPartial()).toBe('');
      expect(tracker.wasInterrupted()).toBe(false);
      expect(tracker.isStreamActive()).toBe(false);
    });
  });

  // ============================================================================
  // snapshot
  // ============================================================================

  describe('snapshot', () => {
    it('snapshot 包含完整状态', () => {
      tracker.start();
      const startTime = Date.now();
      tracker.append('hi');
      tracker.append('!');
      tracker.markInterrupted('first_chunk_timeout');
      const endTime = Date.now();

      const snap = tracker.snapshot();
      expect(snap.partial).toBe('hi!');
      expect(snap.chunkCount).toBe(2);
      expect(snap.interrupted).toBe(true);
      expect(snap.interruptReason).toBe('first_chunk_timeout');
      expect(snap.startedAt).toBeGreaterThanOrEqual(startTime);
      expect(snap.endedAt).toBeDefined();
      expect(snap.endedAt!).toBeLessThanOrEqual(endTime + 100);
    });

    it('正常完成的 snapshot interrupted=false, interruptReason 缺', () => {
      tracker.start();
      tracker.append('ok');
      tracker.markComplete();

      const snap = tracker.snapshot();
      expect(snap.interrupted).toBe(false);
      expect(snap.interruptReason).toBeUndefined();
    });
  });

  // ============================================================================
  // shouldUsePrefillContinuation 阈值
  // ============================================================================

  describe('shouldUsePrefillContinuation', () => {
    it('空 / 短文本 (<30 字符) → false', () => {
      expect(shouldUsePrefillContinuation('')).toBe(false);
      expect(shouldUsePrefillContinuation('hi')).toBe(false);
      expect(shouldUsePrefillContinuation('a'.repeat(29))).toBe(false);
    });

    it('≥30 字符 → true', () => {
      expect(shouldUsePrefillContinuation('a'.repeat(30))).toBe(true);
      expect(shouldUsePrefillContinuation('a'.repeat(1000))).toBe(true);
    });

    it('前后空白被忽略 (trim)', () => {
      expect(shouldUsePrefillContinuation('   ' + 'a'.repeat(20) + '   ')).toBe(false);
    });
  });

  describe('providerSupportsPrefill', () => {
    it('provider=anthropic → true', () => {
      expect(providerSupportsPrefill('anthropic')).toBe(true);
      expect(providerSupportsPrefill('Anthropic')).toBe(true);  // 大小写不敏感
    });

    it('provider=deepseek → true', () => {
      expect(providerSupportsPrefill('deepseek')).toBe(true);
    });

    it('provider=openai/gemini/kimi/glm → false', () => {
      expect(providerSupportsPrefill('openai')).toBe(false);
      expect(providerSupportsPrefill('gemini')).toBe(false);
      expect(providerSupportsPrefill('kimi')).toBe(false);
      expect(providerSupportsPrefill('glm')).toBe(false);
    });

    it('无 provider 时用 modelId 子串推断', () => {
      expect(providerSupportsPrefill(undefined, 'claude-sonnet-4.5')).toBe(true);
      expect(providerSupportsPrefill(undefined, 'opus-4')).toBe(true);
      expect(providerSupportsPrefill(undefined, 'haiku-3.5')).toBe(true);
      expect(providerSupportsPrefill(undefined, 'deepseek-v3')).toBe(true);
      expect(providerSupportsPrefill(undefined, 'deepseek-r1')).toBe(true);
    });

    it('modelId 不匹配 → false', () => {
      expect(providerSupportsPrefill(undefined, 'gpt-4o')).toBe(false);
      expect(providerSupportsPrefill(undefined, 'gemini-2-pro')).toBe(false);
      expect(providerSupportsPrefill(undefined, 'qwen3-coder')).toBe(false);
    });

    it('全空 → false', () => {
      expect(providerSupportsPrefill()).toBe(false);
      expect(providerSupportsPrefill(undefined, undefined)).toBe(false);
      expect(providerSupportsPrefill('', '')).toBe(false);
    });
  });

  // ============================================================================
  // 实际场景模拟
  // ============================================================================

  describe('realistic scenarios', () => {
    it('完整流程: start → 多个 chunk → markComplete', () => {
      tracker.start();
      const chunks = ['Hello ', 'world ', 'this is ', 'a complete ', 'response.'];
      for (const c of chunks) tracker.append(c);
      tracker.markComplete();

      expect(tracker.getPartial()).toBe('Hello world this is a complete response.');
      expect(tracker.wasInterrupted()).toBe(false);
    });

    it('中断流程: start → 几个 chunk → markInterrupted → partial 留给 retry', () => {
      tracker.start();
      tracker.append('I will analyze the code and ');
      tracker.append('look at how the function ');
      tracker.append('handles the edge case where');
      /* 模拟 watchdog 超时 */
      tracker.markInterrupted('watchdog_timeout');

      expect(tracker.wasInterrupted()).toBe(true);
      const partial = tracker.getPartial();
      expect(partial.length).toBeGreaterThan(30);
      expect(shouldUsePrefillContinuation(partial)).toBe(true);
      /* retry 路径应该读到这个 partial 用 prefill 续接 */
    });

    it('短中断 (<30 字符) → 不值得 prefill, fallback 重发', () => {
      tracker.start();
      tracker.append('Hi');
      tracker.markInterrupted('network_error');

      expect(tracker.wasInterrupted()).toBe(true);
      expect(shouldUsePrefillContinuation(tracker.getPartial())).toBe(false);
    });
  });
});
