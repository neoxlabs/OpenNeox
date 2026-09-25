import { describe, expect, it } from 'vitest';
import {
  buildSessionTitleMessages,
  buildToolUseSummaryMessages,
} from '../sideAgentPrompts.js';

describe('buildToolUseSummaryMessages', () => {
  it('emits system + user messages with batch body', () => {
    const messages = buildToolUseSummaryMessages([
      { name: 'edit', success: true, args: { file_path: 'a.ts' }, outputPreview: 'edited 3 lines', durationMs: 42 },
      { name: 'search', success: false, args: { query: 'foo' }, outputPreview: '' },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    const body = messages[1].content as string;
    expect(body).toContain('tool=edit status=ok');
    expect(body).toContain('tool=search status=fail');
    expect(body).toContain('# Call 1');
    expect(body).toContain('# Call 2');
  });

  it('truncates oversized output preview', () => {
    const huge = 'x'.repeat(2000);
    const messages = buildToolUseSummaryMessages([
      { name: 'readfile', success: true, outputPreview: huge },
    ]);
    const body = messages[1].content as string;
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(huge.length);
  });
});

describe('buildSessionTitleMessages', () => {
  it('includes user message text', () => {
    const messages = buildSessionTitleMessages('帮我重构 auth 模块');
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('帮我重构 auth 模块');
  });

  it('caps very long first messages', () => {
    const long = 'x'.repeat(5000);
    const messages = buildSessionTitleMessages(long);
    expect((messages[1].content as string).length).toBeLessThan(long.length);
  });
});
