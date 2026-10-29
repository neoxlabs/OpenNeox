import {
  estimateRowHeight,
  rowStepContentTypeHint,
  rowStepIsPlan,
  rowStepIsTurnSummary,
  type Row,
} from './timelineRows';

export type RowGeometryKind =
  | 'message'
  | 'turn_fold'
  | 'activity'
  | 'group'
  | 'single'
  | 'single:turn_summary'
  | 'single:plan'
  | 'single:diff'
  | 'single:terminal'
  | 'default';

const MAX_SAMPLES = 24;
const READY_MIN_SAMPLES = 4;

const samplesByKind = new Map<RowGeometryKind, number[]>();

/** 静态兜底 — 比旧常量更接近真高, 冷启动开窗也不至于差 200px */
const FALLBACK_BY_KIND: Record<RowGeometryKind, number> = {
  message: 168,
  activity: 280,
  group: 96,
  single: 64,
  'turn_fold': 44,
  'single:turn_summary': 320,
  'single:plan': 300,
  'single:diff': 320,
  'single:terminal': 220,
  default: 80,
};

export function rowGeometryKind(row: Row): RowGeometryKind {
  if (row.kind === 'message') return 'message';
  if (row.kind === 'turn_fold') return 'turn_fold';
  if (row.kind === 'activity') return 'activity';
  if (row.kind === 'group') return 'group';
  if (row.kind === 'single') {
    if (rowStepIsTurnSummary(row.step)) return 'single:turn_summary';
    if (rowStepIsPlan(row.step)) return 'single:plan';
    const ct = rowStepContentTypeHint(row.step) ?? '';
    if (
      ct === 'diff' ||
      ct === 'file_change' ||
      ct === 'patch' ||
      ct === 'edit' ||
      ct === 'write' ||
      ct === 'coalesced_file_change'
    ) {
      return 'single:diff';
    }
    if (ct === 'terminal' || ct === 'shell' || ct === 'bash' || ct === 'command') {
      return 'single:terminal';
    }
    return 'single';
  }
  return 'default';
}

export function rememberMeasuredRowHeight(kind: RowGeometryKind, height: number): void {
  if (!Number.isFinite(height) || height < 24 || height > 4000) return;
  const h = Math.round(height);
  let arr = samplesByKind.get(kind);
  if (!arr) {
    arr = [];
    samplesByKind.set(kind, arr);
  }
  arr.push(h);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
}

export function medianKindHeight(kind: RowGeometryKind): number | undefined {
  const arr = samplesByKind.get(kind);
  if (!arr || arr.length === 0) return undefined;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid];
}

export function kindSampleCount(kind: RowGeometryKind): number {
  return samplesByKind.get(kind)?.length ?? 0;
}

/** message / activity / single 族各至少 READY_MIN_SAMPLES → 认为可开中型窗口 */
export function isTimelineGeometryReady(): boolean {
  const singleFamily =
    kindSampleCount('single') +
    kindSampleCount('single:diff') +
    kindSampleCount('single:plan') +
    kindSampleCount('single:terminal') +
    kindSampleCount('single:turn_summary');
  const foldFamily = kindSampleCount('activity') + kindSampleCount('turn_fold');
  return (
    kindSampleCount('message') >= READY_MIN_SAMPLES &&
    foldFamily >= READY_MIN_SAMPLES &&
    singleFamily >= READY_MIN_SAMPLES
  );
}

/**
 * 带几何学习的估高: 中位数 > 改进静态兜底 > 原有内容启发 (message 长度 / turn_summary)
 */
export function estimateRowHeightWithGeometry(row: Row): number {
  const kind = rowGeometryKind(row);
  const median = medianKindHeight(kind);
  if (median !== undefined) return median;

  if (kind === 'message' || kind === 'single:turn_summary') {
    return estimateRowHeight(row);
  }

  return FALLBACK_BY_KIND[kind] ?? FALLBACK_BY_KIND.default;
}

/** 测试用复位 */
export function __resetRowHeightGeometryForTests(): void {
  samplesByKind.clear();
}
