import type {
  HistoryCellRow,
  LegacyStepRow,
  StepIconKind,
  StepStatus,
  TimelineItem,
  TimelineMessage,
  TimelineRow,
  TimelineStep,
} from "./types";
import { getGlobalLanguage } from "../../hooks/useI18n";
import { createSegmentCache } from "./segmentCache";
import {
  cacheHistoryMessage, cachedHistoryMessage, mergeActivityRow, rowForActivity, rowForCluster, rowForGroup,
  rowForMessage, rowForSingle, rowWithActiveFlag, rowWithGroupLabel,
} from "./activeTurnRows";
import { isPlainInternalTitle, plainInternalKind } from "./workPlainPresentation";
import { rowStepIsGeneratedImage, spliceImagesAfterAnswer, isAnswerToolCard, turnMakesFile } from "./turnFoldImages";
import { mcpServerLabel, mcpToolLabel } from "./mcpNames";

function _isZh(): boolean { return getGlobalLanguage() === "zh"; }

export const ACTIVITY_REVEAL_INITIAL_COUNT = 12;
export const ACTIVITY_REVEAL_CHUNK_SIZE = 8;
export const ACTIVITY_REVEAL_CHUNK_MS = 90;

export const TIMELINE_WINDOW_OVERSCAN_PX = 1800;
export const TIMELINE_WINDOW_MIN_ROWS = 18;
export const TIMELINE_FULL_RENDER_MAX = 400;
export const TIMELINE_WINDOW_SOFT_MIN = 32;
export const TIMELINE_ROW_ESTIMATE_DEFAULT = 72;
export const TIMELINE_ROW_ESTIMATE_MESSAGE = 168;
/* 旧值 118 严重偏低 (真高常 280~350) — 作内容启发的下限时仍会被 geometry 覆盖 */
export const TIMELINE_ROW_ESTIMATE_ACTIVITY = 280;
/** 折叠行是一条固定高度的摘要行 (图标 + 一行文字 + 统计角标) */
export const TIMELINE_ROW_ESTIMATE_TURN_FOLD = 44;
export const TIMELINE_ROW_ESTIMATE_GROUP = 96;
export const TIMELINE_ROW_ESTIMATE_SINGLE = 64;

/* ============================================================
 * RowStep — Phase 3.12 消费者侧的统一 step 抽象
 *
 *   12 covered → HistoryCellRow (字段直接在顶层: id/status/iconKind/title/...)
 *   7 uncovered → LegacyStepRow (字段在 .step 里, content.type 是原 StepContent.type)
 *   双轨迁移期仍允许原始 TimelineStep, 避免旧 mapTimelineEntries 调用链白屏.
 *
 *   下方所有 helper 用 rowStepXxx 系列访问器, 不直接解构, 保证两 shape 都正确.
 *   特殊判定 (isAskWaiting / isPlan / isTurnSummary / isDiff) 跨两 shape 用统一函数.
 * ============================================================ */
export type RowStep = HistoryCellRow | LegacyStepRow | TimelineStep;

function isHistoryCellRow(value: unknown): value is HistoryCellRow {
  return !!value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "cell"
    && "cell" in value;
}

function isLegacyStepRow(value: unknown): value is LegacyStepRow {
  const step = (value as { step?: unknown } | null | undefined)?.step;
  return !!value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "legacy_step"
    && !!step
    && typeof step === "object";
}

export function rowStepLegacyStep(s: RowStep): TimelineStep {
  return isLegacyStepRow(s) ? s.step : s as TimelineStep;
}

/** 这一步的纯文本输出行 (code 内容) —— 两条渲染路径都认; 没有就是 undefined */
export function rowStepCodeLines(s: RowStep): string[] | undefined {
  if (isHistoryCellRow(s)) {
    const c = s.cell as { kind?: string; code?: { lines?: Array<{ text: string }> } };
    return c.kind === "patch" && c.code?.lines ? c.code.lines.map((l) => l.text) : undefined;
  }
  const content = rowStepLegacyStep(s).content as { type?: string; lines?: Array<{ text: string }> } | undefined;
  return content?.type === "code" && Array.isArray(content.lines) ? content.lines.map((l) => l.text) : undefined;
}

export function rowStepId(s: RowStep): string {
  return isHistoryCellRow(s) ? s.id : rowStepLegacyStep(s).id;
}
export function rowStepStatus(s: RowStep): StepStatus {
  return isHistoryCellRow(s) ? s.status : rowStepLegacyStep(s).status;
}
export function rowStepIconKind(s: RowStep): StepIconKind {
  return isHistoryCellRow(s) ? s.iconKind : rowStepLegacyStep(s).iconKind;
}
export function rowStepAppIcon(s: RowStep): string | undefined {
  if (isHistoryCellRow(s)) return s.brandIcon;
  const step = rowStepLegacyStep(s);
  const c = step.content;
  if (c && c.type === 'computer' && c.icon) return c.icon;
  return step.brandIcon;
}
export function rowStepTitle(s: RowStep): string {
  return isHistoryCellRow(s) ? s.title : rowStepLegacyStep(s).title;
}
export function rowStepDesc(s: RowStep): string | undefined {
  return isHistoryCellRow(s) ? s.desc : rowStepLegacyStep(s).desc;
}
export function rowStepDuration(s: RowStep): string | undefined {
  return isHistoryCellRow(s) ? s.duration : rowStepLegacyStep(s).duration;
}
export function rowStepStartedAtMs(s: RowStep): number | undefined {
  return isHistoryCellRow(s) ? s.startedAtMs : rowStepLegacyStep(s).startedAtMs;
}
export function rowStepMeta(s: RowStep): string[] | undefined {
  return isHistoryCellRow(s) ? s.meta : rowStepLegacyStep(s).meta;
}
export function rowStepDiffStat(s: RowStep): { add: number; del: number } | undefined {
  return isHistoryCellRow(s) ? s.diffStat : rowStepLegacyStep(s).diffStat;
}
export function rowStepGroupId(s: RowStep): string | undefined {
  return isHistoryCellRow(s) ? s.groupId : rowStepLegacyStep(s).groupId;
}
export function rowStepGroupLabel(s: RowStep): string | undefined {
  return isHistoryCellRow(s) ? s.groupLabel : rowStepLegacyStep(s).groupLabel;
}
/** content kind 提示: HistoryCell → cell.kind; legacy → content.type */
export function rowStepContentTypeHint(s: RowStep): string | undefined {
  if (isHistoryCellRow(s)) return s.cell.kind;
  return rowStepLegacyStep(s).content?.type;
}
/** 是否 ask_user 且等待用户回答 */
export function rowStepIsAskWaiting(s: RowStep): boolean {
  if (isHistoryCellRow(s)) {
    return s.status !== "interrupted"
      && s.cell.kind === "ask_user"
      && s.cell.status === "waiting";
  }
  const step = rowStepLegacyStep(s);
  return step.status !== "interrupted"
    && step.content?.type === "askUser"
    && step.content.status === "waiting";
}
export function rowStepIsCompaction(s: RowStep): boolean {
  if (isHistoryCellRow(s)) {
    return s.cell.kind === "system_notice"
      && (s.cell as { subtype?: string }).subtype === "compact";
  }
  return rowStepLegacyStep(s).content?.type === "compaction";
}
/** Target 续跑分隔线 — 与 compaction 一样豁免 activity 折叠. */
export function rowStepIsTargetContinue(s: RowStep): boolean {
  if (isHistoryCellRow(s)) {
    return s.cell.kind === "system_notice"
      && (s.cell as { subtype?: string }).subtype === "target_continue";
  }
  return rowStepLegacyStep(s).content?.type === "target_continuation";
}
export function rowStepIsPlan(s: RowStep): boolean {
  if (isHistoryCellRow(s)) return s.cell.kind === "plan";
  return rowStepLegacyStep(s).content?.type === "plan";
}
export function rowStepIsTurnSummary(s: RowStep): boolean {
  if (isHistoryCellRow(s)) return false;
  return rowStepLegacyStep(s).content?.type === "turn_summary";
}
export function rowStepIsRichCard(s: RowStep): boolean {
  if (isHistoryCellRow(s)) return false;
  const c = rowStepLegacyStep(s).content, t = c?.type;
  /* 生图产物 (generate_image / edit_image) 同档: 它是这一轮的答案, 见 turnFoldImages.ts。答案型工具卡 (天气 / 日程…) 也是 */
  return rowStepIsGeneratedImage(t) || t === "neox_card" || t === "timer_card" || isAnswerToolCard(c as any);
}

export function rowStepIsBlocked(s: RowStep): boolean {
  if (isHistoryCellRow(s)) return !!(s as { blockedBy?: string }).blockedBy;
  return !!rowStepLegacyStep(s).blockedBy;
}

export function rowStepIsDestructiveOp(s: RowStep): boolean {
  if (isHistoryCellRow(s)) return false;
  const c = rowStepLegacyStep(s).content;
  return c?.type === "op_chip" && (c as { tone?: string }).tone === "err";
}

/* ============================================================
 * Row union
 * ============================================================ */
export type Row =
  | { kind: "single"; step: RowStep }
  | { kind: "group"; id: string; label: string; items: RowStep[] }
  | {
      kind: "cluster";
      id: string;
      key: string;
      iconKind: StepIconKind;
      head: string;
      items: RowStep[];
    }
  | { kind: "message"; message: TimelineMessage }
  /* 极简模式: 两条 agent 消息之间的整段工具活动折叠成一行, 点开才显示完整卡片列表. */
  | {
      kind: "activity";
      id: string;
      rows: Row[];
      opCount: number;
      hasActive: boolean;
      inActiveTurn?: boolean;
      summary?: string;
    }
  | {
      kind: "turn_fold";
      id: string;
      rows: Row[];
      /** 折进去的工具调用条数 (不含思考 —— 思考不是操作, 见 turnFoldStats) */
      opCount: number;
      /** 折进去的思考步数 */
      thinkCount: number;
      /** 改动过的文件数 */
      fileCount: number;
      /** 累计新增 / 删除行数 */
      addCount: number;
      delCount: number;
      /** 本轮耗时 (ms); 拿不到时间戳时为 undefined, 不猜 */
      durationMs?: number;
      /** 折进去的内容里有没有失败 —— 有就不该显示成"一切顺利" */
      hasFailure: boolean;
      /** 这一轮里有没有被中断的步骤 —— 用户点了停止。跟"失败"必须分开说:
       *  说成失败会让用户以为是程序出问题, 而且中断前很可能什么都没输出,
       *  折叠头上不标一下就完全没有"停过"的痕迹。 */
      hasInterrupted: boolean;
    }
  /* Work 正在跑的这一轮: 工作行收成一张进度卡 (见 workProgress.ts)。只在渲染前由 withWorkProgressCard 生成,
   * 不进 buildTimelineRows 的段缓存 —— 它跟 activity 一样把子行原样带着。 */
  | { kind: "work_progress"; id: string; rows: Row[];  ask: string };

