/* ============================================================
 * mapTimelineToRows — Phase 3.12 新 row 顶层映射 (设计 §6.2)
 *
 *   职责: TimelineEntry[] → TimelineRow[] (HistoryCell 驱动)
 *   - 12 个 covered HistoryCell.kind 走 HistoryCellRow.cell
 *   - 7 个 uncovered StepContent.type 走 LegacyStepRow.step (老 TimelineStep)
 *   - user_message / assistant_message → UserCell / AssistantTextCell
 *
 *   实现策略 (双轨过渡, Phase B+C):
 *   - 复用 mapTimeline.mapTimelineEntries() 拿到 TimelineItem[]
 *   - 12 个 buildXxxCell 把 TimelineMessage / TimelineStep+StepContent 转成 HistoryCell
 *   - row 级 presentation (status / icon / title / desc / meta / diffStat / presentation
 *     / groupId / groupLabel) 从 TimelineStep 原样透传 (避免重复 helper 实现)
 *
 *   后续 Phase E: TimelineSteps 切到这条管线, 老 mapTimelineEntries 在 Phase F 后退役.
 * ============================================================ */

import type {
  TimelineDensity,
  TimelineItem,
  TimelineMessage,
  TimelineRow,
  HistoryCellRow,
  StepContent,
  TimelineStep,
} from './types';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import type {
  HistoryCell,
  UserCell as UserCellData,
  AssistantTextCell as AssistantTextCellData,
  ReasoningCell as ReasoningCellData,
  ExecCell as ExecCellData,
  ExploreGroupCell as ExploreGroupCellData,
  McpToolCell as McpToolCellData,
  WebSearchCell as WebSearchCellData,
  PatchCell as PatchCellData,
  PatchCellFile,
  PlanCell as PlanCellData,
  BackgroundTaskCell as BackgroundTaskCellData,
  AskUserCell as AskUserCellData,
  SystemNoticeCell as SystemNoticeCellData,
} from './cells/HistoryCell';
import { mapTimelineEntries } from './mapTimeline';
import { getGlobalLanguage } from '../../hooks/useI18n';
import { createSegmentCache } from './segmentCache';

/* ============================================================
 * Top-level entry
 * ============================================================ */
type RowCacheSlot = { sig: string; row: TimelineRow | null };
const _rowCache = new WeakMap<object, RowCacheSlot>();

/** 测试用: 换一只新 WeakMap (不可枚举, 只能整体替换) */
export function __resetTimelineRowCacheForTests(): void {
  _rowCacheBox.map = new WeakMap();
}
const _rowCacheBox = { map: _rowCache };

const _entrySegmentCache = createSegmentCache<TimelineEntry, TimelineRow>();

/** 一条 entry 是否开启新的一轮 —— 与 buildTimelineRows / foldRuns 的 flush 边界一致 */
function isTurnBoundaryEntry(e: TimelineEntry): boolean {
  return (e as { type?: string })?.type === 'user_message';
}

/** 测试用: 清掉分段缓存 */
export function __resetTimelineSegmentCacheForTests(): void {
  _entrySegmentCache.reset();
}

/** 诊断用: 上一次分段的命中情况 */
export function getTimelineSegmentStats(): { segments: number; reused: number; recomputed: number } {
  return { ..._entrySegmentCache.stats };
}

export function mapTimelineEntriesToRows(
  entries: TimelineEntry[],
  workspacePath?: string,
  options?: { density?: TimelineDensity; sessionId?: string; agentMode?: 'work' | 'code' },
): TimelineRow[] {
  const sessionId = options?.sessionId ?? '';
  const sig = `${sessionId}|${getGlobalLanguage()}`;
  const ctxSig = `${sig}|${workspacePath ?? ''}|${options?.density ?? ''}|${options?.agentMode ?? ''}`;
  return _entrySegmentCache.run(
    entries,
    isTurnBoundaryEntry,
    (segment) => {
      /* 只对**变了的那一段**做真正的映射工作。
       * mapTimelineEntries 的跨条目判据 (coalesce / batchCount / lastErrorIndex) 都是
       * turn 内自洽的 —— coalesce 本来就按 currentTurnId 分组, 见该函数注释。 */
      const items = mapTimelineEntries(segment, workspacePath, {
        density: options?.density,
        agentMode: options?.agentMode,
      });
      const cache = _rowCacheBox.map;
      const rows: TimelineRow[] = [];
      for (const it of items) {
        const key = it as unknown as object;
        const hit = cache.get(key);
        if (hit !== undefined && hit.sig === sig) {
          if (hit.row) rows.push(hit.row);
          continue;
        }
        const r = itemToRow(it, sessionId);
        cache.set(key, { sig, row: r });
        if (r) rows.push(r);
      }
      return rows;
    },
    ctxSig,
  );
}

