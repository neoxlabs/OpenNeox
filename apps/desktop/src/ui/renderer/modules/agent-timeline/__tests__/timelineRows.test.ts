/**
 * timelineRows 单测 — 固化 B8/B9 改动的核心契约.
 *
 *   防止 "row key 突变导致闪烁" / "activity id 因 firstContentId 抖动重 mount"
 *   这两类闪烁 bug 再回归.
 *
 *   Phase 3.12 后 Row 内 step 字段从 TimelineStep 改成 RowStep (HistoryCellRow |
 *   LegacyStepRow). 老 fixture 走 wrapStepAsRowStep 升降; mkRow 直接产 Row.
 */

import { describe, expect, test } from 'vitest';
import {
  buildTimelineRows,
  collapseActivityRuns,
  rowKeyOf,
  contentIdsOf,
  pinnedSetAdd,
  stabilizeTimelineRows,
  wrapStepAsRowStep,
  rowHasWaitingAsk,
  isWaitingAskStep,
  type Row,
} from '../timelineRows';
import type { HistoryCellRow, LegacyStepRow, TimelineMessage, TimelineRow, TimelineStep } from '../types';

function mkStep(id: string, title: string, status: 'running' | 'done' = 'done'): TimelineStep {
  return {
    kind: 'tool',
    id,
    title,
    status,
    iconKind: 'task' as any,
  };
}

function mkLegacyStepRow(id: string, title: string, status: 'running' | 'done' = 'done'): LegacyStepRow {
  return wrapStepAsRowStep(mkStep(id, title, status));
}

function mkMessage(id: string, role: 'user' | 'assistant' = 'user', text = 'hi'): TimelineMessage {
  return {
    kind: 'message',
    id,
    role,
    text,
  };
}

/** 直接构造 user/assistant HistoryCellRow — 给 buildTimelineRows 入口测试 */
function mkUserCellRow(id: string, text = 'hi'): HistoryCellRow {
  return {
    kind: 'cell',
    id,
    status: 'done',
    iconKind: 'task' as any,
    title: 'You',
    presentation: {
      phase: 'completed',
      importance: 'primary',
      visibility: 'inline',
      defaultExpanded: true,
    },
    cell: {
      kind: 'user',
      id,
      sessionId: '',
      timestamp: 0,
      text,
    },
  };
}

function mkAssistantCellRow(id: string, text = 'hi'): HistoryCellRow {
  return {
    kind: 'cell',
    id,
    status: 'done',
    iconKind: 'thinking' as any,
    title: 'Assistant',
    presentation: {
      phase: 'completed',
      importance: 'primary',
      visibility: 'inline',
      defaultExpanded: true,
    },
    cell: {
      kind: 'assistant_text',
      id,
      sessionId: '',
      timestamp: 0,
      text,
      phase: 'narrative',
      streaming: false,
    },
  };
}

function mkActivity(rows: Row[]): Extract<Row, { kind: 'activity' }> {
  return { kind: 'activity', id: 'act-test-0', rows, opCount: rows.length, hasActive: false };
}

describe('rowKeyOf — B8 闪烁陷阱契约', () => {
  test('message → m-<id>', () => {
    const row: Row = { kind: 'message', message: mkMessage('m1') };
    expect(rowKeyOf(row, 0)).toBe('m-m1');
  });

  test('single → s-<id> (跟内容无关, 只看 step.id)', () => {
    const row: Row = { kind: 'single', step: mkLegacyStepRow('s1', 'Read file') };
    expect(rowKeyOf(row, 0)).toBe('s-s1');
  });

  test('cluster → s-<first.id> 稳定 (row kind 变化时 key 不突变)', () => {
    const row: Row = {
      kind: 'cluster',
      id: 'cl-a',
      key: 'task:read',
      iconKind: 'task' as any,
      head: 'Read',
      items: [mkLegacyStepRow('a', 'Read'), mkLegacyStepRow('b', 'Read')],
    };
    expect(rowKeyOf(row, 0)).toBe('s-a');
  });

  test('activity → r.id 直接透传 (不依赖 index, 防 Virtuoso 整行替换)', () => {
    const row: Row = {
      kind: 'activity',
      id: 'act-msg1-0',
      rows: [],
      opCount: 0,
      hasActive: false,
    };
    expect(rowKeyOf(row, 5)).toBe('act-msg1-0');
  });
});