/** 最少 N 条才折叠成 cluster, 否则散开 */
export const CLUSTER_MIN = 3;

/** 从 step.title 拆第一段 (e.g. "Read file · a.ts" → "Read file") */
export function headOfTitle(t: string): string {
  const i = t.indexOf(" · ");
  return i > 0 ? t.slice(0, i) : t;
}
export function clusterKey(step: RowStep): string {
  return `${rowStepIconKind(step)}:${headOfTitle(rowStepTitle(step))}`;
}

const UNCLUSTERABLE_HEADS = new Set([
  "Write file",
  "Write",
  "Edit",
  "Edit file",
  "写入文件",
  "编辑文件",
  "修改文件",
]);

export function isWaitingAskStep(step: RowStep | null | undefined): boolean {
  return !!step && rowStepIsAskWaiting(step);
}

export function isClusterable(step: RowStep, pinnedSingleStepIds?: ReadonlySet<string>): boolean {
  if (isWaitingAskStep(step)) return false;
  if (rowStepIsBlocked(step)) return false;
  if (rowStepStatus(step) === "running") return false;
  if (UNCLUSTERABLE_HEADS.has(headOfTitle(rowStepTitle(step)))) return false;
  if (pinnedSingleStepIds && pinnedSingleStepIds.has(rowStepId(step))) return false;
  return true;
}

export function pinnedSetAdd(set: Set<string>, id: string, cap: number): void {
  if (set.has(id)) set.delete(id);
  set.add(id);
  while (set.size > cap) {
    const oldest = set.keys().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * row key — 用于 React key / freshness 缓存 / 调试日志.
 *
 * Phase C 修复: 同一 step 在 timeline 不同阶段会落进不同 row.kind (single ↔ cluster ↔ activity),
 *   旧策略 kind-prefix key 一变 React 就整行 unmount → 用户看到抖动 / spinner 闪烁.
 *   新策略: **step 命名空间统一 key**, 只要第一个 step.id 稳定, 无论落成什么 kind key 都是 `s-<stepId>`.
 *   同一 row 内容变化走 reconcile (子组件 memo/kind 内自处理), 不再 unmount 整行.
 */
export function rowKeyOf(r: Row, index: number): string {
  const stepIds = rowStepIds(r);
  if (stepIds.length > 0) return `s-${stepIds[0]}`;
  if (r.kind === "message") return `m-${r.message.id}`;
  if (r.kind === "group" || r.kind === "cluster" || r.kind === "activity" || r.kind === "turn_fold" || r.kind === "work_progress") return r.id;
  return `g-${index}`;
}

export function rowStepIds(row: Row): string[] {
  if (row.kind === "single") return [rowStepId(row.step)];
  if (row.kind === "cluster" || row.kind === "group") return row.items.map(rowStepId);
  if (row.kind === "activity" || row.kind === "turn_fold" || row.kind === "work_progress") {
    const ids: string[] = [];
    for (const child of row.rows) ids.push(...rowStepIds(child));
    return ids;
  }
  return [];
}

export function rowContainsStepId(row: Row, stepId: string): boolean {
  return rowStepIds(row).includes(stepId);
}

/* ============================================================
 * TimelineRow → Row[] (主入口 — 替代旧 buildTimelineRows(TimelineItem[]))
 *
 *   HistoryCellRow with cell.kind='user'/'assistant_text' → Row.message (合成 TimelineMessage)
 *   其它 RowStep → 走 cluster/group/single 分流 (原有逻辑)
 * ============================================================ */
function historyCellRowToMessage(r: HistoryCellRow): TimelineMessage | null {
  /* 同一个 cell 每帧造出的消息对象必须还是同一个 —— 见 activeTurnRows 的说明 */
  const cached = cachedHistoryMessage(r);
  if (cached) return cached;
  if (r.cell.kind === "user") {
    return cacheHistoryMessage(r, {
      kind: "message",
      id: r.id,
      role: "user",
      text: r.cell.text,
      timestamp: r.timestamp,
      timestampMs: r.startedAtMs,
      attachments: r.cell.attachments,
      injectionPending: r.cell.injectionPending,
    });
  }
  if (r.cell.kind === "assistant_text") {
    return cacheHistoryMessage(r, {
      kind: "message",
      id: r.id,
      role: "assistant",
      text: r.cell.text,
      timestamp: r.timestamp,
      timestampMs: r.startedAtMs,
      streaming: r.cell.streaming,
      turnTokens: r.cell.turnTokens,
      turnTps: r.cell.turnTps,
      turnUsage: r.cell.turnUsage,
      model: r.cell.model,
    });
  }
  return null;
}

function isTimelineMessage(value: unknown): value is TimelineMessage {
  return !!value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "message";
}

function isTimelineStepLike(value: unknown): value is TimelineStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<TimelineStep>;
  return typeof step.id === "string"
    && typeof step.title === "string"
    && typeof step.status === "string"
    && typeof step.iconKind === "string";
}

function inputToMessage(item: TimelineRow | TimelineItem): TimelineMessage | null {
  if (isTimelineMessage(item)) return item;
  if (isHistoryCellRow(item) && (item.cell.kind === "user" || item.cell.kind === "assistant_text")) {
    return historyCellRowToMessage(item);
  }
  return null;
}

function inputToRowStep(item: TimelineRow | TimelineItem): RowStep | null {
  if (isTimelineMessage(item)) return null;
  if (isHistoryCellRow(item) || isLegacyStepRow(item)) return item;
  if (isTimelineStepLike(item)) return item;
  return null;
}

/* 按 turn 切段的增量缓存 —— 与 mapTimelineToRows 同一机制, 见 segmentCache.ts。
 * 分组/聚类/activity 折叠都不跨 message 边界 (遇到 message 一律 flush), 所以按段算
 * 与整表算结果完全一致。 */
const _buildSegmentCache = createSegmentCache<TimelineRow | TimelineItem, Row>();

function isTurnBoundaryItem(item: TimelineRow | TimelineItem): boolean {
  const msg = inputToMessage(item);
  return !!msg && msg.role === "user";
}

/** 测试用 */
export function __resetBuildSegmentCacheForTests(): void {
  _buildSegmentCache.reset();
}

export function findLiveActivityIndex(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    /* 越过本轮边界 = 再往前都是历史轮次, 直接判定"本轮没有 activity" */
    if (r.kind === 'message' && r.message.role === 'user') return -1;
    if (r.kind === 'activity') return i;
  }
  return -1;
}

export function buildTimelineRows(
  items: Array<TimelineRow | TimelineItem>,
  minimal: boolean,
  pinnedSingleStepIds?: ReadonlySet<string>,
  foldRuns?: boolean,
  sessionStreaming?: boolean,
  sessionId?: string | null,
): Row[] {
  const ctxSig = `${sessionId ?? ''}|${minimal ? 1 : 0}|${foldRuns ? 1 : 0}`;
  return _buildSegmentCache.run(
    items,
    isTurnBoundaryItem,
    (segment, isLast, prevOutput) =>
      buildTimelineRowsImpl(segment, minimal, pinnedSingleStepIds, foldRuns, isLast, sessionStreaming, prevOutput),
    ctxSig,
  );
}

function buildTimelineRowsImpl(
  items: Array<TimelineRow | TimelineItem>,
  minimal: boolean,
  pinnedSingleStepIds: ReadonlySet<string> | undefined,
  foldRuns: boolean | undefined,
  /** 这一段是不是最后一段 (位置, 不是状态)。 */
  isLast: boolean,
  /** 会话此刻在不在跑 —— 与 isLast 一起才能判定"这一段是不是活跃 turn"。 */
  sessionStreaming?: boolean,
  prevOutput?: Row[] | null,
): Row[] {
  const out: Row[] = [];
  let curGroup: { id: string; label: string; items: RowStep[] } | null = null;
  let curCluster: { key: string; items: RowStep[] } | null = null;

  const flushGroup = () => {
    if (curGroup) {
      out.push(rowForGroup(curGroup.id, curGroup.label, curGroup.items));
      curGroup = null;
    }
  };
  const flushCluster = () => {
    if (!curCluster) return;
    if (curCluster.items.length >= CLUSTER_MIN) {
      const first = curCluster.items[0];
      out.push(rowForCluster(
        `cl-${rowStepId(first)}`, curCluster.key, rowStepIconKind(first),
        headOfTitle(rowStepTitle(first)), curCluster.items,
      ));
    } else {
      for (const step of curCluster.items) out.push(rowForSingle(step));
    }
    curCluster = null;
  };

  for (const item of items) {
    const msg = inputToMessage(item);
    if (msg) {
      flushCluster();
      flushGroup();
      out.push(rowForMessage(msg));
      continue;
    }

    const step = inputToRowStep(item);
    if (!step) continue;
    if (rowStepIsPlan(step)) continue;

    const gid = rowStepGroupId(step);
    if (gid) {
      flushCluster();
      if (curGroup && curGroup.id === gid) {
        curGroup.items.push(step);
      } else {
        flushGroup();
        curGroup = {
          id: gid,
          label: rowStepGroupLabel(step) ?? (_isZh() ? "并行 · 1 个工具" : "Parallel · 1 tools"),
          items: [step],
        };
      }
      continue;
    }

    flushGroup();
    if (!isClusterable(step, pinnedSingleStepIds)) {
      flushCluster();
      out.push(rowForSingle(step));
      continue;
    }

    const key = clusterKey(step);
    if (curCluster && curCluster.key === key) {
      curCluster.items.push(step);
    } else {
      flushCluster();
      curCluster = { key, items: [step] };
    }
  }

  flushCluster();
  flushGroup();

  const labeled = out.map((row) => {
    if (row.kind === "group" && row.items.length > 1) {
      const firstLabel = rowStepGroupLabel(row.items[0]);
      /* 数量修正要兼容双语 label ("Parallel · 3 tools" / "并行 · 3 个工具") */
      const label = firstLabel
        ? firstLabel.replace(/\d+(?=\s*(?:tools?|个工具))/, String(row.items.length))
        : (_isZh() ? `并行 · ${row.items.length} 个工具` : `Parallel · ${row.items.length} tools`);
      return rowWithGroupLabel(row, label);
    }
    return row;
  });
  const collapsed = minimal
    ? collapseActivityRuns(labeled)
    : (foldRuns ? collapseActivityRuns(labeled, { keepHighValue: true }) : labeled);
  /* 活跃 turn 绝不折 —— 折了就看不见 agent 在干什么。
   * "活跃" = 最后一段 且 (会话在跑 或 段里还有没落定的 step)。
   *
   * 后半个条件不是保险起见, 是必需的: streaming 在等审批 / ask_user 期间会翻 false,
   * 只看 streaming 的话, 待审改动那张卡会连同整轮一起被折进去 —— 用户正等着点"同意",
   * 而按钮被折没了。rowHasActive 覆盖 running / pending / 等待回答三种。 */
  const endsWithSettledAnswer = (() => {
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const r = collapsed[i]!;
      if (r.kind !== "message") continue;
      if (r.message.role !== "assistant") return false;
      return r.message.streaming !== true;
    }
    return false;
  })();
  const shouldNotFold = isLast && (sessionStreaming === true || collapsed.some(rowHasActive));
  const isActiveTurn = isLast
    && (collapsed.some(rowHasActive) || (sessionStreaming === true && !endsWithSettledAnswer));
  /* 把结论钉进 activity row —— 渲染层只读字段, 不做任何位置推断。 */
  const marked = markActiveTurnActivities(collapsed, isActiveTurn);
  const foldHadRun = !!prevOutput?.some((r) => r.kind === "turn_fold");
  if (shouldNotFold && !foldHadRun) return marked;
  const folded = foldClosedTurn(marked);

  return folded;
}


