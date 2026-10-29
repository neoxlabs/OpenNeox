import { describe, expect, test } from 'vitest';
import { mapTimelineEntriesToRows } from '../mapTimelineToRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

test('explore statistics survive the timeline-to-cell mapping', () => {
  const member = {
    agentId: 'Explorer-2', task: 'inspect', status: 'running' as const,
    toolCount: 3, tokens: 12340, iterations: 4, tokensEstimated: true,
    startedAt: 1780000000000, elapsed: 42000,
  };
  const rows = mapTimelineEntriesToRows([{
    id: 'explore-batch', type: 'explore_status', timestamp: 1780000000000,
    exploreStatus: 'running', exploreGroupMembers: [member],
  } as TimelineEntry]);
  const row = rows.find(r => r.kind === 'cell' && r.cell.kind === 'explore_group');
  expect(row?.kind === 'cell' && 'groupMembers' in row.cell && row.cell.groupMembers).toEqual([member]);
});

describe('mapTimelineEntriesToRows — assistant placeholders', () => {
  test('empty pending assistant messages do not become visible assistant rows', () => {
    const rows = mapTimelineEntriesToRows([
      {
        id: 'u1',
        type: 'user_message',
        detail: 'run tests',
        timestamp: 1,
      },
      {
        id: 'a-empty',
        type: 'assistant_message',
        title: 'Assistant',
        detail: '',
        timestamp: 2,
        pending: true,
        messageId: 'assistant-1',
      },
    ] as TimelineEntry[]);

    expect(rows.some((row) =>
      row.kind === 'cell' &&
      row.cell.kind === 'assistant_text' &&
      row.id === 'a-empty'
    )).toBe(false);
    expect(rows.filter((row) => row.kind === 'cell').map((row) => row.id)).toEqual(['u1']);
  });

  test('non-empty streaming assistant messages stay visible', () => {
    const rows = mapTimelineEntriesToRows([
      {
        id: 'a-streaming',
        type: 'assistant_message',
        title: 'Assistant',
        detail: 'Working on it',
        timestamp: 1,
        pending: true,
        messageId: 'assistant-2',
      },
    ] as TimelineEntry[]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('cell');
    if (rows[0].kind !== 'cell') return;
    expect(rows[0].cell.kind).toBe('assistant_text');
    if (rows[0].cell.kind !== 'assistant_text') return;
    expect(rows[0].cell.text).toBe('Working on it');
    expect(rows[0].cell.streaming).toBe(true);
  });

  test('ellipsis-only assistant messages do not become visible assistant rows', () => {
    const rows = mapTimelineEntriesToRows([
      {
        id: 'u1',
        type: 'user_message',
        detail: 'run tests',
        timestamp: 1,
      },
      {
        id: 'a-dots',
        type: 'assistant_message',
        title: 'Assistant',
        detail: '...',
        timestamp: 2,
        messageId: 'assistant-dots',
      },
      {
        id: 'a-ellipsis',
        type: 'assistant_message',
        title: 'Assistant',
        detail: '…',
        timestamp: 3,
        pending: true,
        messageId: 'assistant-ellipsis',
      },
    ] as TimelineEntry[]);

    expect(rows.filter((row) => row.kind === 'cell').map((row) => row.id)).toEqual(['u1']);
  });
});

/* 测试环境无 __NEOX_REGION__ / localStorage 偏好 → getGlobalLanguage() 默认 'zh',
 * 以下断言按中文 UI 口径写. */
describe('mapTimelineEntriesToRows — 标题信息密度 & i18n (2026-07-19)', () => {
  const titleOf = (rows: ReturnType<typeof mapTimelineEntriesToRows>, id: string): string => {
    for (const r of rows) {
      if (r.kind === 'cell' && r.id === id) return r.title;
      if (r.kind === 'legacy_step' && r.step.id === id) return r.step.title;
    }
    return '';
  };

  test('explore_status 的散文 task 取第一子句, 不再被路径缩短器搅碎', () => {
    const task =
      '对比分析 Neox 与 Cursor 的 timeline 设计。重点看 chat / workspace / console 三个界面的信息密度与可读性, 输出报告。';
    const rows = mapTimelineEntriesToRows([
      { id: 'e1', type: 'explore_status', exploreTask: task, timestamp: 1 },
    ] as unknown as TimelineEntry[]);
    const title = titleOf(rows, 'e1');
    expect(title).toBe('探索 · 对比分析 Neox 与 Cursor 的 timeline 设计。');
    expect(title).not.toContain('…at /');
  });

  test('execute_shell 中文 UI 显示中文动词 + 完整命令 (不在 80 字符处切断)', () => {
    const longCmd = 'npx vitest run apps/desktop/src/ui/renderer/modules/agent-timeline --reporter=verbose --coverage --pool=threads';
    const rows = mapTimelineEntriesToRows([
      { id: 's1', type: 'tool_call', toolName: 'execute_shell', toolArgs: { command: longCmd }, timestamp: 1 },
    ] as unknown as TimelineEntry[]);
    const title = titleOf(rows, 's1');
    expect(title.startsWith('执行命令 · ')).toBe(true);
    expect(title).toContain('--pool=threads');
  });

  test('tool_search 的 pack 模式不再是零信息光秃行', () => {
    const rows = mapTimelineEntriesToRows([
      { id: 't1', type: 'tool_call', toolName: 'tool_search', toolArgs: { pack: 'git' }, timestamp: 1 },
      { id: 't2', type: 'tool_call', toolName: 'tool_search', toolArgs: { query: 'select:run_tests,git_status' }, timestamp: 2 },
    ] as unknown as TimelineEntry[]);
    expect(titleOf(rows, 't1')).toBe('工具检索 · pack:git');
    expect(titleOf(rows, 't2')).toBe('工具检索 · select:run_tests,git_status');
  });

  test('memory 工具按 action 显示语义标题', () => {
    const rows = mapTimelineEntriesToRows([
      { id: 'm1', type: 'tool_call', toolName: 'memory', toolArgs: { action: 'read', category: 'project' }, timestamp: 1 },
      { id: 'm2', type: 'tool_call', toolName: 'memory', toolArgs: { action: 'search', search_query: 'timeline 设计' }, timestamp: 2 },
    ] as unknown as TimelineEntry[]);
    expect(titleOf(rows, 'm1')).toBe('读取记忆 · project');
    expect(titleOf(rows, 'm2')).toBe('搜索记忆 · timeline 设计');
  });

  test('ask_user 问题走散文摘要', () => {
    const rows = mapTimelineEntriesToRows([
      {
        id: 'q1',
        type: 'ask_user',
        askUserQuestions: [{ question: '你希望采用哪种 i18n 策略? 选项 A 全量中文, 选项 B 保留技术英文术语。' }],
        timestamp: 1,
      },
    ] as unknown as TimelineEntry[]);
    expect(titleOf(rows, 'q1')).toBe('询问 · 你希望采用哪种 i18n 策略?');
  });
});
