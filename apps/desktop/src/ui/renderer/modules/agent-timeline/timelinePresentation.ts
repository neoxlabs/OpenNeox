import type {
  StepContent,
  StepIconKind,
  StepStatus,
  TimelineDensity,
  TimelineNodeImportance,
  TimelineNodePhase,
  TimelinePresentation,
  TimelineRow,
} from './types';
import { isAnswerToolCard } from './toolCards/toolCardTypes';

export const TIMELINE_SETTLE_DELAY_MS = 420;
export const TIMELINE_COLLAPSE_AFTER_COMPLETE_MS = 900;
export const TIMELINE_TERMINAL_COLLAPSE_AFTER_COMPLETE_MS = 2200;
export const TOKEN_IDLE_WAITING_MS = 2500;

const EXPLORE_STATUS_PREFIXES = ['Explore agents', '探索 Agent'];
const GENERIC_CHAIN_STATUS_PREFIXES = [
  'Tool chain in progress',
  '工具链执行中',
  '工具链进行中',
];

const STATUS_PASSTHROUGH_PREFIXES = [
  'Tool is running',
  'Tool chain in progress',
  'Tool execution taking long',
  'Waiting for response',
  'API responding slowly',
  'Long wait',
  'Stream stalled',
  'Stream stall',
  'Running:',
  'Streaming:',
  'Writing ',
  'Explore agents',
  'Generating response',
  '工具运行中',
  '工具链执行中',
  '工具执行耗时较长',
  '等待响应中',
  'API 响应较慢',
  '长时间等待',
  '探索 Agent 运行中',
  '探索 Agent 仍在运行',
  '正在生成回复',
  '⚡',
  '▸',
];

function phaseForStatus(status: StepStatus): TimelineNodePhase {
  if (status === 'running' || status === 'pending') return 'active';
  if (status === 'awaiting') return 'awaiting';
  if (status === 'failed') return 'failed';
  return 'completed';
}

function isPrimaryContent(content: StepContent | undefined): boolean {
  if (!content || content.type === 'none') return false;
  return content.type === 'diff' ||
    content.type === 'turn_summary' ||
    content.type === 'plan' ||
    content.type === 'askUser' ||
    content.type === 'error' ||
    content.type === 'compaction' ||
    content.type === 'deep_research' ||
    content.type === 'target_continuation';
}

function isLiveContent(content: StepContent | undefined): boolean {
  if (!content || content.type === 'none') return false;
  if (content.type === 'askUser') return content.status === 'waiting';
  if (content.type === 'terminal' || content.type === 'diff') return !!content.streaming;
  if (content.type === 'delegation' || content.type === 'explore' || content.type === 'worker'
    || content.type === 'external_agent') {
    return content.status === 'running';
  }
  if (content.type === 'dag') return content.nodes?.some((n) => n.status === 'running') ?? false;
  return false;
}

function isDestructiveOpChip(content: StepContent | undefined): boolean {
  return content?.type === 'op_chip' && (content as { tone?: string }).tone === 'err';
}

function importanceForContent(content: StepContent | undefined, iconKind: StepIconKind): TimelineNodeImportance {
  if (isPrimaryContent(content)) return 'primary';
  if (isDestructiveOpChip(content)) return 'primary';
  if (iconKind === 'thinking' || content?.type === 'log' || content?.type === 'op_chip') return 'debug';
  return 'secondary';
}

function shouldExpandCompleted(content: StepContent | undefined, status: StepStatus, density: TimelineDensity): boolean {
  if (!content || content.type === 'none') return false;
  if (density === 'debug') return true;
  if (content.type === 'error') return false;
  if (isDestructiveOpChip(content)) return true;
  if (content.type === 'askUser') return true;
  if (content.type === 'neox_card' || content.type === 'timer_card' || isAnswerToolCard(content as any)) return true;
  if (content.type === 'turn_summary') return true;
  if (content.type === 'deep_research') return true;
  if (content.type === 'compaction') return status === 'failed';
  if (content.type === 'diff') return density !== 'minimal';
  if (content.type === 'terminal') return status === 'failed';
  if (content.type === 'delegation' || content.type === 'explore' || content.type === 'worker'
    || content.type === 'external_agent') {
    return true;
  }
  return false;
}

