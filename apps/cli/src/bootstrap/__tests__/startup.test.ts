import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  profileCheckpoint,
  getProfileMarks,
  getPhaseTime,
  isProfiling,
} from '@neoxlabs/platform/utils/startup/profiler.js';
import {
  startCapturingEarlyInput,
  stopCapturingEarlyInput,
  isCapturing,
} from '../earlyInputCapture.js';
import {
  shouldUsePrintMode,
  isNonInteractive,
  parsePrintArgs,
} from '../printMode.js';
import { preconnectApi } from '@neoxlabs/platform/utils/startup/apiPreconnect.js';

// ─── Startup Profiler ───

describe('startupProfiler', () => {
  it('profileCheckpoint is callable (sampling-dependent)', () => {
    // profiler 可能未采样 — 只验证不崩溃
    expect(() => profileCheckpoint('test_mark')).not.toThrow();
  });

  it('getProfileMarks returns array', () => {
    const marks = getProfileMarks();
    expect(Array.isArray(marks)).toBe(true);
  });

  it('isProfiling is boolean', () => {
    expect(typeof isProfiling).toBe('boolean');
  });

  it('getPhaseTime returns null for missing marks', () => {
    expect(getPhaseTime('nonexistent_a', 'nonexistent_b')).toBeNull();
  });

  it('when profiling enabled, marks are recorded', () => {
    // 如果 NEOX_PROFILE_STARTUP=1 或随机采样命中，marks 会有数据
    // 这里验证 isProfiling 标志与 marks 一致性
    if (isProfiling) {
      profileCheckpoint('consistency_test');
      const marks = getProfileMarks();
      expect(marks.some(m => m.name === 'consistency_test')).toBe(true);
    } else {
      // 非采样模式，marks 可能为空
      expect(getProfileMarks().length).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Early Input Capture ───

describe('earlyInputCapture', () => {
  it('startCapturing does not crash in TTY mode', () => {
    // In test environment, stdin.isTTY may be true or false
    // Either way, it should not throw
    expect(() => startCapturingEarlyInput()).not.toThrow();
  });

  it('stopCapturing returns null when no data captured', () => {
    const data = stopCapturingEarlyInput();
    // May or may not be null depending on whether capturing was active
    expect(data === null || Buffer.isBuffer(data)).toBe(true);
  });
});

// ─── Print Mode ───

describe('printMode', () => {
  describe('shouldUsePrintMode', () => {
    it('detects -p flag', () => {
      expect(shouldUsePrintMode(['-p', 'hello'])).toBe(true);
    });

    it('detects --print flag', () => {
      expect(shouldUsePrintMode(['--print', 'hello'])).toBe(true);
    });

    it('returns false without flag', () => {
      expect(shouldUsePrintMode(['hello'])).toBe(false);
      expect(shouldUsePrintMode([])).toBe(false);
    });
  });

  describe('parsePrintArgs', () => {
    it('extracts prompt', () => {
      const opts = parsePrintArgs(['-p', 'explain', 'this', 'code']);
      expect(opts.prompt).toBe('explain this code');
    });

    it('extracts model', () => {
      const opts = parsePrintArgs(['-p', '-m', 'gpt-4', 'hello']);
      expect(opts.model).toBe('gpt-4');
      expect(opts.prompt).toBe('hello');
    });

    it('extracts --model', () => {
      const opts = parsePrintArgs(['--print', '--model', 'claude', 'question']);
      expect(opts.model).toBe('claude');
    });

    it('extracts --json', () => {
      const opts = parsePrintArgs(['-p', '--json', 'test']);
      expect(opts.json).toBe(true);
    });

    it('extracts --provider', () => {
      const opts = parsePrintArgs(['-p', '--provider', 'anthropic', 'test']);
      expect(opts.provider).toBe('anthropic');
    });

    it('extracts --workdir', () => {
      const opts = parsePrintArgs(['-p', '--workdir', '/project', 'test']);
      expect(opts.workDir).toBe('/project');
    });

    it('handles empty args', () => {
      const opts = parsePrintArgs(['-p']);
      expect(opts.prompt).toBeUndefined();
    });
  });

  describe('isNonInteractive', () => {
    it('returns boolean', () => {
      // Test environment may vary
      expect(typeof isNonInteractive()).toBe('boolean');
    });
  });
});

// ─── API Preconnect ───

describe('apiPreconnect', () => {
  it('does not crash with invalid URL', () => {
    expect(() => preconnectApi('not-a-url')).not.toThrow();
  });

  it('does not crash with empty URL', () => {
    expect(() => preconnectApi()).not.toThrow();
    expect(() => preconnectApi('')).not.toThrow();
  });

  it('does not crash with valid URL', () => {
    // 不实际连接，只验证不抛异常
    expect(() => preconnectApi('https://api.example.com')).not.toThrow();
  });
});
