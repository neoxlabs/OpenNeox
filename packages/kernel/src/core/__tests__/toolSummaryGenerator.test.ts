import { describe, expect, test } from 'vitest';
import { getSummaryModel } from '../toolSummaryGenerator.js';

describe('getSummaryModel', () => {
  test('gpt-5.5 不降级到 gpt-5-mini', () => {
    expect(getSummaryModel('gpt-5.5')).toBe('gpt-5.5');
    expect(getSummaryModel('gpt-5.5-pro')).toBe('gpt-5.5');
    expect(getSummaryModel('mkgpt:gpt-5.5')).toBe('gpt-5.5');
    expect(getSummaryModel('openai/gpt-5.5')).toBe('gpt-5.5');
  });

  test('gpt-5.6 走 luna，而不是 gpt-5-mini / gpt-5.6-mini', () => {
    expect(getSummaryModel('gpt-5.6-sol')).toBe('gpt-5.6-luna');
    expect(getSummaryModel('gpt-5.6-terra')).toBe('gpt-5.6-luna');
    expect(getSummaryModel('gptpro-relay-b:gpt-5.6-sol')).toBe('gpt-5.6-luna');
  });

  test('仍有 mini 的代保持同代降级', () => {
    expect(getSummaryModel('gpt-5')).toBe('gpt-5-mini');
    expect(getSummaryModel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(getSummaryModel('gpt-5.4')).toBe('gpt-5.4-mini');
    expect(getSummaryModel('gpt-5.4-high')).toBe('gpt-5.4-mini');
  });

  test('空值安全', () => {
    expect(getSummaryModel(undefined)).toBeUndefined();
    expect(getSummaryModel(null)).toBeUndefined();
  });
});