function markActiveTurnActivities(rows: Row[], isActiveTurn: boolean): Row[] {
  let lastActivityIdx = -1;
  if (isActiveTurn) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.kind === "activity") {
        lastActivityIdx = i;
        break;
      }
    }
  }
  if (lastActivityIdx >= 0 && rows.slice(lastActivityIdx + 1).some(rowHasActive)) {
    lastActivityIdx = -1;
  }
  let changed = false;
  const out = rows.map((r, i) => {
    if (r.kind !== "activity") return r;
    const shouldBeActive = isActiveTurn && i === lastActivityIdx;
    if (r.inActiveTurn === shouldBeActive) return r;
    changed = true;
    return rowWithActiveFlag(r, shouldBeActive);
  });
  return changed ? out : rows;
}

function turnFoldStats(rows: Row[]): {
  opCount: number; thinkCount: number; fileCount: number; addCount: number; delCount: number; hasFailure: boolean; hasInterrupted: boolean;
} {
  let opCount = 0, thinkCount = 0, addCount = 0, delCount = 0, hasFailure = false, hasInterrupted = false;
  const files = new Set<string>();
  const walkStep = (step: RowStep) => {
    if (thinkingTextOf(step)) thinkCount += 1;
    else opCount += 1;
    const c = rowStepLegacyStep(step).content as { type?: string; file?: string; addCount?: number; delCount?: number } | undefined;
    if (c?.type === "diff") {
      if (c.file) files.add(c.file);
      addCount += c.addCount ?? 0;
      delCount += c.delCount ?? 0;
    }
    const st = rowStepStatus(step);
    if (st === "failed") hasFailure = true;
    else if (st === "interrupted") hasInterrupted = true;
  };
  const walk = (list: Row[]) => {
    for (const r of list) {
      if (r.kind === "single") walkStep(r.step);
      else if (r.kind === "group" || r.kind === "cluster") r.items.forEach(walkStep);
      else if (r.kind === "activity" || r.kind === "turn_fold") walk(r.rows);
    }
  };
  walk(rows);
  return { opCount, thinkCount, fileCount: files.size, addCount, delCount, hasFailure, hasInterrupted };
}


/** step.duration 是给人看的串 ("1.2s" / "340ms" / "2 分 3 秒"), 解析回毫秒。解不出算 0。 */
function parseStepDurationMs(step: RowStep): number {
  const raw = rowStepDuration(step);
  if (!raw) return 0;
  const t = String(raw).trim();
  let total = 0;
  const min = /([\d.]+)\s*(?:分|m(?![s]))/.exec(t);
  if (min) total += parseFloat(min[1]) * 60_000;
  const sec = /([\d.]+)\s*(?:秒|s(?!\w))/.exec(t);
  if (sec) total += parseFloat(sec[1]) * 1000;
  const msm = /([\d.]+)\s*(?:毫秒|ms)/.exec(t);
  if (msm) total += parseFloat(msm[1]);
  if (total === 0) {
    const bare = /^([\d.]+)$/.exec(t);
    if (bare) total = parseFloat(bare[1]) * 1000;
  }
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** 中段所有 step 的时间跨度 [最早, 最晚]。取不到返回 undefined —— 宁可不显示时长, 也不编。
 *
 *  不能用 message.timestamp: 那是**显示串** (formatClock 出来的 "20:31"), Date.parse 解不出。
 *  真实时间只在 step.startedAtMs 上。用工作跨度也更贴合"已工作了多长时间"的语义 —— 用户
 *  想知道的是 agent 干了多久, 不是两条消息之间隔了多久 (中间可能夹着他去泡了杯咖啡)。 */
/* 两次尝试之间的"人在看错误卡"不是工作 —— 超过这个空档就断开, 分段各算各的。
 * 90s: 比任何单步工具/单次模型往返都长, 又远短于"看到红卡再决定点重试"的真实耗时。 */
const TURN_IDLE_GAP_MS = 90_000;

function stepWorkedMs(rows: Row[], extraPoints: number[] = []): number | undefined {
  const spans: Array<[number, number]> = [];
  for (const p of extraPoints) if (Number.isFinite(p) && p > 0) spans.push([p, p]);
  const visit = (step: RowStep) => {
    const ms = (step as { startedAtMs?: number }).startedAtMs;
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
      spans.push([ms, ms + parseStepDurationMs(step)]);
    }
  };
  const walk = (list: Row[]) => {
    for (const r of list) {
      if (r.kind === "single") visit(r.step);
      else if (r.kind === "group" || r.kind === "cluster") r.items.forEach(visit);
      else if (r.kind === "activity" || r.kind === "turn_fold") walk(r.rows);
    }
  };
  walk(rows);
  if (spans.length === 0) return undefined;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [segStart, segEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s - segEnd > TURN_IDLE_GAP_MS) {
      total += segEnd - segStart;
      segStart = s; segEnd = e;
    } else if (e > segEnd) {
      segEnd = e;
    }
  }
  total += segEnd - segStart;
  return total;
}

export function foldClosedTurn(rows: Row[]): Row[] {
  const first = rows.findIndex(
    r => r.kind === "message" && (r as Extract<Row, { kind: "message" }>).message.role === "user",
  );
  if (first < 0) return rows;
  const head = first + 1;

  const isAssistantMsg = (r: Row | undefined) =>
    !!r && r.kind === "message" && (r as Extract<Row, { kind: "message" }>).message.role === "assistant";

  let lastAssistant = -1;
  for (let i = rows.length - 1; i >= head; i--) {
    if (isAssistantMsg(rows[i])) { lastAssistant = i; break; }
  }
  let tail = rows.length;
  if (lastAssistant >= head) {
    tail = lastAssistant;
    while (tail > head && isAssistantMsg(rows[tail - 1])) tail--;
  }

  const middle = rows.slice(head, tail);
  if (middle.length === 0) return rows;

  const stats = turnFoldStats(middle);
  if (stats.opCount === 0) return rows;

  if (stats.hasFailure) return rows;

  const msgPoints = rows.slice(first).flatMap((r) => {
    if (r.kind !== "message") return [];
    /* timestamp 是显示串 (「20:10」), 原始毫秒在 timestampMs; 旧数据 / 单测里 timestamp 可能是 ISO 串 */
    const t = (r.message.timestampMs ?? r.message.timestamp) as unknown;
    const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? [ms] : [];
  });
  const worked = stepWorkedMs(middle, msgPoints);
  /* 0 毫秒 (步骤没带时长) 显示"已工作 0 秒"没有信息量, 干脆不显示 */
  const durationMs = worked && worked > 0 ? worked : undefined;

  const anchorId = (rows[first] as Extract<Row, { kind: "message" }>).message.id;
  const promoted: Row[] = [];
  const imageRows: Row[] = [];
  const folded: Row[] = [];
  const imagesAreMaterial = turnMakesFile([...middle, ...rows.slice(tail)], (s: any) => (isHistoryCellRow(s) ? { ...s.cell, type: s.cell.kind } : rowStepLegacyStep(s).content) as any); /* 做 PPT 时的背景图是素材, 一起折进去 */
  for (const r of middle) {
    if (r.kind === "single" && !imagesAreMaterial && rowStepIsGeneratedImage(rowStepContentTypeHint(r.step))) imageRows.push(r);
    else if (r.kind === "single" && rowStepIsRichCard(r.step)) promoted.push(r);
    else folded.push(r);
  }
  if (folded.length === 0) return rows;
  const body = folded.length === 1 && folded[0]!.kind === "activity"
    ? (folded[0] as Extract<Row, { kind: "activity" }>).rows
    : folded;
  return [
    ...rows.slice(0, head),
    { kind: "turn_fold", id: `turnfold-${anchorId}`, rows: body, durationMs, ...turnFoldStats(folded) },
    ...promoted,
    /* 生图产物排在回答正文**之后**: 先读到"画好了", 再看到图。 */
    ...spliceImagesAfterAnswer(rows.slice(tail) as Row[], imageRows),
  ];
}

export function estimateRowHeight(r: Row): number {
  if (r.kind === "message") {
    const len = r.message.text?.length ?? 0;
    return Math.max(TIMELINE_ROW_ESTIMATE_MESSAGE, Math.min(520, 112 + Math.ceil(len / 68) * 20));
  }
  /* 折叠行是固定单行摘要, 比 activity 更矮更稳 —— 估准了才不会在滚动时跳 */
  if (r.kind === "turn_fold") return TIMELINE_ROW_ESTIMATE_TURN_FOLD;
  /* 进度卡: 头 40 + 最多 6 行 × 26 + 底 */
  if (r.kind === "work_progress") return 220;
  if (r.kind === "activity") return TIMELINE_ROW_ESTIMATE_ACTIVITY;
  if (r.kind === "group") return TIMELINE_ROW_ESTIMATE_GROUP;
  if (r.kind === "single") {
    if (rowStepIsTurnSummary(r.step)) {
      const content = rowStepLegacyStep(r.step)?.content as { totalFiles?: number; changes?: unknown[] } | undefined;
      const fileCount = Number(content?.totalFiles ?? (Array.isArray(content?.changes) ? content.changes.length : 6)) || 6;
      return Math.min(620, 96 + fileCount * 44);
    }
    if (rowStepIsPlan(r.step)) return 300;
    const ct = rowStepContentTypeHint(r.step);
    if (ct === "diff" || ct === "code") return 320;
    if (ct === "terminal") return 220;
    if (ct === "image") return 240;
    return TIMELINE_ROW_ESTIMATE_SINGLE;
  }
  return TIMELINE_ROW_ESTIMATE_DEFAULT;
}