describe('contentIdsOf — B8 内容身份', () => {
  test('cluster 的 contentIdsOf 是它所有 items 的 step ids', () => {
    const row: Row = {
      kind: 'cluster',
      id: 'cl-a',
      key: 'task:read',
      iconKind: 'task' as any,
      head: 'Read',
      items: [mkLegacyStepRow('a', 'Read'), mkLegacyStepRow('b', 'Read')],
    };
    expect(contentIdsOf(row)).toEqual(['s:a', 's:b']);
  });
});

describe('collapseActivityRuns — B9 activity id 必须稳定不依赖 firstContentId', () => {
  test('同一 anchor 下两段 (被 message 切开) 顺序编号 0,1 不重复', () => {
    const rows: Row[] = [
      { kind: 'message', message: mkMessage('user1', 'user') },
      { kind: 'single', step: mkLegacyStepRow('s1', 'Read') },
      { kind: 'single', step: mkLegacyStepRow('s2', 'Read') },
      { kind: 'message', message: mkMessage('assist1', 'assistant') },
      { kind: 'single', step: mkLegacyStepRow('s3', 'Write') },
    ];
    const out = collapseActivityRuns(rows);
    const activities = out.filter(r => r.kind === 'activity') as Extract<Row, { kind: 'activity' }>[];
    expect(activities.length).toBeGreaterThan(0);
    expect(activities[0].id).toBe('act-user1-0');
  });

  test('段首 step 变更 (firstContentId 变) → activity id 仍稳定 (B9 核心)', () => {
    const before: Row[] = [
      { kind: 'message', message: mkMessage('m1', 'user') },
      { kind: 'single', step: mkLegacyStepRow('a', 'Read') },
      { kind: 'single', step: mkLegacyStepRow('b', 'Edit') },
    ];
    const after: Row[] = [
      { kind: 'message', message: mkMessage('m1', 'user') },
      { kind: 'single', step: mkLegacyStepRow('c', 'NewFirst') },
      { kind: 'single', step: mkLegacyStepRow('a', 'Read') },
      { kind: 'single', step: mkLegacyStepRow('b', 'Edit') },
    ];
    const idBefore = (collapseActivityRuns(before).find(r => r.kind === 'activity') as any).id;
    const idAfter = (collapseActivityRuns(after).find(r => r.kind === 'activity') as any).id;
    expect(idBefore).toBe('act-m1-0');
    expect(idAfter).toBe('act-m1-0');
    expect(idBefore).toBe(idAfter);
  });

  test('无 message anchor (顶层就 step 开头) → anchorMsgId="__start__", splitIndex=0', () => {
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('s1', 'Read') },
      { kind: 'single', step: mkLegacyStepRow('s2', 'Read') },
    ];
    const out = collapseActivityRuns(rows);
    const a = out.find(r => r.kind === 'activity') as any;
    expect(a.id).toBe('act-__start__-0');
  });

  test('只有一次工具调用时不套 activity —— 组头跟唯一子行会说同一件事', () => {
    const out = collapseActivityRuns([
      { kind: 'single', step: mkLegacyStepRow('only', 'Read') },
    ]);
    expect(out.map(r => r.kind)).toEqual(['single']);
  });
});

