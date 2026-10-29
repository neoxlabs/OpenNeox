import { AxiosError, CanceledError } from 'axios';
import { describe, expect, it } from 'vitest';
import { classifyError, ErrorCategory } from '../errors.js';
import { buildFriendlyRunnerError } from '../../core/runnerErrorUtils.js';

describe('Axios timeout classification', () => {
  it.each(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])(
    'classifies %s as a retryable timeout and displays its actual duration',
    (code) => {
      const error = classifyError(new AxiosError('timeout of 10000ms exceeded', code));
      expect(error.category).toBe(ErrorCategory.RETRYABLE_NETWORK);
      expect(error.code).toBe('TIMEOUT');
      expect(error.retryable).toBe(true);
      expect(buildFriendlyRunnerError(error, 'Neox Cloud').friendlyMessage).toContain('(10s)');
    },
  );

  it('does not retry an explicit user cancellation', () => {
    const error = classifyError(new CanceledError('Request canceled'));
    expect(error.category).toBe(ErrorCategory.CANCELED);
    expect(error.retryable).toBe(false);
  });

  it('keeps HTTP authentication failures fatal even if their message mentions timeout', () => {
    const error = classifyError({
      message: 'timeout of 10000ms exceeded',
      code: 'ECONNABORTED',
      response: { status: 401 },
    });
    expect(error.retryable).toBe(false);
    expect(error.category).not.toBe(ErrorCategory.RETRYABLE_NETWORK);
  });

  it('does not retry arbitrary application errors just because they mention timeout', () => {
    const error = classifyError(new Error('invalid timeout configuration'));
    expect(error.retryable).toBe(false);
  });
});