/**
 * 是否应对该行数启用虚拟窗口.
 * geometryReady 仍由调用方传入 (避免 timelineRows ↔ rowHeightGeometry 环依赖),
 * 但不再当开窗闸 —— 样本只能在窗口化之后学到, 用它门控等于永远学不到.
 * 会话内粘性由 useTimelineVirtualizer / TanStack Virtual 负责, 本函数只做瞬时判定.
 */
export function shouldWindowTimeline(
  rowCount: number,
  _geometryReady: boolean,
): boolean {
  if (rowCount > TIMELINE_FULL_RENDER_MAX) return true;
  /* 含 SOFT_MIN：中型会话也必须开窗, 否则切会话会全量挂工具卡. */
  if (rowCount < TIMELINE_WINDOW_SOFT_MIN) return false;
  return true;
}

export function lowerBoundIndex(prefix: number[], value: number): number {
  let lo = 0;
  let hi = Math.max(0, prefix.length - 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(prefix.length - 2, lo));
}

/** React 全局唯一 key, 对重复 base 加 occurrence 后缀. */
export function buildUniqueRowKeys(rows: Row[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r, index) => {
    const base = rowKeyOf(r, index);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  });
}

/* ============================================================
 * Row reference stabilizer
 *
 * mapTimelineEntriesToRows/buildTimelineRows are pure transforms, so every
 * stream event can rebuild equivalent row/step objects for old history. That
 * defeats React.memo on heavy cards (especially edit diff) and makes expanded
 * content replay opacity/layout work even though the visible data did not
 * change. Stabilization is intentionally strict: reuse only when a full UI
 * signature is identical.
 * ============================================================ */
const rowSignatureCache = new WeakMap<object, string>();
const stepSignatureCache = new WeakMap<object, string>();

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** 超过这个长度的字符串不再全文哈希, 改采样 —— 见 stringSignature 的说明。 */
const FULL_HASH_MAX_LEN = 4096;
/** 采样窗口: 首 / 中 / 尾 各取这么多字符。 */
const SAMPLE_WINDOW = 1024;
/** 超过这么多元素的数组改采样 —— codeLines 那种一行一个元素的数组是签名开销的大头。 */
const ARRAY_SAMPLE_MAX = 32;
/** 长数组首尾各取这么多个元素参与签名。 */
const ARRAY_SAMPLE_EDGE = 8;

/* 导出仅为可测 —— 采样 vs 全文哈希是可**确定性**观测的行为差异 (见
 * __tests__/timelineRowsStreamingCost.test.ts), 比计时基准可靠得多。 */
export function stringSignature(value: string): string {
  const len = value.length;
  if (len <= FULL_HASH_MAX_LEN) return `s:${len}:${hashString(value)}`;
  const mid = (len >> 1) - (SAMPLE_WINDOW >> 1);
  return `s:${len}:${hashString(value.slice(0, SAMPLE_WINDOW))}`
    + `:${hashString(value.slice(mid, mid + SAMPLE_WINDOW))}`
    + `:${hashString(value.slice(len - SAMPLE_WINDOW))}`;
}