export function summarizeTimelineContent(content: StepContent | undefined): string | undefined {
  if (!content || content.type === 'none') return undefined;
  switch (content.type) {
    case 'diff':
      return `${content.file} +${content.addCount} -${content.delCount}`;
    case 'terminal':
      return content.command;
    case 'search':
      return typeof content.totalHits === 'number' ? `${content.totalHits} hits` : content.pattern;
    case 'readfile':
      return content.file;
    case 'turn_summary':
      return `${content.totalFiles} files, +${content.totalAdds} -${content.totalDels}`;
    case 'error':
      return content.message;
    case 'plan':
      return content.goal;
    case 'delegation':
    case 'explore':
      return content.summary || content.task || content.currentStatus;
    case 'external_agent':
      return content.task;
    case 'worker':
      return content.summary || content.task;
    case 'compaction':
      return typeof content.originalTokens === 'number' && typeof content.finalTokens === 'number'
        ? `${content.originalTokens} -> ${content.finalTokens} tokens`
        : undefined;
    default:
      return undefined;
  }
}

export function getTimelineStepPresentation(input: {
  status: StepStatus;
  iconKind: StepIconKind;
  content?: StepContent;
  density?: TimelineDensity;
}): TimelinePresentation {
  const { status, iconKind, content, density = 'normal' } = input;
  const phase = phaseForStatus(status);
  const importance = importanceForContent(content, iconKind);
  const hasContent = !!content && content.type !== 'none';
  const active = status === 'running' || status === 'pending';
  const live = isLiveContent(content);
  const completedExpand = shouldExpandCompleted(content, status, density);
  const defaultExpanded = hasContent && content?.type !== 'thinking' && (active || live || completedExpand);
  const terminalDoneShouldSettle = content?.type === 'terminal' && status === 'done';
  const noisyDoneShouldSettle =
    status === 'done' &&
    (content?.type === 'code' ||
      content?.type === 'search' ||
      content?.type === 'readfile' ||
      content?.type === 'web' ||
      content?.type === 'filelist' ||
      content?.type === 'log' ||
      (content?.type === 'op_chip' && !isDestructiveOpChip(content)));

  return {
    phase,
    importance,
    visibility: !hasContent
      ? 'summary'
      : defaultExpanded
        ? 'expanded'
        : 'collapsed',
    defaultExpanded,
    settleDelayMs: TIMELINE_SETTLE_DELAY_MS,
    collapseAfterCompleteMs: terminalDoneShouldSettle
      ? TIMELINE_TERMINAL_COLLAPSE_AFTER_COMPLETE_MS
      : noisyDoneShouldSettle
        ? TIMELINE_COLLAPSE_AFTER_COMPLETE_MS
        : undefined,
    summary: summarizeTimelineContent(content),
    suppressDuration: active && (content?.type !== 'terminal' || density === 'minimal'),
  };
}

/* ============================================================
 * Phase 3.12 兼容 helper — TimelineRow union 下的 tool/message 谓词访问
 *   HistoryCellRow (cell.kind 不在 user/assistant_text) 视作 tool row
 *   HistoryCellRow (cell.kind in user/assistant_text) 视作 message row
 *   LegacyStepRow 一律视作 tool row
 * ============================================================ */
function rowAsMsgInfo(r: TimelineRow): { role: 'user' | 'assistant' } | null {
  if (r.kind === 'cell' && r.cell.kind === 'user') return { role: 'user' };
  if (r.kind === 'cell' && r.cell.kind === 'assistant_text') return { role: 'assistant' };
  return null;
}
function rowAsToolInfo(r: TimelineRow): { status: StepStatus; iconKind: StepIconKind } | null {
  if (r.kind === 'cell') {
    if (r.cell.kind === 'user' || r.cell.kind === 'assistant_text') return null;
    return { status: r.status, iconKind: r.iconKind };
  }
  return { status: r.step.status, iconKind: r.step.iconKind };
}

function hasActiveExplore(items: TimelineRow[]): boolean {
  for (const it of items) {
    const tool = rowAsToolInfo(it);
    if (tool && tool.iconKind === 'task' && (tool.status === 'running' || tool.status === 'pending')) {
      return true;
    }
  }
  return false;
}