/* ============================================================
 * TimelineItem → TimelineRow 分流
 * ============================================================ */
function itemToRow(item: TimelineItem, sessionId: string): TimelineRow | null {
  if (item.kind === 'message') return messageItemToRow(item, sessionId);
  return stepItemToRow(item, sessionId);
}

function messageItemToRow(msg: TimelineMessage, sessionId: string): HistoryCellRow {
  const cell: UserCellData | AssistantTextCellData =
    msg.role === 'user'
      ? buildUserCell(msg, sessionId)
      : buildAssistantTextCell(msg, sessionId);
  return {
    kind: 'cell',
    cell,
    id: msg.id,
    status: 'done',
    iconKind: msg.role === 'user' ? 'task' : 'thinking',
    title: msg.role === 'user' ? 'You' : 'Assistant',
    timestamp: msg.timestamp,
    /* 原始毫秒跟着走 —— 折叠头算「工作了多久」要用, 中转丢了就只剩显示串「20:10」 */
    startedAtMs: msg.timestampMs,
    presentation: {
      phase: 'completed',
      importance: 'primary',
      visibility: 'inline',
      defaultExpanded: true,
    },
    defaultExpanded: true,
  };
}

function stepItemToRow(step: TimelineStep, sessionId: string): TimelineRow {
  const cell = stepToCell(step, sessionId);
  if (cell === null) {
    /* 7 个 uncovered StepContent.type — 走 legacy 路径 */
    return { kind: 'legacy_step', step };
  }
  const row: HistoryCellRow = {
    kind: 'cell',
    cell,
    id: step.id,
    status: step.status,
    tone: step.tone,
    iconKind: step.iconKind,
    brandIcon: step.brandIcon,
    title: step.title,
    desc: step.desc,
    timestamp: step.timestamp,
    duration: step.duration,
    startedAtMs: step.startedAtMs,
    meta: step.meta,
    diffStat: step.diffStat,
    presentation: step.presentation ?? {
      phase: step.status === 'running' ? 'active' : 'completed',
      importance: 'primary',
      visibility: 'inline',
      defaultExpanded: step.defaultExpanded ?? false,
    },
    defaultExpanded: step.defaultExpanded,
    groupId: step.groupId,
    groupLabel: step.groupLabel,
    legacyContent: step.content,
    blockedBy: step.blockedBy,
  };
  return row;
}

/* ============================================================
 * 公共 helper — TimelineStep.tsx 在 Phase E (lite) 调用, 直接拿 step 转 cell.
 *
 *   Phase E (full) 完成后 mapTimelineEntriesToRows 是唯一调用方,
 *   但当前消费者链仍吃 TimelineItem, TimelineStep.tsx 自己拆出 cell 切 HistoryCellRenderer.
 * ============================================================ */
export function buildHistoryCellFromStep(
  step: TimelineStep,
  sessionId: string = '',
): HistoryCell | null {
  return stepToCell(step, sessionId);
}

/* ============================================================
 * StepContent.type → HistoryCell.kind 分发 (12 covered + null for 7 uncovered)
 *
 *   13 cells (含 messages 2 个), 7 留 legacy:
 *     covered  : thinking / terminal / explore+search+readfile / web / diff+code+turn_summary*
 *                / plan / wakeup+error+compaction+log / worker+delegation+ background-task
 *                / askUser
 *     uncovered: op_chip / context_status / dag / network / filelist / readdoc /
 *                turn_summary (Phase 3.12 决策保留老视图)
 *
 *   * turn_summary 老 view 仍承担本轮改动汇总 (TurnSummaryView), 不映射到 PatchCell —
 *     PatchCell 用于单 file 改动 (edit_file / file_stream / write_file).
 * ============================================================ */
