import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isRetryable,
  calculateBackoff,
  shouldRetryProcess,
  withLLMRetry,
  DEFAULT_RESILIENCE_CONFIG,
} from '../../runtime/resilience/agentResiliencePolicy.js';

describe('Agent Resilience Policy', () => {
  // ==========================================================================
  // Error Classification
  // ==========================================================================
  describe('classifyError', () => {
    it('classifies rate limit errors', () => {
      expect(classifyError(new Error('429 Too Many Requests'))).toBe('rate_limit');
      expect(classifyError(new Error('Rate limit exceeded'))).toBe('rate_limit');
      expect(classifyError(new Error('quota exceeded for model'))).toBe('rate_limit');
    });

    it('classifies server errors', () => {
      expect(classifyError(new Error('500 Internal Server Error'))).toBe('server_error');
      expect(classifyError(new Error('502 Bad Gateway'))).toBe('server_error');
      expect(classifyError(new Error('503 Service Unavailable'))).toBe('server_error');
    });

    it('classifies network errors', () => {
      expect(classifyError(new Error('ECONNRESET'))).toBe('network');
      expect(classifyError(new Error('fetch failed'))).toBe('network');
      expect(classifyError(new Error('Socket hang up'))).toBe('network');
      expect(classifyError(new Error('ETIMEDOUT'))).toBe('network');
    });

    it('classifies token limit errors', () => {
      expect(classifyError(new Error('maximum context length exceeded'))).toBe('token_limit');
      expect(classifyError(new Error('context_length_exceeded'))).toBe('token_limit');
    });

    it('classifies auth errors', () => {
      expect(classifyError(new Error('401 Unauthorized'))).toBe('auth');
      expect(classifyError(new Error('Invalid API key'))).toBe('auth');
      expect(classifyError(new Error('403 Forbidden'))).toBe('auth');
    });

    it('classifies unknown errors', () => {
      expect(classifyError(new Error('Something weird happened'))).toBe('unknown');
    });
  });

  // ==========================================================================
  // Retryability
  // ==========================================================================
  describe('isRetryable', () => {
    it('rate_limit is retryable', () => expect(isRetryable('rate_limit')).toBe(true));
    it('server_error is retryable', () => expect(isRetryable('server_error')).toBe(true));
    it('network is retryable', () => expect(isRetryable('network')).toBe(true));
    it('token_limit is NOT retryable', () => expect(isRetryable('token_limit')).toBe(false));
    it('auth is NOT retryable', () => expect(isRetryable('auth')).toBe(false));
    it('unknown is NOT retryable', () => expect(isRetryable('unknown')).toBe(false));
  });

  // ==========================================================================
  // Backoff Calculation
  // ==========================================================================
  describe('calculateBackoff', () => {
    it('increases with attempt number', () => {
      const config = { initialBackoffMs: 1000, maxBackoffMs: 30000, backoffMultiplier: 2 };
      const del0 = calculateBackoff(0, config);
      const del1 = calculateBackoff(1, config);
      const del2 = calculateBackoff(2, config);
      // With jitter, we can't assert exact values, but trend should increase
      expect(del1).toBeGreaterThan(del0 * 0.5);
      expect(del2).toBeGreaterThan(del1 * 0.5);
    });

    it('caps at maxBackoffMs', () => {
      const config = { initialBackoffMs: 1000, maxBackoffMs: 5000, backoffMultiplier: 10 };
      const delay = calculateBackoff(5, config);
      // With 25% jitter, max is 5000 * 1.25 = 6250
      expect(delay).toBeLessThanOrEqual(6250);
    });

    it('uses longer initial backoff for rate_limit', () => {
      const config = { initialBackoffMs: 1000, maxBackoffMs: 30000, backoffMultiplier: 2 };
      const regularDelays: number[] = [];
      const rateLimitDelays: number[] = [];
      
      // Sample multiple times to account for jitter
      for (let i = 0; i < 20; i++) {
        regularDelays.push(calculateBackoff(0, config, 'server_error'));
        rateLimitDelays.push(calculateBackoff(0, config, 'rate_limit'));
      }
      
      const avgRegular = regularDelays.reduce((a, b) => a + b) / regularDelays.length;
      const avgRateLimit = rateLimitDelays.reduce((a, b) => a + b) / rateLimitDelays.length;
      
      expect(avgRateLimit).toBeGreaterThan(avgRegular * 1.5);
    });
  });

  // ==========================================================================
  // Process Retry Decision
  // ==========================================================================
  describe('shouldRetryProcess', () => {
    it('retries on rate limit', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 0,
        maxAttempts: 2,
        lastError: '429 Too Many Requests',
      });
      expect(result.shouldRetry).toBe(true);
      expect(result.delayMs).toBeGreaterThan(0);
    });

    it('retries on server error', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 0,
        maxAttempts: 2,
        lastError: '500 Internal Server Error',
      });
      expect(result.shouldRetry).toBe(true);
    });

    it('does NOT retry on auth error', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 0,
        maxAttempts: 2,
        lastError: '401 Unauthorized',
      });
      expect(result.shouldRetry).toBe(false);
    });

    it('stops retrying after max attempts', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 2,
        maxAttempts: 2,
        lastError: '429 Rate limit',
      });
      expect(result.shouldRetry).toBe(false);
    });

    it('does NOT retry on budget exhaustion', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 0,
        maxAttempts: 2,
        lastExitReason: 'budget_tokens',
      });
      expect(result.shouldRetry).toBe(false);
    });

    it('retries on token limit with compaction hint', () => {
      const result = shouldRetryProcess({
        pid: 'proc-1',
        task: 'test',
        role: 'dev',
        attempt: 0,
        maxAttempts: 2,
        lastError: 'maximum context length exceeded',
      });
      expect(result.shouldRetry).toBe(true);
      expect(result.reason).toContain('compacted');
    });
  });


  // ==========================================================================
  // withLLMRetry
  // ==========================================================================
  describe('withLLMRetry', () => {
    it('succeeds on first try', async () => {
      const result = await withLLMRetry(async () => 'hello');
      expect(result.success).toBe(true);
      expect(result.value).toBe('hello');
      expect(result.attempts).toBe(1);
    });

    it('retries on retryable error then succeeds', async () => {
      let callCount = 0;
      const result = await withLLMRetry(
        async () => {
          callCount++;
          if (callCount < 3) throw new Error('429 rate limit');
          return 'recovered';
        },
        { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 10, maxBackoffMs: 50 },
      );
      expect(result.success).toBe(true);
      expect(result.value).toBe('recovered');
      expect(result.attempts).toBe(3);
    });

    it('fails immediately on non-retryable error', async () => {
      const result = await withLLMRetry(
        async () => { throw new Error('401 Unauthorized'); },
        { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 10 },
      );
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
    });

    it('respects abort signal', async () => {
      const ac = new AbortController();
      ac.abort();
      const result = await withLLMRetry(
        async () => { throw new Error('500'); },
        DEFAULT_RESILIENCE_CONFIG,
        { signal: ac.signal },
      );
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Aborted');
    });
  });
});