describe('buildTimelineRows + pinnedSingleStepIds — B5 反闪烁锁', () => {
  test('pinnedSingleStepIds 一旦含某 step.id, 它即便达到 cluster 阈值也保持 single', () => {
    const items: TimelineRow[] = [
      mkLegacyStepRow('a', 'Read', 'done'),
      mkLegacyStepRow('b', 'Read', 'done'),
      mkLegacyStepRow('c', 'Read', 'done'),
    ];
    const pinned = new Set(['a']);
    const rows = buildTimelineRows(items, false, pinned);
    const aRow = rows.find(r => r.kind === 'single' && (r as any).step.step?.id === 'a');
    expect(aRow).toBeDefined();
  });

  test('running step 永不进 cluster (运行中实时可见)', () => {
    const items: TimelineRow[] = [
      mkLegacyStepRow('a', 'Read', 'done'),
      mkLegacyStepRow('b', 'Read', 'running'),
      mkLegacyStepRow('c', 'Read', 'done'),
    ];
    const rows = buildTimelineRows(items, false);
    const bRow = rows.find(r => r.kind === 'single' && (r as any).step.step?.id === 'b');
    expect(bRow).toBeDefined();
  });

  test('HistoryCellRow with cell.kind=user/assistant_text 在 buildTimelineRows 中转成 Row.message', () => {
    const items: TimelineRow[] = [
      mkUserCellRow('u1', '你好'),
      mkLegacyStepRow('s1', 'Read'),
      mkAssistantCellRow('a1', '回复'),
    ];
    const rows = buildTimelineRows(items, false);
    const msgs = rows.filter(r => r.kind === 'message') as Extract<Row, { kind: 'message' }>[];
    expect(msgs.length).toBe(2);
    expect(msgs[0].message.role).toBe('user');
    expect(msgs[0].message.text).toBe('你好');
    expect(msgs[1].message.role).toBe('assistant');
    expect(msgs[1].message.text).toBe('回复');
  });
});

describe('pinnedSetAdd — B5 LRU 防内存泄漏', () => {
  test('size 不超过 cap', () => {
    const s = new Set<string>();
    for (let i = 0; i < 100; i++) pinnedSetAdd(s, `id-${i}`, 50);
    expect(s.size).toBe(50);
  });

  test('cap 触顶时驱逐最早插入的', () => {
    const s = new Set<string>();
    pinnedSetAdd(s, 'a', 3);
    pinnedSetAdd(s, 'b', 3);
    pinnedSetAdd(s, 'c', 3);
    pinnedSetAdd(s, 'd', 3);
    expect(s.has('a')).toBe(false);
    expect(s.has('d')).toBe(true);
    expect(s.size).toBe(3);
  });

  test('重复 add 同一 id → bump 到 MRU (不再被下一次 cap 驱逐)', () => {
    const s = new Set<string>();
    pinnedSetAdd(s, 'a', 3);
    pinnedSetAdd(s, 'b', 3);
    pinnedSetAdd(s, 'c', 3);
    pinnedSetAdd(s, 'a', 3);
    pinnedSetAdd(s, 'd', 3);
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    expect(s.has('d')).toBe(true);
  });
});

function mkDiffCellRow(id: string, lineText = 'ok'): HistoryCellRow {
  const lines = [{ kind: 'add' as const, newNo: 26, text: lineText }];
  const editHunks = [{ oldString: '', newString: lineText, startLine: 26 }];
  const legacyContent = {
    type: 'diff' as const,
    file: 'models/account.js',
    addCount: 1,
    delCount: 0,
    lines,
    editHunks,
  };
  return {
    kind: 'cell',
    id,
    status: 'done',
    iconKind: 'edit' as any,
    title: 'Edit file · account.js',
    desc: '36 字符',
    presentation: {
      phase: 'completed',
      importance: 'primary',
      visibility: 'expanded',
      defaultExpanded: true,
    },
    defaultExpanded: true,
    diffStat: { add: 1, del: 0 },
    legacyContent,
    cell: {
      kind: 'patch',
      id,
      sessionId: '',
      timestamp: 0,
      files: [{ path: 'models/account.js', additions: 1, deletions: 0 }],
      status: 'done',
      diff: {
        file: 'models/account.js',
        addCount: 1,
        delCount: 0,
        lines: legacyContent.lines,
        editHunks: legacyContent.editHunks,
      },
    },
  };
}

