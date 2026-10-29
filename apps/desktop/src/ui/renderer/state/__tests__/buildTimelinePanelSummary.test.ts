import { describe, expect, test } from 'vitest';
import { buildTimelinePanelSummary } from '../buildTimelinePanelSummary';
import type { TimelineRow } from '../../modules/agent-timeline/types';

describe('buildTimelinePanelSummary', () => {
  test('从 cell/legacy rows 抽出 running + recentTools + stats', () => {
    const rows = [
      {
        kind: 'cell',
        cell: { kind: 'assistant_text', text: 'hi' },
        id: 'm1',
        status: 'done',
        iconKind: 'chat',
        title: 'Assistant',
        presentation: 'default',
      },
      {
        kind: 'cell',
        cell: { kind: 'exec', command: 'ls' },
        id: 't1',
        status: 'done',
        iconKind: 'terminal',
        title: 'Terminal · ls',
        presentation: 'default',
      },
      {
        kind: 'legacy_step',
        step: {
          kind: 'tool',
          id: 't2',
          title: 'Read · a.ts',
          status: 'running',
          iconKind: 'read',
          desc: 'reading',
        },
      },
    ] as unknown as TimelineRow[];

    const s = buildTimelinePanelSummary('sess-1', rows);
    expect(s.sessionId).toBe('sess-1');
    expect(s.running?.title).toBe('Read · a.ts');
    expect(s.stats.total).toBe(2);
    expect(s.stats.running).toBe(1);
    expect(s.stats.done).toBe(1);
    expect(s.recentTools[0]?.title).toBe('Read');
  });
});
