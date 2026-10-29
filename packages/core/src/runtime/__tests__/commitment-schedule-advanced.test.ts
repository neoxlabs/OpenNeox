import { describe, expect, it, vi } from 'vitest';
import { CommitmentExtractor } from '../triage/commitmentExtractor.js';

describe('commitment schedule advanced parsing', () => {
  it('parses next weekday expressions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T09:00:00.000Z')); // Sunday

    const extractor = new CommitmentExtractor();
    const reminder = extractor.extract('提醒我下周五检查 CI');

    expect(reminder?.dueAt).toBe(Date.parse('2026-03-27T09:00:00.000Z'));
  });

  it('parses delayed day expressions with clock time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T09:00:00.000Z'));

    const extractor = new CommitmentExtractor();
    const reminder = extractor.extract('提醒我三天后下午两点检查 CI');

    expect(reminder?.dueAt).toBe(new Date(2026, 2, 18, 14, 0, 0, 0).getTime());
  });

  it('uses async schedule resolver as fallback', async () => {
    const extractor = new CommitmentExtractor();
    const reminder = await extractor.extractAsync({
      text: '提醒我下个月初检查 CI',
      now: Date.parse('2026-03-15T09:00:00.000Z'),
      scheduleResolver: async () => ({ dueAt: Date.parse('2026-04-01T09:00:00.000Z') }),
    });

    expect(reminder?.dueAt).toBe(Date.parse('2026-04-01T09:00:00.000Z'));
  });
});