function valueSignature(value: unknown, seen?: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "undefined") return "u";
  if (typeof value === "string") return stringSignature(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value}:${String(value)}`;
  }
  if (typeof value === "function" || typeof value === "symbol") return typeof value;
  if (!value || typeof value !== "object") return String(value);

  const localSeen = seen ?? new WeakSet<object>();
  if (localSeen.has(value)) return "[cycle]";
  localSeen.add(value);

  let sig: string;
  if (Array.isArray(value)) {
    if (value.length > ARRAY_SAMPLE_MAX) {
      const head = value.slice(0, ARRAY_SAMPLE_EDGE).map((item) => valueSignature(item, localSeen)).join(",");
      const tail = value.slice(-ARRAY_SAMPLE_EDGE).map((item) => valueSignature(item, localSeen)).join(",");
      sig = `a:${value.length}:[${head}|~|${tail}]`;
    } else {
      sig = `a:${value.length}:[${value.map((item) => valueSignature(item, localSeen)).join(",")}]`;
    }
  } else {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => typeof obj[key] !== "undefined" && typeof obj[key] !== "function")
      .sort();
    sig = `o:{${keys.map((key) => `${key}:${valueSignature(obj[key], localSeen)}`).join(",")}}`;
  }

  localSeen.delete(value);
  return sig;
}

function timelinePresentationSignature(step: RowStep): string {
  const presentation = isHistoryCellRow(step)
    ? step.presentation
    : rowStepLegacyStep(step).presentation;
  return valueSignature(presentation);
}

function timelineStepContentSignature(step: RowStep): string {
  if (isHistoryCellRow(step)) {
    return [
      "cell",
      valueSignature(step.cell),
      "legacy",
      valueSignature(step.legacyContent),
    ].join("|");
  }
  return valueSignature(rowStepLegacyStep(step).content);
}

function rowStepSignature(step: RowStep): string {
  if (step && typeof step === "object") {
    const cached = stepSignatureCache.get(step);
    if (cached) return cached;
  }
  const sig = [
    isHistoryCellRow(step) ? "history" : isLegacyStepRow(step) ? "legacy" : "step",
    rowStepId(step),
    rowStepStatus(step),
    rowStepIconKind(step),
    rowStepTitle(step),
    rowStepDesc(step) ?? "",
    rowStepDuration(step) ?? "",
    rowStepStartedAtMs(step) ?? "",
    isHistoryCellRow(step)
      ? step.timestamp ?? ""
      : rowStepLegacyStep(step).timestamp ?? "",
    isHistoryCellRow(step)
      ? step.defaultExpanded ? "1" : "0"
      : rowStepLegacyStep(step).defaultExpanded ? "1" : "0",
    valueSignature(rowStepMeta(step)),
    valueSignature(rowStepDiffStat(step)),
    rowStepGroupId(step) ?? "",
    rowStepGroupLabel(step) ?? "",
    timelinePresentationSignature(step),
    timelineStepContentSignature(step),
  ].join("\u001f");
  if (step && typeof step === "object") stepSignatureCache.set(step, sig);
  return sig;
}

function timelineMessageSignature(message: TimelineMessage): string {
  return [
    message.id,
    message.role,
    valueSignature(message.text),
    message.timestamp ?? "",
    message.streaming ? "1" : "0",
    message.source ?? "",
    message.injectionPending ? "1" : "0",
    valueSignature(message.attachments),
  ].join("\u001f");
}

function timelineRowSignature(row: Row): string {
  const cached = rowSignatureCache.get(row);
  if (cached) return cached;
  let sig: string;
  if (row.kind === "message") {
    sig = `message|${timelineMessageSignature(row.message)}`;
  } else if (row.kind === "single") {
    sig = `single|${rowStepSignature(row.step)}`;
  } else if (row.kind === "cluster") {
    sig = [
      "cluster",
      row.id,
      row.key,
      row.iconKind,
      row.head,
      row.items.map(rowStepSignature).join("\u001e"),
    ].join("\u001f");
  } else if (row.kind === "group") {
    sig = [
      "group",
      row.id,
      row.label,
      row.items.map(rowStepSignature).join("\u001e"),
    ].join("\u001f");
  } else if (row.kind === "turn_fold") {
    /* 已封口 turn 的折叠行: 统计量全进签名 —— 展开态是视图层的事, 不影响行身份 */
    sig = [
      "turn_fold",
      row.id,
      row.opCount,
      row.fileCount,
      row.addCount,
      row.delCount,
      row.durationMs ?? "",
      row.hasFailure ? "1" : "0",
      row.hasInterrupted ? "1" : "0",
      row.rows.map(timelineRowSignature).join("\u001e"),
    ].join("\u001f");
  } else if (row.kind === "work_progress") {
    sig = ["work_progress", row.id, row.ask, row.rows.map(timelineRowSignature).join("\u001e")].join("\u001f");
  } else {
    sig = [
      "activity",
      row.id,
      row.opCount,
      row.hasActive ? "1" : "0",
      row.inActiveTurn ? "1" : "0",
      row.summary ?? "",
      row.rows.map(timelineRowSignature).join("\u001e"),
    ].join("\u001f");
  }
  rowSignatureCache.set(row, sig);
  return sig;
}

function stabilizeRowStep(prev: RowStep | undefined, next: RowStep): RowStep {
  return prev && rowStepSignature(prev) === rowStepSignature(next) ? prev : next;
}

function stabilizeRowStepList(prev: RowStep[] | undefined, next: RowStep[]): RowStep[] {
  if (!prev || prev.length === 0 || next.length === 0) return next;
  const prevById = new Map<string, RowStep>();
  for (const step of prev) prevById.set(rowStepId(step), step);
  let changed = false;
  const stabilized = next.map((step) => {
    const stable = stabilizeRowStep(prevById.get(rowStepId(step)), step);
    if (stable !== step) changed = true;
    return stable;
  });
  return changed ? stabilized : next;
}

function stabilizeRowList(prevRows: Row[] | undefined, nextRows: Row[]): Row[] {
  if (!prevRows || prevRows.length === 0 || nextRows.length === 0) return nextRows;

  const minLen = Math.min(prevRows.length, nextRows.length);
  let head = 0;
  while (head < minLen && prevRows[head] === nextRows[head]) head++;
  /* 整条一模一样 —— 连尾部都没动, 直接把上一帧原样交回去 (引用相等, 下游 React 零工作) */
  if (head === nextRows.length && head === prevRows.length) return prevRows;

  const prevTail = head > 0 ? prevRows.slice(head) : prevRows;
  const nextTail = head > 0 ? nextRows.slice(head) : nextRows;

  const prevKeys = buildUniqueRowKeys(prevTail);
  const prevByKey = new Map<string, Row>();
  prevTail.forEach((row, index) => prevByKey.set(prevKeys[index] ?? rowKeyOf(row, index), row));

  const nextKeys = buildUniqueRowKeys(nextTail);
  let changed = false;
  const stabilizedTail = nextTail.map((row, index) => {
    const key = nextKeys[index] ?? rowKeyOf(row, index);
    const prev = prevByKey.get(key);
    const stable = stabilizeTimelineRow(prev, row);
    if (stable !== row) changed = true;
    return stable;
  });
  if (!changed) return nextRows;
  if (head === 0) return stabilizedTail;
  /* 前缀那段用 nextRows 自己的元素 (与 prevRows 逐个相同, 取哪边都一样) */
  const out = nextRows.slice(0, head);
  for (const r of stabilizedTail) out.push(r);
  return out;
}

/** 这一行是不是正在流式生长 —— 生长中的行按定义每帧都不同, 稳定引用无从谈起。 */
function isStreamingRow(row: Row): boolean {
  if (row.kind === "message") return row.message.streaming === true;
  if (row.kind === "single") return rowStepStatus(row.step) === "running";
  if (row.kind === "cluster" || row.kind === "group")
    return row.items.some((s) => rowStepStatus(s) === "running");
  if (row.kind === "activity") return row.hasActive === true;
  /* 折叠行只在**已封口**的 turn 上出现, 定义上不可能有活跃项 */
  if (row.kind === "turn_fold") return false;
  return false;
}

function stabilizeTimelineRow(prev: Row | undefined, next: Row): Row {
  if (!prev || prev.kind !== next.kind) return next;
  /* 同一个对象直接返回 —— 增量映射命中时(mapTimeline 的 WeakMap)这是常态,
   * 不必再算一遍签名。 */
  if (prev === next) return prev;

  if (isStreamingRow(next)) return next;

  let candidate = next;
  if (next.kind === "single" && prev.kind === "single") {
    const step = stabilizeRowStep(prev.step, next.step);
    if (step !== next.step) candidate = { ...next, step };
  } else if (next.kind === "cluster" && prev.kind === "cluster") {
    const items = stabilizeRowStepList(prev.items, next.items);
    if (items !== next.items) candidate = { ...next, items };
  } else if (next.kind === "group" && prev.kind === "group") {
    const items = stabilizeRowStepList(prev.items, next.items);
    if (items !== next.items) candidate = { ...next, items };
  } else if (next.kind === "activity" && prev.kind === "activity") {
    const rows = stabilizeRowList(prev.rows, next.rows);
    if (rows !== next.rows) candidate = { ...next, rows };
  } else if (next.kind === "turn_fold" && prev.kind === "turn_fold") {
    const rows = stabilizeRowList(prev.rows, next.rows);
    if (rows !== next.rows) candidate = { ...next, rows };
  }

  return timelineRowSignature(prev) === timelineRowSignature(candidate) ? prev : candidate;
}

export function stabilizeTimelineRows(prevRows: Row[] | undefined | null, nextRows: Row[]): Row[] {
  return stabilizeRowList(prevRows ?? undefined, nextRows);
}

/** 内容身份 — 用 step/message 的稳定 id 判断"是否真正新增". */
export function contentIdsOf(r: Row): string[] {
  if (r.kind === "message") return [`m:${r.message.id}`];
  if (r.kind === "single") return [`s:${rowStepId(r.step)}`];
  if (r.kind === "cluster" || r.kind === "group")
    return r.items.map((s) => `s:${rowStepId(s)}`);
  if (r.kind === "activity") return r.rows.flatMap(contentIdsOf);
  return [];
}

export function stepCountOf(r: Row): number {
  if (r.kind === "single") return 1;
  if (r.kind === "cluster" || r.kind === "group") return r.items.length;
  return 0;
}
export function rowHasActive(r: Row): boolean {
  if (r.kind === "single") {
    const st = rowStepStatus(r.step);
    return st === "running" || st === "pending" || isWaitingAskStep(r.step);
  }
  if (r.kind === "cluster" || r.kind === "group") {
    return r.items.some((s) => {
      const st = rowStepStatus(s);
      return st === "running" || st === "pending" || isWaitingAskStep(s);
    });
  }
  if (r.kind === "activity" || r.kind === "work_progress") return r.rows.some(rowHasActive);
  return false;
}

export function rowHasWaitingAsk(row: Row): boolean {
  if (row.kind === "single") return isWaitingAskStep(row.step);
  if (row.kind === "cluster" || row.kind === "group")
    return row.items.some(isWaitingAskStep);
  if (row.kind === "activity" || row.kind === "work_progress") return row.rows.some(rowHasWaitingAsk);
  return false;
}
/** activity 耗时: 从最早 step 开始到最晚 step 结束的总时间 */
export function activityDuration(
  activity: Extract<Row, { kind: "activity" }>
): string | undefined {
  let minStart = Infinity;
  let maxEnd = 0;
  const visit = (step: RowStep) => {
    const started = rowStepStartedAtMs(step);
    if (started) {
      if (started < minStart) minStart = started;
      const durStr = rowStepDuration(step);
      const dur = durStr ? parseDurationMs(durStr) : 0;
      const end = started + dur;
      if (end > maxEnd) maxEnd = end;
    }
  };
  for (const r of activity.rows) {
    if (r.kind === "single") visit(r.step);
    else if (r.kind === "cluster" || r.kind === "group") r.items.forEach(visit);
  }
  if (minStart === Infinity || maxEnd === 0) return undefined;
  const totalMs = maxEnd - minStart;
  if (totalMs < 1000) return undefined;
  if (totalMs < 60000) return `${(totalMs / 1000).toFixed(1)}s`;
  if (totalMs < 3600000) return `${(totalMs / 60000).toFixed(1)}min`;
  return `${(totalMs / 3600000).toFixed(1)}h`;
}
export function parseDurationMs(d: string): number {
  const m = d.match(/([\d.]+)\s*(ms|s|min|h)/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (m[2] === "ms") return v;
  if (m[2] === "s") return v * 1000;
  if (m[2] === "min") return v * 60000;
  return v * 3600000;
}

export function activitySummary(activity: Extract<Row, { kind: "activity" }>): string {
  const counts = new Map<string, number>();
  const firstTitle = new Map<string, string>(); /* head → 第一条完整 title (含 arg) */
  const collect = (step: RowStep) => {
    const fullTitle = rowStepTitle(step);
    let head = fullTitle.split(/\s*·\s*/)[0].trim();
    /* 还在流式生成的那条标题缺个结尾 (「做一页幻灯片「豆角咖啡」 vs 「做一页幻灯片「豆角咖啡」」), 别当成两件事并排
     * (10-15 QA: Work 折叠头「做一页幻灯片「豆角咖啡」 · 做一页幻灯片「豆角咖啡」) */
    const bare = head.replace(/[」"”'）)\s]+$/, '');
    for (const k of counts.keys()) {
      const kb = k.replace(/[」"”'）)\s]+$/, '');
      if (bare && kb && (kb.startsWith(bare) || bare.startsWith(kb))) { head = k; break; }
    }
    counts.set(head, (counts.get(head) || 0) + 1);
    if (!firstTitle.has(head)) firstTitle.set(head, fullTitle);
  };
  for (const r of activity.rows) {
    if (r.kind === "single") collect(r.step);
    else if (r.kind === "cluster" || r.kind === "group")
      r.items.forEach(collect);
  }
  const parts: string[] = [];
  for (const [name, n] of counts) {
    if (n > 1) parts.push(`${name} ×${n}`);
    else parts.push(firstTitle.get(name) || name); /* N===1 保留 arg */
  }
  return parts.join(" · ");
}

export interface ActivityDigestLine {
  key: string;
  head: string;
  iconKind: StepIconKind;
  count: number;
  /** 对象列表 (文件名/命令/搜索词), 已去重截断 */
  detail: string;
  failed: boolean;
  running: boolean;
  /** 该类动作累计耗时 ms (可解析 duration 求和; 0 = 无数据) */
  durationMs: number;
  /** 思考类累计字数 — duration 缺失时的兜底统计 */
  thinkingChars: number;
}

/** 摘要统计用的紧凑时长: 1.2s / 12s / 1.5min */
function formatDigestDuration(ms: number): string {
  if (ms < 1000) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/**
 * 这一行是不是「思考」——用于判断能不能把子行的头省掉。
 *
 * 思考行有个别的行没有的性质: `activityChildTitle` 会把**整段思考文本**接在标题后面
 * (见那里的兜底链), 而展开后的 `__details` 又把同一段文本原样再渲染一遍。于是同一段字
 * 在屏幕上出现两次, 外层活动头再算一次就是三次。
 */
export function isThinkingRow(row: Row): boolean {
  return row.kind === "single" && thinkingTextOf(row.step).trim().length > 0;
}

/** Work 模式展开步骤列表时不列的行: 思考, 以及跑命令 / 临时脚本 / 翻文件夹这类内部步骤。 */
export function isPlainHiddenRow(row: Row): boolean {
  return isThinkingRow(row) || isPlainInternalTitle(activityChildTitle(row));
}

export function plainHiddenTally(rows: Row[]): { think: number; process: number; browse: number } {
  const out = { think: 0, process: 0, browse: 0 };
  for (const row of rows) {
    if (row.kind !== "activity") continue;
    for (const child of row.rows) {
      if (isThinkingRow(child)) { out.think += 1; continue; }
      const kind = plainInternalKind(activityChildTitle(child));
      if (kind) out[kind] += 1;
    }
  }
  return out;
}

export function thinkingTextOf(s: RowStep): string {
  if (isHistoryCellRow(s)) {
    const cellText = (s.cell as { text?: unknown }).text;
    const cellKind = s.cell.kind as string;
    if ((cellKind === "thinking" || cellKind === "reasoning") && typeof cellText === "string" && cellText) {
      return cellText;
    }
    const legacy = s.legacyContent as { type?: string; text?: unknown } | undefined;
    return legacy?.type === "thinking" ? String(legacy.text ?? "") : "";
  }
  const content = rowStepLegacyStep(s).content;
  return content?.type === "thinking" ? String((content as { text?: unknown }).text ?? "") : "";
}

function isTrivialDigestArg(arg: string): boolean {
  return /^[.\\/·…]{1,2}$/.test(arg);
}

/** title 的 arg 段 → 显示对象: 纯路径取 basename, 命令/搜索词原样 (CSS 截断); 无信息量的丢弃 */
function digestArgOf(title: string): string {
  const sep = title.indexOf(" · ");
  if (sep < 0) return "";
  const arg = title.slice(sep + 3).trim();
  if (!arg || isTrivialDigestArg(arg)) return "";
  if (!/\s/.test(arg) && /[\\/]/.test(arg)) {
    const base = arg.split(/[\\/]/).pop() || arg;
    return isTrivialDigestArg(base) ? "" : base;
  }
  return arg;
}

export function activityDigest(
  activity: Extract<Row, { kind: "activity" }>,
  maxLines = 6,
): { lines: ActivityDigestLine[]; moreCount: number } {
  const order: string[] = [];
  const byHead = new Map<string, {
    icon: StepIconKind; count: number; args: string[]; failed: boolean; running: boolean;
    durationMs: number; thinkingChars: number;
  }>();
  const collect = (s: RowStep) => {
    const title = rowStepTitle(s);
    const head = headOfTitle(title);
    let g = byHead.get(head);
    if (!g) {
      g = { icon: rowStepIconKind(s), count: 0, args: [], failed: false, running: false, durationMs: 0, thinkingChars: 0 };
      byHead.set(head, g);
      order.push(head);
    }
    g.count++;
    const arg = digestArgOf(title);
    if (arg && !g.args.includes(arg) && g.args.length < 3) g.args.push(arg);
    const st = rowStepStatus(s);
    if (st === "failed") g.failed = true;
    if (st === "running" || st === "pending" || st === "awaiting") g.running = true;
    const durStr = rowStepDuration(s);
    if (durStr) g.durationMs += parseDurationMs(durStr);
    g.thinkingChars += thinkingTextOf(s).length;
  };
  for (const r of activity.rows) {
    if (r.kind === "single") collect(r.step);
    else if (r.kind === "cluster" || r.kind === "group") r.items.forEach(collect);
  }
  const all = order.map((head) => {
    const g = byHead.get(head)!;
    return {
      key: head,
      head,
      iconKind: g.icon,
      count: g.count,
      detail: g.args.join("、"),
      failed: g.failed,
      running: g.running,
      durationMs: g.durationMs,
      thinkingChars: g.thinkingChars,
    };
  });
  return { lines: all.slice(0, maxLines), moreCount: Math.max(0, all.length - maxLines) };
}

type DigestCategory = "think" | "shell" | "read" | "edit" | "search" | "mcp" | "agent" | "other";

/* MCP 折叠头解析 —— displayToolName 已经把 `mcp__` 前缀剥掉, 剩下 `<服务器>__<工具>`;
 * 少数路径可能还带着原始前缀, 两种都认。 */
function isAgentDigestHead(head: string): boolean {
  return /^(explore|explore_status|sub-?agent|agent|delegation|探索|深入研究|子代理|任务派发)$/i.test(head.trim());
}

function isMcpDigestHead(head: string): boolean {
  return /^mcp__/i.test(head) || /^[a-z0-9][\w.-]*__[\w.-]+$/i.test(head);
}

function splitMcpHead(head: string): { server: string; tool: string } {
  const raw = head.replace(/^mcp__/i, "");
  const i = raw.indexOf("__");
  if (i < 0) return { server: "", tool: raw };
  return { server: raw.slice(0, i), tool: raw.slice(i + 2) };
}

function classifyDigestLine(l: ActivityDigestLine): DigestCategory {
  const h = l.head.toLowerCase();
  if (isMcpDigestHead(l.head)) return "mcp";
  if (l.iconKind === "plugin") return "other";
  if (isAgentDigestHead(l.head)) return "agent";
  if (
    l.iconKind === "thinking"
    || /思考/.test(l.head)
    || /^(thought|thinking)$/i.test(l.head)
    || /\bthought\b|\bthinking\b/.test(h)
  ) return "think";
  if (
    l.iconKind === "terminal"
    || /shell|command|bash|exec|终端|执行命令/.test(h)
  ) return "shell";
  if (
    l.iconKind === "search"
    || /search|grep|glob|搜索|检索/.test(h)
  ) return "search";
  if (
    l.iconKind === "edit"
    || /^(edit|write|写入|编辑)/i.test(l.head)
    || /\bedit\b|\bwrite\b|写入|编辑/.test(h)
  ) return "edit";
  if (/^列目录|^查看目录|^list[_ ]?directory|^list[_ ]?dir|^listdir|^ls$/.test(h)) return "other";
  if (
    l.iconKind === "file"
    || /read|读取|readfile/.test(h)
  ) return "read";
  return "other";
}

/** 折叠头可展示的短文件名 — 拒命令串 / 过长路径 */
function shortDigestFile(detail: string): string {
  if (!detail) return "";
  const first = detail.split("、")[0]?.trim() ?? "";
  if (!first || isTrivialDigestArg(first)) return "";
  /* 带空白的多半是命令或搜索词, 折叠头不展示 */
  if (/\s/.test(first)) return "";
  if (first.length > 40) return `${first.slice(0, 39)}…`;
  return first;
}


/* export 只为让 __tests__/toolTitleTarget.test.ts 直接断言余量口径, 不改运行时行为
 * (同 pickStatus 的做法)。 */
export function digestFileList(detail: string, total: number, zh: boolean): string {
  const names = detail
    .split("、")
    .map((x) => x.trim())
    .filter((x) => x && !isTrivialDigestArg(x) && !/\s/.test(x))
    .map((x) => (x.length > 28 ? `${x.slice(0, 27)}…` : x));
  if (!names.length) return "";
  const shown = names.slice(0, 2);
  const realTotal = Math.max(total, names.length);
  const rest = realTotal - shown.length;
  const joined = shown.join(zh ? "、" : ", ");
  if (rest <= 0) return joined;
  return zh ? `${joined} 等 ${realTotal} 个` : `${joined} and ${rest} more`;
}

/** 搜索词值得露出来 (搜什么直接说明意图), 但命令原文不行 — 会把长命令糊满一行。 */
const DIGEST_QUERY_CLIP = 120;

function shortDigestQuery(detail: string): string {
  const first = detail.split("、")[0]?.trim() ?? "";
  if (!first || isTrivialDigestArg(first)) return "";
  return first.length > DIGEST_QUERY_CLIP ? `${first.slice(0, DIGEST_QUERY_CLIP - 1)}…` : first;
}

function formatDigestChars(n: number, zh: boolean): string {
  const unit = zh ? "字" : "chars";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k ${unit}` : `${n} ${unit}`;
}