describe('stabilizeTimelineRows — long-run rerender guard', () => {
  test('reuses unchanged edit diff rows even when map/build created new objects', () => {
    const prevRows = buildTimelineRows([mkDiffCellRow('edit-1', 'ok')], false);
    const nextRows = buildTimelineRows([mkDiffCellRow('edit-1', 'ok')], false);
    const stable = stabilizeTimelineRows(prevRows, nextRows);
    expect(stable[0]).toBe(prevRows[0]);
  });

  test('does not reuse edit diff rows when visible diff content changes', () => {
    const prevRows = buildTimelineRows([mkDiffCellRow('edit-1', 'ok')], false);
    const nextRows = buildTimelineRows([mkDiffCellRow('edit-1', 'changed')], false);
    const stable = stabilizeTimelineRows(prevRows, nextRows);
    expect(stable[0]).toBe(nextRows[0]);
    expect(stable[0]).not.toBe(prevRows[0]);
  });
});

import { estimateRowHeight, TIMELINE_ROW_ESTIMATE_SINGLE } from '../timelineRows';

describe('estimateRowHeight turn_summary', () => {
  function mkTurnSummaryRow(totalFiles: number): Row {
    const step: TimelineStep = {
      ...mkStep('ts-1', '本轮改动'),
      content: { type: 'turn_summary', turnId: 't1', totalFiles, totalAdds: 10, totalDels: 2, changes: [] } as any,
    };
    return { kind: 'single', step: wrapStepAsRowStep(step) };
  }

  test('turn_summary 按文件数估算, 远高于默认 single 估值', () => {
    const h9 = estimateRowHeight(mkTurnSummaryRow(9));
    expect(h9).toBe(96 + 9 * 44);
    expect(h9).toBeGreaterThan(TIMELINE_ROW_ESTIMATE_SINGLE * 5);
  });

  test('文件数极多时封顶, 缺 totalFiles 走兜底', () => {
    expect(estimateRowHeight(mkTurnSummaryRow(100))).toBe(620);
    const step: TimelineStep = { ...mkStep('ts-2', 'x'), content: { type: 'turn_summary' } as any };
    expect(estimateRowHeight({ kind: 'single', step: wrapStepAsRowStep(step) })).toBe(96 + 6 * 44);
  });

  test('普通 single 行仍是默认估值', () => {
    expect(estimateRowHeight({ kind: 'single', step: mkLegacyStepRow('s1', 'readfile') })).toBe(TIMELINE_ROW_ESTIMATE_SINGLE);
  });
});

describe('shouldWindowTimeline', () => {
  test('超大会话强制开窗; 短会话永不因 geometry 开窗; 中型会话不再等几何样本', async () => {
    const { shouldWindowTimeline, TIMELINE_FULL_RENDER_MAX, TIMELINE_WINDOW_SOFT_MIN } = await import('../timelineRows');
    expect(shouldWindowTimeline(TIMELINE_FULL_RENDER_MAX + 1, false)).toBe(true);
    expect(shouldWindowTimeline(TIMELINE_WINDOW_SOFT_MIN, true)).toBe(true);
    expect(shouldWindowTimeline(TIMELINE_WINDOW_SOFT_MIN - 1, true)).toBe(false);
    /* 几何未就绪也必须开窗, 否则 measureElement 永远挂不上、样本永远 0 */
    expect(shouldWindowTimeline(TIMELINE_WINDOW_SOFT_MIN + 1, false)).toBe(true);
    expect(shouldWindowTimeline(TIMELINE_WINDOW_SOFT_MIN + 1, true)).toBe(true);
    expect(shouldWindowTimeline(226, false)).toBe(true);
    expect(shouldWindowTimeline(47, false)).toBe(true);
  });
});