function stepToCell(step: TimelineStep, sessionId: string): HistoryCell | null {
  const content = step.content;
  if (!content) return null;
  switch (content.type) {
    case 'thinking':
      return buildReasoningCell(step, content, sessionId);
    case 'terminal':
      return buildExecCell(step, content, sessionId);
    case 'search':
    case 'readfile':
    case 'explore':
      return buildExploreGroupCell(step, content, sessionId);
    case 'web':
      return buildWebSearchCell(step, content, sessionId);
    case 'diff':
    case 'code':
      return buildPatchCell(step, content, sessionId);
    /* 走 legacy 路径 (StepContentRenderer 里那条早返回)。显式写出来而不是落进 default,
     * 是为了留下"这是有意的"这条记录 —— 它有自己的卡, 不该被塞进哪个 cell 形状里。 */
    case 'deep_research':
    case 'seen_images':
      return null;
    case 'plan':
      return buildPlanCell(step, content, sessionId);
    case 'wakeup':
    case 'error':
    case 'compaction':
    case 'target_continuation':
    case 'log':
      return buildSystemNoticeCell(step, content, sessionId);
    case 'worker':
    case 'delegation':
    case 'external_agent':
      /* 走 background_task 这条**无壳**路 —— 落到下面 uncovered 的 LegacyStepRow
       * 会套一层完整工具壳 (标题 + 折叠行), 跟卡片自己的名字重复一遍, 白占两行 */
      return buildBackgroundTaskCell(step, content, sessionId);
    case 'askUser':
      return buildAskUserCell(step, content, sessionId);
    /* 8 uncovered — 走 LegacyStepRow */
    case 'op_chip':
    case 'target_op':
    case 'context_status':
    case 'dag':
    case 'network':
    case 'data':
    case 'filelist':
    case 'change':
    case 'readdoc':
    case 'turn_summary':
      return null;
    case 'none':
      return null;
    default:
      return null;
  }
}

/* ============================================================
 * 12 cell builders — 直接产 HistoryCell 数据 (无 React)
 *
 *   命名: buildXxxCell. 输入 TimelineStep + StepContent 或 TimelineMessage,
 *   输出 HistoryCell 子类型. row 级 metadata (status/title/...) 由 stepItemToRow 透传.
 *
 *   注: MCP tool 单独识别 (toolName 以 mcp__ 前缀), 走 McpToolCell — 当前 mapTimeline
 *   产 StepContent='code' 兜底, 这里在 stepToCell 之前需要额外判一下 (TODO Phase C 二期).
 * ============================================================ */

function makeBase(id: string, sessionId: string, timestamp?: number | string, sequence?: number): {
  id: string;
  sessionId: string;
  timestamp: number;
  sequence?: number;
} {
  const ts = typeof timestamp === 'number' ? timestamp : Date.now();
  return { id, sessionId, timestamp: ts, sequence };
}

function buildUserCell(msg: TimelineMessage, sessionId: string): UserCellData {
  return {
    ...makeBase(msg.id, sessionId),
    kind: 'user',
    text: msg.text,
    attachments: msg.attachments,
    injectionPending: msg.injectionPending,
  };
}

function buildAssistantTextCell(msg: TimelineMessage, sessionId: string): AssistantTextCellData {
  return {
    ...makeBase(msg.id, sessionId),
    kind: 'assistant_text',
    text: msg.text,
    phase: 'narrative',
    streaming: !!msg.streaming,
    turnTokens: msg.turnTokens,
    turnTps: msg.turnTps,
    turnUsage: msg.turnUsage,
    model: msg.model,
  };
}

function buildReasoningCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'thinking' }>,
  sessionId: string,
): ReasoningCellData {
  const firstLine = (content.text || '').split('\n', 1)[0] || '';
  const m = firstLine.match(/^\s*\*\*(.+?)\*\*/);
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'reasoning',
    text: content.text || '',
    headerBold: m ? m[1] : undefined,
    transcriptOnly: false,
  };
}

function buildExecCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'terminal' }>,
  sessionId: string,
): ExecCellData {
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'exec',
    command: content.command || '',
    output: content.output || '',
    toolId: content.toolId,
    pid: content.pid,
    backgrounded: content.backgrounded,
    exitCode: content.exitCode,
    durationMs: undefined,
    status: step.status === 'running' ? 'running'
      : step.status === 'failed' ? 'error'
      : 'done',
  };
}

function buildExploreGroupCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'search' | 'readfile' | 'explore' }>,
  sessionId: string,
): ExploreGroupCellData {
  const ops: ExploreGroupCellData['ops'] = [];
  let task: string | undefined;
  let role: string | undefined;
  let summary: string | undefined;
  let error: string | undefined;
  let currentStatus: string | undefined;
  let toolCount: number | undefined;
  let tokens: number | undefined;
  let elapsed: number | undefined;
  let groupMembers: ExploreGroupCellData['groupMembers'];
  if (content.type === 'search') {
    ops.push({
      tool: content.tool || 'search',
      target: content.pattern || '',
      status: step.status === 'running' ? 'running' : 'done',
      resultHint: typeof content.totalHits === 'number'
        ? (getGlobalLanguage() === 'zh' ? `${content.totalHits} 命中` : `${content.totalHits} hits`)
        : undefined,
    });
  } else if (content.type === 'readfile') {
    ops.push({
      tool: 'read',
      target: content.file || '',
      status: step.status === 'running' ? 'running' : 'done',
      resultHint: typeof content.totalLines === 'number' ? `${content.totalLines} lines` : undefined,
    });
  } else {
    task = content.task;
    role = content.role;
    summary = content.summary;
    error = content.error;
    currentStatus = content.currentStatus;
    toolCount = content.toolCount;
    tokens = content.tokens;
    elapsed = content.elapsed;
    groupMembers = content.groupMembers;
    const records = content.toolRecords ?? [];
    for (const r of records) {
      ops.push({
        tool: r.name || 'tool',
        target: r.args || '',
        durationMs: r.duration,
        status: r.status,
        agentId: r.agentId,
        resultHint: r.resultHint,
      });
    }
  }
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'explore_group',
    ops,
    status: step.status === 'running' ? 'running' : 'done',
    task,
    role,
    summary,
    error,
    currentStatus,
    toolCount,
    tokens,
    elapsed,
    groupMembers,
  };
}

function buildWebSearchCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'web' }>,
  sessionId: string,
): WebSearchCellData {
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'web_search',
    query: content.query || content.url || '',
    resultCount: Array.isArray(content.results) ? content.results.length : undefined,
    status: step.status === 'running' ? 'searching' : 'done',
    variant: content.kind,
    url: content.url,
    results: content.results,
    bytes: content.bytes,
    total: content.total,
  };
}

function buildPatchCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'diff' | 'code' }>,
  sessionId: string,
): PatchCellData {
  let files: PatchCellFile[] = [];
  let diff: PatchCellData['diff'];
  let code: PatchCellData['code'];
  if (content.type === 'diff') {
    files = [{
      path: content.file || '',
      additions: content.addCount,
      deletions: content.delCount,
    }];
    diff = {
      file: content.file || '',
      addCount: content.addCount,
      delCount: content.delCount,
      lines: content.lines,
      editHunks: content.editHunks,
      coalescedCount: content.coalescedCount,
      streaming: content.streaming,
      previousSnapshotId: content.previousSnapshotId,
    };
  } else {
    code = {
      lines: content.lines,
      progress: content.progress,
      progressText: content.progressText,
      surfaceRef: content.surfaceRef,
    };
  }
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'patch',
    files,
    status: step.status === 'running' ? 'applying'
      : step.status === 'failed' ? 'failed'
      : 'done',
    diff,
    code,
  };
}

function buildPlanCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'plan' }>,
  sessionId: string,
): PlanCellData {
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'plan',
    explanation: content.goal,
    steps: (content.steps || []).map((s) => ({
      text: s.content,
      status: (s.status === 'pending' || s.status === 'in_progress' || s.status === 'completed' || s.status === 'skipped')
        ? s.status
        : 'pending',
      ...(s.phase ? { phase: s.phase } : {}),
      ...(typeof s.estimateSec === 'number' ? { estimateSec: s.estimateSec } : {}),
    })),
    frozen: !!content.frozen,
    planPath: content.planPath,
  };
}

function buildBackgroundTaskCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'worker' | 'delegation' | 'external_agent' }>,
  sessionId: string,
): BackgroundTaskCellData {
  const variant: 'worker' | 'delegation' | 'external' =
    content.type === 'worker' ? 'worker'
      : content.type === 'external_agent' ? 'external'
        : 'delegation';
  const summary = content.summary || '';
  const status = content.status === 'running' ? 'running'
    : content.status === 'completed' ? 'completed'
    : content.status === 'failed' || content.status === 'error' ? 'failed'
    : 'completed';
  const elapsedSeconds = step.startedAtMs ? Math.max(0, Math.round((Date.now() - step.startedAtMs) / 1000)) : 0;
  const toolUseCount = (variant === 'delegation' && 'toolCount' in content && typeof content.toolCount === 'number')
    ? content.toolCount
    : 0;
  const roleName = 'roleName' in content ? content.roleName : undefined;
  const role = 'role' in content ? content.role : undefined;
  const model = 'model' in content ? content.model : undefined;
  const agentId = ('agentId' in content && content.agentId) ? content.agentId : undefined;
  const displayName = 'displayName' in content ? content.displayName : undefined;
  const branch = 'branch' in content ? content.branch : undefined;
  const changedFileCount = 'changedFiles' in content ? content.changedFiles?.length : undefined;
  const toolCallId = 'toolCallId' in content ? content.toolCallId : undefined;
  const currentStatus = 'currentStatus' in content ? content.currentStatus : undefined;
  const isBackground = 'isBackground' in content ? content.isBackground : undefined;
  const toolRecords = 'toolRecords' in content ? content.toolRecords : undefined;
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'background_task',
    variant,
    taskId: agentId || step.id,
    name: displayName || roleName || role || (variant === 'worker' ? 'worker' : 'agent'),
    description: content.task || summary || '',
    status,
    elapsedSeconds,
    toolUseCount,
    summary,
    branch,
    changedFileCount,
    ...(toolCallId ? { taskId: toolCallId } : {}),
    error: content.error,
    agentId,
    role,
    roleName,
    model,
    currentStatus,
    isBackground,
    toolRecords,
  };
}

function buildAskUserCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'askUser' }>,
  sessionId: string,
): AskUserCellData {
  const status = content.status === 'waiting' ? 'waiting'
    : content.status === 'answered' ? 'answered'
    : content.status === 'timeout' ? 'expired'
    : content.status === 'interrupted' ? 'dismissed'
    : 'waiting';
  return {
    ...makeBase(step.id, sessionId, step.startedAtMs),
    kind: 'ask_user',
    toolCallId: content.requestId || step.id,
    questions: content.questions,
    status,
    answers: content.attemptedAnswers,
    error: content.error,
    createdAt: content.createdAt,
    timeoutSec: content.timeoutSec,
  };
}

function buildSystemNoticeCell(
  step: TimelineStep,
  content: Extract<StepContent, { type: 'wakeup' | 'error' | 'compaction' | 'target_continuation' | 'log' }>,
  sessionId: string,
): SystemNoticeCellData {
  const base = makeBase(step.id, sessionId, step.startedAtMs);
  if (content.type === 'wakeup') {
    return {
      ...base,
      kind: 'system_notice',
      subtype: 'wakeup',
      payload: {
        status: content.status,
        reason: content.reason,
        prompt: content.prompt,
        delaySeconds: content.delaySeconds,
        dueAtMs: content.dueAtMs,
        dueAtIso: content.dueAtIso,
        clamped: content.clamped,
        message: content.message,
      },
    };
  }
  if (content.type === 'error') {
    return {
      ...base,
      kind: 'system_notice',
      subtype: 'error',
      payload: {
        code: content.code,
        message: content.message,
        suggestion: content.suggestion,
        action: content.action,
        /* 这里是逐字段重建, 漏一个字段就等于该字段在这条路径上不存在 ——
         * requestId 就是这么丢过一次的 (StepContent 有、行模型没有, 卡片上那行 id 不渲染). */
        requestId: content.requestId,
        repeatCount: content.repeatCount,
        lastAt: content.lastAt,
      },
    };
  }
  if (content.type === 'compaction') {
    return {
      ...base,
      kind: 'system_notice',
      subtype: 'compact',
      payload: {
        status: content.status,
        originalTokens: content.originalTokens,
        finalTokens: content.finalTokens,
        budgetTokens: content.budgetTokens,
        originalMsgs: content.originalMsgs,
        keptMsgs: content.keptMsgs,
        droppedMsgs: content.droppedMsgs,
        compressionBuckets: content.compressionBuckets,
        compressionTotalBuckets: content.compressionTotalBuckets,
        compressionCompletedBuckets: content.compressionCompletedBuckets,
        compressionSummaryModel: content.compressionSummaryModel,
        errorDetail: content.errorDetail,
      },
    };
  }
  if (content.type === 'target_continuation') {
    return {
      ...base,
      kind: 'system_notice',
      subtype: 'target_continue',
      payload: {
        iteration: content.iteration,
        consecutiveBlocks: content.consecutiveBlocks,
      },
    };
  }
  /* type === 'log' */
  return {
    ...base,
    kind: 'system_notice',
    subtype: 'log',
    payload: {
      level: content.level,
      message: content.message,
    },
  };
}

/* ============================================================
 * McpToolCell 暂未接 (TODO Phase C 二期):
 *   stepToCell 当前没区分 MCP tool — toolName 以 'mcp__' 前缀的 tool_call/tool_result
 *   现在 StepContent='code'/'terminal' 兜底, 卷进 PatchCell/ExecCell.
 *   要真正区分需要 mapTimeline 把 MCP 元数据塞进 StepContent (或 step.title 暴露),
 *   再加一个判分支. 留 Phase 5 做.
 * ============================================================ */