function isGenericBackendStatus(text: string): boolean {
  return GENERIC_CHAIN_STATUS_PREFIXES.some((p) => text.startsWith(p));
}

function canUseBackendStatus(text: string): boolean {
  return STATUS_PASSTHROUGH_PREFIXES.some((p) => text.startsWith(p));
}

export function pickTimelinePlaceholderText(status: string | undefined, items: TimelineRow[], isZh: boolean): string {
  const trimmed = (status || '').trim();
  if (trimmed && !isGenericBackendStatus(trimmed) && canUseBackendStatus(trimmed)) {
    if (EXPLORE_STATUS_PREFIXES.some((p) => trimmed.startsWith(p)) && !hasActiveExplore(items)) {
      return inferTimelineActivity(items, isZh);
    }
    return sanitizeTimelineStatus(trimmed, isZh, items);
  }
  return inferTimelineActivity(items, isZh);
}

export function sanitizeTimelineStatus(raw: string, isZh: boolean, items: TimelineRow[] = []): string {
  const text = raw.trim();
  if (!text) return inferTimelineActivity(items, isZh);
  if (/^(Waiting for response|API responding slowly|Long wait|Stream stalled|Stream stall)/i.test(text)) {
    return isZh ? '思考中' : 'Thinking';
  }
  if (/^(等待响应中|API 响应较慢|长时间等待|连接已恢复|重连中)/.test(text)) {
    return isZh ? '思考中' : 'Thinking';
  }
  if (/^(Tool is running|Tool chain in progress|Tool execution taking long|Running:|Streaming:|Writing |Explore agents)/i.test(text)) {
    return inferTimelineActivity(items, isZh);
  }
  if (/^(工具运行中|工具链执行中|工具执行耗时较长|探索 Agent 运行中|探索 Agent 仍在运行|正在生成回复)/.test(text)) {
    return inferTimelineActivity(items, isZh);
  }
  return text.replace(/\s*(?:\.\.\.|…)?\s*\d+s\s*$/i, '').replace(/\(\d+s[^)]*\)/i, '').trim() || inferTimelineActivity(items, isZh);
}

export function isBackendWaitingStatus(status: string | undefined): boolean {
  const text = (status || '').trim();
  if (!text) return false;
  return /Waiting for response|API responding slowly|Long wait|Stream stalled|等待响应|上游响应|长时间等待|连接已恢复|重连中/i.test(text);
}

export function inferTimelineActivity(items: TimelineRow[], isZh: boolean): string {
  const runningTools = items
    .map(rowAsToolInfo)
    .filter((t): t is NonNullable<typeof t> => !!t && (t.status === 'running' || t.status === 'pending'));
  const realAction = [...runningTools].reverse().find((t) => t.iconKind !== 'thinking');
  const chosen = realAction ?? [...runningTools].reverse()[0];
  if (chosen) {
    const action = getToolActionText(chosen.iconKind, isZh);
    return isZh ? `${action}中` : action;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const tool = rowAsToolInfo(it);
    if (tool) {
      if (tool.status === 'done' || tool.status === 'failed') return isZh ? '整理结果中' : 'Organizing results';
      return getToolActionText(tool.iconKind, isZh);
    }
    const msg = rowAsMsgInfo(it);
    if (msg) {
      if (msg.role === 'user') return isZh ? '思考中' : 'Thinking';
      return isZh ? '回复中' : 'Writing';
    }
  }
  return isZh ? '思考中' : 'Thinking';
}

export function getToolActionText(iconKind: string, isZh: boolean): string {
  const map: Record<string, [string, string]> = {
    edit: ['写入文件', 'Writing file'],
    file: ['读取文件', 'Reading file'],
    terminal: ['执行命令', 'Running command'],
    web: ['浏览网页', 'Browsing web'],
    search: ['搜索代码', 'Searching code'],
    database: ['查询数据库', 'Querying database'],
    generate: ['生成内容', 'Generating'],
    test: ['运行测试', 'Running tests'],
    thinking: ['思考', 'Thinking'],
    task: ['执行任务', 'Running task'],
    project: ['处理项目', 'Processing project'],
    summary: ['汇总', 'Summarizing'],
    retry: ['重试', 'Retrying'],
  };
  const pair = map[iconKind] || ['执行工具', 'Running tool'];
  return isZh ? pair[0] : pair[1];
}