describe('waiting ask_user 必须可被 rowHasWaitingAsk 识别', () => {
  test('legacy askUser content status=waiting → isWaitingAskStep / rowHasWaitingAsk', () => {
    const step = wrapStepAsRowStep({
      kind: 'tool',
      id: 'ask-1',
      title: 'Ask you',
      status: 'running',
      iconKind: 'task' as any,
      content: {
        type: 'askUser',
        requestId: 'req-1',
        status: 'waiting',
        questions: [{ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    } as any);
    expect(isWaitingAskStep(step)).toBe(true);
    const single: Row = { kind: 'single', step };
    expect(rowHasWaitingAsk(single)).toBe(true);
    const activity: Row = {
      kind: 'activity',
      id: 'act-1',
      rows: [single],
      opCount: 1,
      hasActive: true,
    };
    expect(rowHasWaitingAsk(activity)).toBe(true);
  });

  test('interrupted / answered ask 不算 waiting', () => {
    const answered = wrapStepAsRowStep({
      kind: 'tool',
      id: 'ask-2',
      title: 'Ask you',
      status: 'done',
      iconKind: 'task' as any,
      content: {
        type: 'askUser',
        requestId: 'req-2',
        status: 'answered',
        questions: [{ question: '选哪个?', options: [{ label: 'A' }], answer: 'A' }],
      },
    } as any);
    expect(isWaitingAskStep(answered)).toBe(false);
    expect(rowHasWaitingAsk({ kind: 'single', step: answered })).toBe(false);

    const interrupted = wrapStepAsRowStep({
      kind: 'tool',
      id: 'ask-3',
      title: 'Ask you',
      status: 'interrupted',
      iconKind: 'task' as any,
      content: {
        type: 'askUser',
        requestId: 'req-3',
        status: 'waiting',
        questions: [{ question: '选哪个?', options: [{ label: 'A' }] }],
      },
    } as any);
    expect(isWaitingAskStep(interrupted)).toBe(false);
  });
});

describe('previousSnapshotId 穿越逐字段拷贝链 (P0-1 Undo 依据)', () => {
  test('diff content 的快照 id 不得在 buildHistoryCellFromStep 蒸发', async () => {
    const { buildHistoryCellFromStep } = await import('../mapTimelineToRows');
    const step: any = {
      kind: 'tool',
      id: 'wf-1',
      title: 'write_file',
      status: 'done',
      iconKind: 'file',
      content: {
        type: 'diff',
        file: 'a.md',
        addCount: 1,
        delCount: 0,
        lines: [{ kind: 'add', newNo: 1, text: 'x' }],
        editHunks: [{ oldString: '', newString: 'x', startLine: 1 }],
        coalescedCount: 3,
        previousSnapshotId: 'snap-abc123',
      },
    };
    const cell = buildHistoryCellFromStep(step, 'sess-1');
    expect(cell).not.toBeNull();
    expect((cell as any).diff?.previousSnapshotId).toBe('snap-abc123');
  });
});

describe('删除操作照常折叠', () => {
  test('delete_file 的 op_chip 行折进 activity, 不再独立占一行', async () => {
    const { collapseActivityRuns, rowStepIsDestructiveOp } = await import('../timelineRows');
    const mk = (id: string, content: any): any => ({
      kind: 'single',
      step: { kind: 'tool', id, title: id, status: 'done', iconKind: 'task', content },
    });
    const rows: any[] = [
      { kind: 'message', message: { id: 'm1', role: 'user', text: 'hi' } },
      mk('t1', { type: 'code', lines: [] }),
      mk('del', { type: 'op_chip', icon: 'trash', label: '删除文件', tone: 'err', deletionSnapshotId: 'x' }),
      mk('t2', { type: 'code', lines: [] }),
    ];
    /* 判据函数本身留着 (别处还在用它判语气/展开), 只是不再拿它豁免折叠 */
    expect(rowStepIsDestructiveOp(rows[2].step)).toBe(true);

    const out = collapseActivityRuns(rows as any);
    /* 顶层不该再有裸的 del 行 */
    expect(out.some((r: any) => r.kind === 'single' && r.step?.id === 'del')).toBe(false);
    /* 它在折叠里 —— 展开就能撤销 */
    const act = out.find((r: any) => r.kind === 'activity') as any;
    expect(JSON.stringify(act?.rows ?? [])).toContain('del');
  });

  test('op_chip 活动子行: 标题 = label · target, 没有展开区; delete_file 例外', async () => {
    const { activityChildTitle, rowBodyWouldBeEmpty } = await import('../timelineRows');
    const mk = (id: string, content: any): any => ({
      kind: 'single',
      step: { kind: 'tool', id, title: '扫描服务', status: 'done', iconKind: 'task', content },
    });
    const scan = mk('s', { type: 'op_chip', icon: 'search', label: '扫描运行服务', tone: 'primary' });
    expect(activityChildTitle(scan)).toBe('扫描运行服务');
    expect(rowBodyWouldBeEmpty(scan)).toBe(true);

    const adopt = mk('a', { type: 'op_chip', icon: 'plus', label: '接管现有服务', target: 'pid 4821', tone: 'ok' });
    expect(activityChildTitle(adopt)).toBe('接管现有服务 · pid 4821');

    const del = mk('d', { type: 'op_chip', icon: 'trash', label: '删除文件', target: '.tmp.mjs', tone: 'err', deletionSnapshotId: 'x' });
    expect(rowBodyWouldBeEmpty(del)).toBe(false);
  });

  test('非破坏性 op_chip (如进入计划模式) 照常折叠', async () => {
    const { rowStepIsDestructiveOp } = await import('../timelineRows');
    const plain: any = {
      kind: 'single',
      step: { kind: 'tool', id: 'p', title: 'p', status: 'done', iconKind: 'task',
              content: { type: 'op_chip', icon: 'plan', label: '进入计划模式', tone: 'primary' } },
    };
    expect(rowStepIsDestructiveOp(plain.step)).toBe(false);
  });
});

import { activityDigest, activityDigestSegments, activityDigestSummary, isHighValueStep } from '../timelineRows';
import { setGlobalLanguage } from '../../../hooks/useI18n';

function mkStepWithDiff(id: string, title: string, add: number, del: number): LegacyStepRow {
  const step = mkStep(id, title);
  (step as any).diffStat = { add, del };
  return wrapStepAsRowStep(step);
}

function mkThinkingStep(id: string, text: string, duration: string): LegacyStepRow {
  const step = mkStep(id, 'Thought', 'done');
  (step as any).iconKind = 'thinking';
  (step as any).duration = duration;
  (step as any).content = { type: 'thinking', text };
  return wrapStepAsRowStep(step);
}

describe('collapseActivityRuns — keepHighValue (标准模式)', () => {
  test('读/搜/写改统统折进一条 activity', () => {
    const rows: Row[] = [
      { kind: 'message', message: mkMessage('u1', 'user') },
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · a.ts') },
      { kind: 'single', step: mkLegacyStepRow('r2', 'Search · foo') },
      { kind: 'single', step: mkLegacyStepRow('e1', 'Edit · b.ts') },
      { kind: 'single', step: mkLegacyStepRow('r3', 'Readfile · c.ts') },
    ];
    const out = collapseActivityRuns(rows, { keepHighValue: true });
    expect(out.map(r => r.kind)).toEqual(['message', 'activity']);
    const act = out[1] as Extract<Row, { kind: 'activity' }>;
    expect(act.rows).toHaveLength(4);
  });

  test('diffStat 非零的 step (write_file 等) 豁免折叠 — 2026-09-01 三判回归一等公民', () => {
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · a.ts') },
      { kind: 'single', step: mkStepWithDiff('w1', 'Write file · b.ts', 12, 0) },
    ];
    const out = collapseActivityRuns(rows, { keepHighValue: true });
    expect(out.map(r => r.kind)).toEqual(['single', 'single']);
  });

  test('failed step 豁免折叠 (出错必须显眼)', () => {
    const failedStep = mkStep('f1', 'Execute shell · npm test');
    (failedStep as any).status = 'failed';
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · a.ts') },
      { kind: 'single', step: mkLegacyStepRow('r1b', 'Readfile · b.ts') },
      { kind: 'single', step: wrapStepAsRowStep(failedStep) },
      { kind: 'single', step: mkLegacyStepRow('r2', 'Readfile · c.ts') },
      { kind: 'single', step: mkLegacyStepRow('r2b', 'Readfile · d.ts') },
    ];
    const out = collapseActivityRuns(rows, { keepHighValue: true });
    expect(out.map(r => r.kind)).toEqual(['activity', 'single', 'activity']);
  });

  test('不传 options 保持原极简行为 (全折)', () => {
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · a.ts') },
      { kind: 'single', step: mkLegacyStepRow('e1', 'Edit · b.ts') },
    ];
    const out = collapseActivityRuns(rows);
    expect(out.map(r => r.kind)).toEqual(['activity']);
  });
});

