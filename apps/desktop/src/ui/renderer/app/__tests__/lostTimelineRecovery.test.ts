import { describe, expect, it } from 'vitest';
import { timelineFromStoredMessages } from '../lostTimelineRecovery';

describe('timelineFromStoredMessages', () => {
  it('rebuilds user/assistant text behind a visible notice, dropping injected tags and system/empty rows', () => {
    const entries = timelineFromStoredMessages([
      { id: 'm2', role: 'system', text: 'prompt', sequence: 2 },
      { id: 'm3', role: 'user', text: '看看 Jira\n\n<reply-language>中文</reply-language>\n\n<current-time>2026-09-25</current-time>', timestamp: 10, sequence: 3 },
      { id: 'm4', role: 'assistant', text: '先查工具。', timestamp: 11, sequence: 4 },
      { id: 'm5', role: 'assistant', text: '   ', timestamp: 12, sequence: 5 },
    ], 'zh');

    expect(entries.map((e) => e.type)).toEqual(['log', 'user_message', 'assistant_message']);
    expect(entries[0]).toMatchObject({ level: 'warning', title: '步骤记录已丢失', timestamp: 10 });
    expect(entries[1]!.detail).toBe('看看 Jira');
    expect(entries[2]).toMatchObject({ id: 'recovered-m4', detail: '先查工具。', messageId: 'm4' });
    const seqs = entries.map((e) => e.sequence!);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('returns nothing when there is no conversation text', () => {
    expect(timelineFromStoredMessages([{ id: 's', role: 'system', text: 'x' }], 'en')).toEqual([]);
    expect(timelineFromStoredMessages(undefined, 'en')).toEqual([]);
  });
});
