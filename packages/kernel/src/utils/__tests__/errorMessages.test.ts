import { describe, expect, it } from 'vitest';
import { formatLLMErrorMessage } from '../errorMessages.js';

describe('LLM timeout messages', () => {
  it('uses the effective Axios timeout instead of a guessed 120s', () => {
    const message = formatLLMErrorMessage('timeout of 10000ms exceeded', {
      providerName: 'Neox Cloud',
      timeoutMs: 120000,
    });
    expect(message).toContain('Neox Cloud');
    expect(message).toContain('(10s)');
    expect(message).not.toContain('120s');
  });

  it('uses an explicitly supplied timeout when the error has no duration', () => {
    expect(formatLLMErrorMessage('Connection timeout', { timeoutMs: 180000 }))
      .toContain('(180s)');
  });

  it.each([undefined, NaN, Infinity, 0, -1000])('does not invent a duration for %s', (timeoutMs) => {
    expect(formatLLMErrorMessage('Connection timeout', { timeoutMs })).not.toContain('(');
  });

  it('preserves subsecond precision', () => {
    expect(formatLLMErrorMessage('timeout of 1500ms exceeded')).toContain('(1.5s)');
  });

  it('preserves other errors', () => {
    expect(formatLLMErrorMessage('Invalid API key')).toBe('Invalid API key');
  });
});