describe('buildTimelineRows — foldRuns 第 4 参 (标准模式接线)', () => {
  test('foldRuns=true: 普通工具折成 activity; 缺省不折 (旧行为)', () => {
    const items: TimelineRow[] = [
      mkUserCellRow('u1', '你好'),
      mkLegacyStepRow('r1', 'Readfile · a.ts'),
      mkLegacyStepRow('r2', 'Search · foo'),
    ];
    const folded = buildTimelineRows(items, false, undefined, true, true);
    expect(folded.map(r => r.kind)).toEqual(['message', 'activity']);
    const plain = buildTimelineRows(items, false, undefined, undefined, true);
    expect(plain.every(r => r.kind !== 'activity')).toBe(true);
  });
});

describe('activityDigest — 脚注摘要行聚合', () => {
  test('每类一行: 动词 + 对象(basename 去重 ≤3) + 计数', () => {
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · src/a/types.ts') },
      { kind: 'single', step: mkLegacyStepRow('r2', 'Readfile · src/b/map.ts') },
      { kind: 'single', step: mkLegacyStepRow('r3', 'Readfile · src/b/map.ts') },
      { kind: 'single', step: mkLegacyStepRow('s1', 'Execute shell · npm test -w kernel') },
    ];
    const activity = collapseActivityRuns(rows)[0] as Extract<Row, { kind: 'activity' }>;
    const { lines, moreCount } = activityDigest(activity);
    expect(moreCount).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0].head).toBe('Readfile');
    expect(lines[0].count).toBe(3);
    expect(lines[0].detail).toBe('types.ts、map.ts'); /* basename + 去重 */
    expect(lines[1].head).toBe('Execute shell');
    expect(lines[1].detail).toBe('npm test -w kernel'); /* 命令原样 */
  });

  test('超过 maxLines 截断并报 moreCount', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'single' as const,
      step: mkLegacyStepRow(`s${i}`, `Tool${i} · arg`),
    }));
    const activity = collapseActivityRuns(rows)[0] as Extract<Row, { kind: 'activity' }>;
    const { lines, moreCount } = activityDigest(activity, 6);
    expect(lines).toHaveLength(6);
    expect(moreCount).toBe(2);
  });
});