export interface DigestPhrase {
  /** 动词, 提亮提重 */
  head: string;
  /** 其余明细, 维持灰度 */
  rest: string;
}

function phrase(head: string, rest: string): DigestPhrase {
  if (rest && !/^[\s·×+(【“"]/.test(rest)) return { head: `${head}${rest}`, rest: "" };
  return { head, rest };
}

function formatDigestPhrase(l: ActivityDigestLine, zh: boolean): DigestPhrase {
  const kind = classifyDigestLine(l);
  const n = l.count;
  const dur = formatDigestDuration(l.durationMs);
  const chars = l.thinkingChars > 0 ? formatDigestChars(l.thinkingChars, zh) : "";

  switch (kind) {
    case "think": {
      const head = zh ? "思考" : "Thought";
      const count = n > 1 ? ` ×${n}` : "";
      const worthChars = l.thinkingChars >= 40 ? chars : "";
      const stat = [dur, worthChars].filter(Boolean).join(" · ");
      return phrase(head, `${count}${stat ? ` · ${stat}` : ""}`);
    }
    case "shell": {
      const head = zh ? "执行" : "Ran";
      if (zh) return phrase(head, n === 1 ? " 1 条命令" : ` ${n} 条命令`);
      return phrase(head, n === 1 ? " 1 command" : ` ${n} commands`);
    }
    case "search": {
      const head = zh ? "搜索" : "Searched";
      const q = shortDigestQuery(l.detail);
      const suffix = n > 1 ? ` ×${n}` : "";
      if (q) return phrase(head, ` “${q}”${suffix}`);
      return phrase(head, n === 1 ? "" : ` ×${n}`);
    }
    case "read": {
      const head = zh ? "读取" : "Read";
      const files = digestFileList(l.detail, n, zh);
      if (files) return phrase(head, ` ${files}`);
      if (zh) return phrase(head, n === 1 ? "文件" : ` ${n} 个文件`);
      return phrase(head, n === 1 ? " file" : ` ${n} files`);
    }
    case "agent": {
      /* 「子 Agent · <类型>」+ 它接到的任务 —— 跟 MCP 那条同一个思路: 折叠头要说出**是谁在干活** */
      const kind = l.head.trim();
      const label = zh ? `子 Agent · ${kind}` : `Sub-agent · ${kind}`;
      const q = shortDigestQuery(l.detail);
      const suffix = n > 1 ? ` ×${n}` : "";
      return q ? phrase(label, ` “${q}”${suffix}`) : phrase(label, suffix);
    }
    case "mcp": {
      /* 「MCP · <服务器>」+ 工具名 —— 跟主流一致: 让人一眼看出是外部服务器提供的能力 */
      const { server, tool } = splitMcpHead(l.head);
      const head = server ? mcpServerLabel(server, zh) : "MCP";
      const suffix = n > 1 ? ` ×${n}` : "";
      return phrase(head, tool ? ` ${mcpToolLabel(tool, zh)}${suffix}` : suffix);
    }
    case "edit": {
      const head = zh ? "编辑" : "Edited";
      const files = digestFileList(l.detail, n, zh);
      if (files) return phrase(head, ` ${files}`);
      if (zh) return phrase(head, n === 1 ? "文件" : ` ${n} 个文件`);
      return phrase(head, n === 1 ? " 1 file" : ` ${n} files`);
    }
    default: {
      const count = n > 1 ? ` ×${n}` : "";
      return phrase(l.head, count);
    }
  }
}

/** step 的语气覆盖 (busy / benign) —— 两种 RowStep 形状都要取到, 漏一种等于没有. */
export function rowStepTone(s: RowStep): 'busy' | 'benign' | undefined {
  return isHistoryCellRow(s) ? s.tone : rowStepLegacyStep(s).tone;
}

export function activityFailureCount(activity: Extract<Row, { kind: "activity" }>): number {
  let n = 0;
  const walk = (s: RowStep) => {
    if (rowStepStatus(s) !== "failed") return;
    const tone = rowStepTone(s);
    if (tone === "benign" || tone === "busy") return;
    n++;
  };
  for (const r of activity.rows) {
    if (r.kind === "single") walk(r.step);
    else if (r.kind === "cluster" || r.kind === "group") r.items.forEach(walk);
  }
  return n;
}

export function activityDigestDiffTotal(
  activity: Extract<Row, { kind: "activity" }>,
): { add: number; del: number } | undefined {
  let add = 0;
  let del = 0;
  const visit = (s: RowStep) => {
    if (rowStepStatus(s) === "failed") return;
    const ds = rowStepDiffStat(s);
    if (ds) {
      add += ds.add;
      del += ds.del;
    }
  };
  for (const r of activity.rows) {
    if (r.kind === "single") visit(r.step);
    else if (r.kind === "cluster" || r.kind === "group") r.items.forEach(visit);
  }
  if (add === 0 && del === 0) return undefined;
  return { add, del };
}

export function activityDigestSegments(
  activity: Extract<Row, { kind: "activity" }>,
  options?: { withDiff?: boolean; plain?: boolean },
): DigestPhrase[] {
  const zh = _isZh();
  const { lines, moreCount } = activityDigest(activity, 8);

  if (options?.plain) {
    /* 内部步骤 (「处理中的一步」×10) 也不进摘要 —— 跟展开列表同一口径, 见 isPlainHiddenRow */
    const acts = lines.filter((l) => classifyDigestLine(l) !== "think" && !isPlainInternalTitle(l.head));
    if (acts.length === 0) {
      /* 这一段全是思考 / 内部步骤: 只想了一下就说「想了想」, 否则报个数, 不把「处理中的一步 ×3」摆出来 */
      const onlyThink = lines.every((l) => classifyDigestLine(l) === "think");
      if (onlyThink) return lines.map((l) => formatDigestPhrase(l, zh));
      const n = lines.reduce((s, l) => s + (classifyDigestLine(l) === "think" ? 0 : l.count), 0);
      return [{ head: zh ? "做了一些准备" : "Did some prep", rest: n > 1 ? (zh ? ` (${n} 步)` : ` (${n} steps)`) : "" }];
    }
    const parts: DigestPhrase[] = acts.map((l) => ({ head: l.head, rest: l.count > 1 ? ` ×${l.count}` : "" }));
    if (moreCount > 0) parts.push({ head: "", rest: `+${moreCount}` });
    return parts;
  }

  /* 按展示类别合并 — 保留首次出现顺序 */
  const order: DigestCategory[] = [];
  const merged = new Map<DigestCategory, ActivityDigestLine>();
  const others: ActivityDigestLine[] = [];
  for (const l of lines) {
    const kind = classifyDigestLine(l);
    if (kind === "other") {
      others.push(l);
      continue;
    }
    const prev = merged.get(kind);
    if (!prev) {
      merged.set(kind, { ...l, key: kind });
      order.push(kind);
      continue;
    }
    prev.count += l.count;
    prev.durationMs += l.durationMs;
    prev.thinkingChars += l.thinkingChars;
    prev.failed = prev.failed || l.failed;
    prev.running = prev.running || l.running;
    if (l.detail) {
      const merged = [...prev.detail.split("、"), ...l.detail.split("、")]
        .map((x) => x.trim())
        .filter(Boolean);
      prev.detail = [...new Set(merged)].join("、");
    }
  }

  const actionable = order.filter((k) => k !== "think");
  const shown = actionable.length > 0 || others.length > 0 ? actionable : order;
  const parts: DigestPhrase[] = [
    ...shown.map((k) => formatDigestPhrase(merged.get(k)!, zh)),
    ...others.map((l) => formatDigestPhrase(l, zh)),
  ];
  /* 这两条不是动作短语, 没有动词可提 —— head 留空, 渲染层就当普通灰字排 */
  if (moreCount > 0) parts.push({ head: "", rest: `+${moreCount}` });
  if (options?.withDiff !== false) {
    const diff = activityDigestDiffTotal(activity);
    if (diff) parts.push({ head: "", rest: `+${diff.add} -${diff.del}` });
  }
  return parts;
}

/** 分隔符只定义一次 —— 结构版和字符串版必须排出同一个样子 */
export function digestSeparator(zh: boolean): string {
  return zh ? " · " : ", ";
}

/** 纯文本版: tooltip / 无障碍标签 / 任何不做富文本的消费方走这条。
 * **由 segments 派生**, 不另写一遍拼接逻辑 —— 否则两处会慢慢长歪。 */
export function activityDigestSummary(
  activity: Extract<Row, { kind: "activity" }>,
  options?: { withDiff?: boolean },
): string {
  return activityDigestSegments(activity, options)
    .map((p) => `${p.head}${p.rest}`)
    .join(digestSeparator(_isZh()));
}

export function lastSettledTitle(activity: Extract<Row, { kind: "activity" }>): string | undefined {
  for (let i = activity.rows.length - 1; i >= 0; i--) {
    const r = activity.rows[i];
    const steps = r.kind === "single" ? [r.step]
      : r.kind === "cluster" || r.kind === "group" ? r.items : [];
    for (let j = steps.length - 1; j >= 0; j--) {
      const st = rowStepStatus(steps[j]!);
      if (st === "running" || st === "pending" || st === "awaiting") continue;
      const t = rowStepTitle(steps[j]!).trim();
      if (!t) continue;
      if (/^(思考|Thought|Thinking)/.test(t)) continue;
      return t;
    }
  }
  return undefined;
}

/** activity 折叠态的实时简报: 倒序找最后一个运行中/排队的 step, 返回 title + diff stats. */
export function currentRunningStartedAtMs(
  activity: Extract<Row, { kind: "activity" }>
): number | undefined {
  let fallbackMin: number | undefined;
  const visit = (s: RowStep): number | undefined => {
    const started = rowStepStartedAtMs(s);
    if (started && (fallbackMin === undefined || started < fallbackMin)) fallbackMin = started;
    const st = rowStepStatus(s);
    if ((st === "running" || st === "pending" || st === "awaiting") && started) return started;
    return undefined;
  };
  for (let i = activity.rows.length - 1; i >= 0; i--) {
    const r = activity.rows[i];
    if (r.kind === "single") {
      const hit = visit(r.step);
      if (hit) return hit;
    } else if (r.kind === "cluster" || r.kind === "group") {
      for (let j = r.items.length - 1; j >= 0; j--) {
        const hit = visit(r.items[j]);
        if (hit) return hit;
      }
    }
  }
  return fallbackMin;
}

/** 思考文本的**最后一句** (流式时就是正在写的那句)。空白折叠, 太短就往前多带一句,
 *  上限 160 字 —— 显示截断交给 CSS ellipsis, 这里只防爆。 */
export function thinkingTail(text: string, max = 160): string {
  const { tail } = thinkingTailParts(text);
  return tail.length > max ? `…${tail.slice(-(max - 1))}` : tail;
}

/** start = thinkingTail 从第几句开始拼 (折叠头换句判据, 见 runningKey.ts) */
export function thinkingTailParts(text: string): { tail: string; start: number } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return { tail: "", start: 0 };
  const parts = flat.split(/(?<=[。！？!?；;]|\.\s)/).map((p) => p.trim()).filter(Boolean);
  let start = parts.length - 1;
  let tail = parts[start] ?? "";
  while (start > 0 && tail.length < 24) tail = `${parts[--start]} ${tail}`;
  return { tail, start };
}

export function currentRunningTitle(
  activity: Extract<Row, { kind: "activity" }>,
  options?: { plain?: boolean },
): string | undefined {
  const isActive = (s: RowStep) => {
    const st = rowStepStatus(s);
    /* awaiting 也算当前动作 — 审批中的 shell 否则摘要头空白只剩计时 */
    return st === "running" || st === "pending" || st === "awaiting" || isWaitingAskStep(s);
  };
  const formatStep = (s: RowStep): string => {
    let t = rowStepTitle(s);
    const ds = rowStepDiffStat(s);
    if (ds && (ds.add || ds.del)) {
      void ds;
    }
    if (!options?.plain && !t.includes(" · ")) {
      const tail = thinkingTail(thinkingTextOf(s));
      if (tail && (!_isZh() || /[一-鿿]/.test(tail))) t = t ? `${t} · ${tail}` : tail;
    }
    if (rowStepStatus(s) === "awaiting") {
      const prefix = _isZh() ? "等待确认" : "Awaiting approval";
      if (!t) return prefix;
      if (t.startsWith(prefix)) return t;
      return `${prefix} · ${t}`;
    }
    return t;
  };
  /* 优先 awaiting (审批挡住整轮), 再倒序找 running */
  let runningHit: string | undefined;
  for (let i = activity.rows.length - 1; i >= 0; i--) {
    const r = activity.rows[i];
    const steps =
      r.kind === "single" ? [r.step]
        : r.kind === "cluster" || r.kind === "group" ? r.items
          : [];
    for (let j = steps.length - 1; j >= 0; j--) {
      const s = steps[j]!;
      if (!isActive(s)) continue;
      const formatted = formatStep(s);
      if (rowStepStatus(s) === "awaiting") return formatted;
      if (!runningHit) runningHit = formatted;
    }
  }
  return runningHit;
}

export function isHighValueStep(s: RowStep): boolean {
  if (rowStepIsAskWaiting(s)) return true;
  if (rowStepStatus(s) === "failed" && rowStepTone(s) !== "benign") return true;
  const agentHint = rowStepContentTypeHint(s);
  if (agentHint === "delegation" || agentHint === "worker" || agentHint === "explore-group") return true;
  if (rowStepDiffStat(s)) return true;
  const hint = rowStepContentTypeHint(s);
  /* compaction 单独判 —— cells 路径下 hint 是 'system_notice', 靠 hint 认不出来 */
  if (rowStepIsCompaction(s)) return true;
  if (rowStepIsTargetContinue(s)) return true;
  if (rowStepIsRichCard(s)) return true;
  if (rowStepIsBlocked(s)) return true;
  if (hint === "diff" || hint === "askUser" || hint === "ask_user"
    || hint === "error" || hint === "compaction"
    /* 调研结论是一轮的答案, 不许被折进 Actions 聚合组 */
    || hint === "deep_research") return true;
  return false;
}

function rowIsHighValue(r: Row): boolean {
  if (r.kind === "single") return isHighValueStep(r.step);
  /* 并行组里混着写改/失败 → 整组保持可见; cluster 只收同类读操作, 恒可折 */
  if (r.kind === "group") return r.items.some(isHighValueStep);
  return false;
}

export interface CollapseActivityOptions {
  /** 高价值 step 不折进 activity (标准模式); 缺省 false = 原极简行为全折 */
  keepHighValue?: boolean;
}

/** 把两条 message 之间的连续工具 row 折叠成一个 activity row.
 *  极简模式全折; 标准模式 (keepHighValue) 高价值 step 豁免。
 *
 *  详细 anchor/splitIndex 设计见原注释 (Phase 3.12 行为不变, 仅 step 字段访问改 helper).
 */
export function collapseActivityRuns(rows: Row[], options?: CollapseActivityOptions): Row[] {
  const out: Row[] = [];
  let run: Row[] = [];
  let anchorMsgId = "__start__";
  let splitIndex = 0;
  const flush = () => {
    if (run.length === 0) return;
    const id = `act-${anchorMsgId}-${splitIndex}`;
    splitIndex++;
    const opCount = run.reduce((acc, r) => acc + stepCountOf(r), 0);

    if (opCount <= 1 && run.length === 1) {
      out.push(run[0]!);
      run = [];
      return;
    }

    out.push(rowForActivity(id, run, opCount, run.some(rowHasActive)));
    run = [];
  };
  for (const r of rows) {
    /* plan 已在 buildRows 阶段被剔除, 这条只兜底历史/外部构造的 row */
    const isPlan = r.kind === "single" && rowStepIsPlan(r.step);
    const isTurnSummary = r.kind === "single" && rowStepIsTurnSummary(r.step);
    const isHighValue = !!options?.keepHighValue && rowIsHighValue(r);
    const isCompaction = r.kind === "single" && rowStepIsCompaction(r.step);
    const isTargetContinue = r.kind === "single" && rowStepIsTargetContinue(r.step);
    /* 富结果卡跟压缩一样**永远**不折 (极简模式也不折): 折进去就等于把这一轮的答案
     * 藏进工具组里, 用户得先想到去点开 —— 而卡片存在的意义就是一眼看完。 */
    const isRichCard = r.kind === "single" && rowStepIsRichCard(r.step);
    const isBlocked = r.kind === "single" && rowStepIsBlocked(r.step);
    if (
      r.kind === "message" || isPlan || isTurnSummary
      || isHighValue || isCompaction || isTargetContinue || isRichCard || isBlocked
    ) {
      flush();
      out.push(r);
      if (r.kind === "message") {
        anchorMsgId = r.message.id;
        splitIndex = 0;
      }
    } else {
      run.push(r);
    }
  }
  flush();
  /* 合并相邻 activity (中间只是空 assistant 消息) */
  const merged: Row[] = [];
  for (const r of out) {
    if (r.kind === "activity" && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.kind === "activity") {
        merged[merged.length - 1] = mergeActivityRow(prev, r);
        continue;
      }
      if (
        prev.kind === "message" &&
        prev.message.role === "assistant" &&
        !(prev.message.text && prev.message.text.trim()) &&
        !prev.message.streaming &&
        merged.length >= 2
      ) {
        const prevPrev = merged[merged.length - 2];
        if (prevPrev.kind === "activity") {
          merged.pop();
          merged[merged.length - 1] = mergeActivityRow(prevPrev, r);
          continue;
        }
      }
    }
    merged.push(r);
  }
  return merged;
}

export function firstStepOfRow(row: Row): RowStep | null {
  if (row.kind === "single") return row.step;
  if (row.kind === "cluster" || row.kind === "group") return row.items[0] ?? null;
  return null;
}

export function activityChildTitle(row: Row): string {
  if (row.kind === "single") {
    const oc = opChipOf(row.step);
    if (oc?.label) return [oc.label, oc.hint, oc.target].filter(Boolean).join(" · ");
    let title = rowStepTitle(row.step);
    /* "Readfile · ." 这类无信息量 arg 当没有处理, 走兜底链 */
    const sep = title.indexOf(" · ");
    if (sep > 0 && isTrivialDigestArg(title.slice(sep + 3).trim())) {
      title = title.slice(0, sep);
    }
    if (!title.includes(" · ")) {
      const thinking = thinkingTextOf(row.step).replace(/\s+/g, " ").trim();
      if (thinking) return `${title} · ${thinking.length > 200 ? thinking.slice(0, 199) + "…" : thinking}`;
      const desc = rowStepDesc(row.step)?.trim();
      if (desc) return `${title} · ${desc.length > 200 ? desc.slice(0, 199) + "…" : desc}`;
    }
    return title;
  }
  if (row.kind === "cluster") return row.items.length > 1 ? `${row.head} ×${row.items.length}` : row.head;
  if (row.kind === "group") return row.label;
  if (row.kind === "message") {
    if (row.message.role === "user") return _isZh() ? "用户消息" : "User message";
    return _isZh() ? "助手消息" : "Agent message";
  }
  return _isZh() ? "动作" : "Action";
}

function isNoiseMeta(m: string): boolean {
  return /^[\d.,]+\s*(B|KB|MB|GB|字符|chars?)$/i.test(m) || m === "reasoning";
}

export function activityChildMeta(row: Row): string[] {
  const step = firstStepOfRow(row);
  if (!step) return [];
  const meta = [...(rowStepMeta(step) ?? [])].filter((m) => !isNoiseMeta(m));
  const wc = webMetaOf(step);
  if (wc) {
    if (wc.variant === 'fetch' && typeof wc.bytes === 'number') {
      meta.push(wc.bytes >= 1024 ? `${(wc.bytes / 1024).toFixed(1)} KB` : `${wc.bytes} B`);
    } else if (wc.variant === 'search' && typeof wc.total === 'number') {
      meta.push(_isZh() ? `${wc.total} 条` : `${wc.total} results`);
    }
  }
  const dur = rowStepDuration(step);
  if (dur && !/^0(\.\d+)?s$/i.test(dur)) meta.push(dur);
  if (row.kind === "cluster" || row.kind === "group") {
    meta.push(_isZh() ? `${row.items.length} 项` : `${row.items.length} items`);
  }
  return meta.slice(0, 3);
}

function webMetaOf(s: RowStep): { variant?: string; bytes?: number; total?: number } | undefined {
  if (isHistoryCellRow(s)) {
    const c = s.cell as { kind?: string; variant?: string; bytes?: number; total?: number };
    return c?.kind === 'web_search' ? c : undefined;
  }
  const c = rowStepLegacyStep(s).content as { type?: string; kind?: string; bytes?: number; total?: number } | undefined;
  return c?.type === 'web' ? { variant: c.kind, bytes: c.bytes, total: c.total } : undefined;
}

/** 这一步的 op_chip 内容 (只在 legacy 路径上有; history cell 行没有 op_chip)。 */
function opChipOf(s: RowStep): { label?: string; target?: string; hint?: string; deletionSnapshotId?: string } | undefined {
  if (isHistoryCellRow(s)) return undefined;
  const c = rowStepLegacyStep(s).content as { type?: string; label?: string; target?: string; hint?: string; deletionSnapshotId?: string } | undefined;
  return c?.type === 'op_chip' ? c : undefined;
}

export function rowBodyWouldBeEmpty(row: Row): boolean {
  const step = firstStepOfRow(row);
  if (!step) return false;
  if (isHistoryCellRow(step)) {
    const c = step.cell as { kind?: string; results?: unknown[] };
    if (c?.kind === 'web_search') return !Array.isArray(c.results) || c.results.length === 0;
    return false;
  }
  const c = rowStepLegacyStep(step).content as { type?: string; results?: unknown[]; deletionSnapshotId?: string } | undefined;
  if (c?.type === 'web') return !Array.isArray(c.results) || c.results.length === 0;
  if (c?.type === 'op_chip') return !c.deletionSnapshotId;
  if (c?.type === 'none') return true;
  return false;
}

/** 子行的改动量 —— 单独取出来给渲染层上色 (跟父级合并行同一套绿/红)。
 *  失败的步骤返回 'void': 一个字都没写进去, 不能显示成改动量。 */
export function activityChildDiffStat(row: Row): { add: number; del: number } | 'void' | null {
  const step = firstStepOfRow(row);
  if (!step) return null;
  const ds = rowStepDiffStat(step);
  if (!ds) return null;
  if (rowStepStatus(step) === "failed") return 'void';
  return ds;
}

export function rowHasLiveStep(row: Row): boolean {
  const isLive = (s: RowStep) => {
    const st = rowStepStatus(s);
    return st === "running" || st === "pending" || st === "awaiting" || st === "failed" || isWaitingAskStep(s);
  };
  if (row.kind === "single") return isLive(row.step);
  if (row.kind === "cluster" || row.kind === "group") return row.items.some(isLive);
  if (row.kind === "activity") return row.rows.some(rowHasLiveStep);
  return false;
}

export function rowHasRunningStep(row: Row): boolean {
  const isRunning = (s: RowStep) => {
    const st = rowStepStatus(s);
    return st === "running" || st === "pending" || st === "awaiting" || isWaitingAskStep(s);
  };
  if (row.kind === "single") return isRunning(row.step);
  if (row.kind === "cluster" || row.kind === "group") return row.items.some(isRunning);
  if (row.kind === "activity") return row.rows.some(rowHasRunningStep);
  return false;
}

/* ============================================================
 * Phase 3.12 兼容 shim — TimelineStep → LegacyStepRow 升降换洗
 *
 *   旧测试 fixture 直接 push TimelineStep 进 Row.single.step, 现在 Row.step 是
 *   RowStep union. 提供 wrapStepAsRowStep 帮老代码 / 测试一行升降.
 *   外部消费者侧 Phase E 完成后, 旧调用入口都改 mapTimelineEntriesToRows,
 *   此 helper 主要服务于单测 fixture.
 * ============================================================ */
export function wrapStepAsRowStep(step: TimelineStep): LegacyStepRow {
  return { kind: "legacy_step", step };
}

/** RowStep → TimelineStep 兼容降级 — TimelineStep.tsx/ClusterRow 内部仍按 TimelineStep
 *  接口工作 (保留所有 timing/scroll/animation 逻辑). HistoryCellRow.legacyContent 透传到
 *  step.content; TimelineStep.tsx 内部 buildHistoryCellFromStep 拿 content.type 再
 *  dispatch HistoryCellRenderer (Phase E lite 已就位).
 *
 * 稳定性: 用 HistoryCellRow **对象身份** 做 WeakMap 缓存 (不是 fingerprint).
 *   stabilizeTimelineRows 在签名不变时复用同一 HistoryCellRow 引用 → 缓存命中 →
 *   TimelineStep memo 生效. 内容变了会 new HistoryCellRow → 自然失效, 不会显示过期 UI.
 */
const historyCellAsStepCache = new WeakMap<HistoryCellRow, TimelineStep>();

export function rowStepToTimelineStep(s: RowStep): TimelineStep {
  if (isLegacyStepRow(s)) return s.step;
  if (!isHistoryCellRow(s)) return s;
  const cached = historyCellAsStepCache.get(s);
  if (cached) return cached;
  const step: TimelineStep = {
    kind: "tool",
    id: s.id,
    title: s.title,
    desc: s.desc,
    status: s.status,
    tone: s.tone,
    iconKind: s.iconKind,
    brandIcon: s.brandIcon,
    timestamp: s.timestamp,
    duration: s.duration,
    startedAtMs: s.startedAtMs,
    content: s.legacyContent,
    defaultExpanded: s.defaultExpanded,
    presentation: s.presentation,
    meta: s.meta,
    diffStat: s.diffStat,
    groupId: s.groupId,
    groupLabel: s.groupLabel,
  };
  historyCellAsStepCache.set(s, step);
  return step;
}

export function foldRepeatedSteps(items: readonly RowStep[]): Array<{ step: RowStep; count: number }> {
  const out: Array<{ step: RowStep; count: number }> = [];
  for (const s of items) {
    const last = out[out.length - 1];
    if (last && rowStepTitle(last.step) === rowStepTitle(s) && rowStepStatus(last.step) === rowStepStatus(s)) {
      last.count += 1;
      continue;
    }
    out.push({ step: s, count: 1 });
  }
  return out;
}