describe('activityDigestSummary — Cursor 风格折叠头', () => {
  test('shell 不泄漏命令原文；Thought 保留时长/字数', () => {
    setGlobalLanguage('en');
    const rows: Row[] = [
      { kind: 'single', step: mkThinkingStep('t1', 'a'.repeat(2400), '10s') },
      { kind: 'single', step: mkThinkingStep('t2', 'b'.repeat(100), '1s') },
      { kind: 'single', step: mkThinkingStep('t3', 'c'.repeat(100), '1s') },
      { kind: 'single', step: mkLegacyStepRow('s1', 'Run command · ls demo-coupon/ 2>/dev/null || echo missing') },
      { kind: 'single', step: mkLegacyStepRow('s2', 'Execute shell · mkdir -p demo-coupon') },
    ];
    const activity = collapseActivityRuns(rows)[0] as Extract<Row, { kind: 'activity' }>;
    const summary = activityDigestSummary(activity);
    expect(summary).not.toMatch(/Thought/);
    /* 思考的时长/字数跟着思考一起走 —— 不再出现在有动作的摘要里 */
    expect(summary).not.toMatch(/chars/);
    expect(summary).toMatch(/Ran 2 commands/);
    expect(summary).not.toMatch(/ls demo-coupon/);
    expect(summary).not.toMatch(/mkdir/);
  });

  test('多读文件列出前两个 + 余量；单读展示 basename', () => {
    setGlobalLanguage('en');
    const multi = collapseActivityRuns([
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · src/a/types.ts') },
      { kind: 'single', step: mkLegacyStepRow('r2', 'Readfile · src/b/map.ts') },
      { kind: 'single', step: mkLegacyStepRow('r3', 'Readfile · src/b/map.ts') },
    ])[0] as Extract<Row, { kind: 'activity' }>;
    /* 溢出量写成 "and N more" 而不是 "+N" —— 右侧还有个表示行数的 "+12 -3", 两个 +N 会读串 */
    expect(activityDigestSummary(multi)).toBe('Read types.ts, map.ts and 1 more');

    const single = mkActivity([
      { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · src/a/types.ts') },
    ]);
    expect(activityDigestSummary(single)).toBe('Read types.ts');
  });

  test('中文短语；diff 合计挂末尾', () => {
    setGlobalLanguage('zh');
    const rows: Row[] = [
      { kind: 'single', step: mkThinkingStep('t1', '思考内容', '2s') },
      { kind: 'single', step: mkLegacyStepRow('s1', '执行命令 · npm test') },
      { kind: 'single', step: mkStepWithDiff('e1', 'patch · x.ts', 12, 3) },
    ];
    /* keepHighValue 会把有 diff 的拆出去 — 这里强制全折测摘要 */
    const activity = collapseActivityRuns(rows)[0] as Extract<Row, { kind: 'activity' }>;
    const summary = activityDigestSummary(activity);
    expect(summary).not.toMatch(/思考/);
    expect(summary).toMatch(/执行 1 条命令/);
    expect(summary).toMatch(/\+12 -3/);
    expect(summary).not.toMatch(/npm test/);
    expect(summary).toContain(' · ');
  });
});

describe('activityDigestSegments — head/rest 不许劈开一个词', () => {
  test('中文单个文件无明细时整词进 head', () => {
    setGlobalLanguage('zh');
    const activity = mkActivity([
      { kind: 'single', step: mkLegacyStepRow('r1', '读取文件') },
    ]);
    const segs = activityDigestSegments(activity, { withDiff: false });
    expect(segs[0]).toEqual({ head: '读取文件', rest: '' });
    /* 纯文本版必须仍是同一串, 别因为并段多出空格 */
    expect(activityDigestSummary(activity, { withDiff: false })).toBe('读取文件');
  });

  test('任何语言下 rest 都不以词字符开头', () => {
    for (const lang of ['zh', 'en'] as const) {
      setGlobalLanguage(lang);
      const activity = collapseActivityRuns([
        { kind: 'single', step: mkLegacyStepRow('r1', 'Readfile · src/a/types.ts') },
        { kind: 'single', step: mkLegacyStepRow('e1', '编辑文件') },
        { kind: 'single', step: mkLegacyStepRow('s1', 'Execute shell · npm test') },
        { kind: 'single', step: mkLegacyStepRow('q1', 'Search · foo') },
      ])[0] as Extract<Row, { kind: 'activity' }>;
      for (const seg of activityDigestSegments(activity)) {
        if (!seg.head || !seg.rest) continue;
        expect(seg.rest[0]).not.toMatch(/[\w一-龥]/);
      }
    }
    setGlobalLanguage('zh');
  });
});

describe('activityDigestSummary — 纯思考段', () => {
  test('整段只有思考时仍保留, 否则折叠头会变空', () => {
    const rows: Row[] = [
      { kind: 'single', step: mkLegacyStepRow('t1', '思考') },
      { kind: 'single', step: mkLegacyStepRow('t2', '思考') },
    ];
    const activity = collapseActivityRuns(rows)[0] as Extract<Row, { kind: 'activity' }>;
    expect(activityDigestSummary(activity)).toMatch(/思考|Thought/);
  });
});

describe('isHighValueStep', () => {
  test('failed 为高价值; 带 diffStat 的写改 2026-09-01 起也是; 读/搜不是', () => {
    /* 无 diffStat 的裸 Edit 标题行仍可折 (它没有可操作的 diff 卡); 有 diffStat 才豁免。 */
    expect(isHighValueStep(mkLegacyStepRow('a', 'Edit · x.ts'))).toBe(false);
    expect(isHighValueStep(mkStepWithDiff('b', 'apply_patch · y.ts', 3, 1))).toBe(true);
    const failed = mkStep('c', 'Execute shell · x');
    (failed as any).status = 'failed';
    expect(isHighValueStep(wrapStepAsRowStep(failed))).toBe(true);
    expect(isHighValueStep(mkLegacyStepRow('d', 'Readfile · z.ts'))).toBe(false);
    expect(isHighValueStep(mkLegacyStepRow('e', 'Search · q'))).toBe(false);
  });
});
