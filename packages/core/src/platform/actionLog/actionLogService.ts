import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WORKSPACES_DIR, buildWorkspaceId } from '../workspaceDataDir.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ActionLogSqliteAdapter } from '@neoxlabs/platform/platform/actionLog/actionLogSqliteAdapter.js';
import type {
  ActionLogEvent,
  ActionLogEventInput,
  ActionLogEventType,
  ActionLogIndexEntry,
  ActionLogMeta,
  ActionLogSummaryItem,
  ActionLogSummarySnapshot,
  SessionSummaryItem,
  MemoryStats,
  MemoryStatsEntry,
} from '@neoxlabs/platform/platform/actionLog/types.js';
import type {
  MemoryCategory,
  MemoryItem,
  MemoryGraphNode,
  MemoryGraphEdge,
} from '@neoxlabs/platform/platform/memory/index.js';

const DEFAULT_FLUSH_INTERVAL_MS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INDEX_STRIDE = 50;
const DEFAULT_SUMMARY_WINDOW = 40;
const DEFAULT_MAX_SUMMARY_CHARS = 4000;
const DEFAULT_SESSION_SUMMARY_ITEMS = 8;
const MAX_SESSION_SUMMARY_LENGTH = 240;
const MAX_SESSION_FILES = 8;
const SESSION_SUMMARY_TAIL_BYTES = 256 * 1024;
const DEFAULT_MEMORY_ITEMS = 6;
const MAX_MEMORY_SUMMARY_LENGTH = 240;
const GRAPH_TAIL_BYTES = 512 * 1024;

export interface ActionLogServiceOptions {
  workspacePath?: string;
  source?: string;
  agentName?: string;
  flushIntervalMs?: number;
  batchSize?: number;
  indexStride?: number;
  summaryWindow?: number;
  maxSummaryChars?: number;
}


function getDateStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatSummaryTimestamp(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '...';
}

interface RunAggregate {
  sessionId?: string;
  startTs: number;
  promptSummary?: string;
  provider?: string;
  model?: string;
  toolCalls: number;
  fileChanges: number;
  planUpdates: number;
  retries: number;
  errors: number;
  files: Set<string>;
  tokens?: number;
  durationMs?: number;
  errorMessage?: string;
  outputPreview?: string;
}

/** 设置页「记忆」列表里的一条。字段含义见 getMemoryEntries 上方的说明。 */
export interface MemoryEntry {
  id: string;
  /** 桶: 短期 / 会话 / 长期 / 永久 */
  type: 'shortTerm' | 'session' | 'longTerm' | 'pinned';
  /** 原始事件类型 —— 只有短期桶有 (它是从 action log 里来的)。 */
  eventType?: ActionLogEventType;
  /** 这条是运行遥测而不是"记忆"。**在这一侧判完再送出去**, 不让界面自己去分类:
   *  渲染端要判就得知道 ActionLogEventType 有哪些值, 那要么深引 core (包边界不许),
   *  要么把清单再抄一份 —— 抄一份就是下次加事件类型时必漏的那处。 */
  telemetry: boolean;
  /** 长期 / 永久两桶的细分类 (进度 / 规范 / 教训 / 固定), 界面上打标签用 */
  category?: MemoryCategory;
  content: string;
  timestamp: number;
}

const TELEMETRY_EVENT_TYPES: readonly ActionLogEventType[] = [
  'run_start', 'run_attempt', 'run_result', 'run_error',
  'checkpoint', 'stream_retry', 'stream_recovered', 'status',
];

export class ActionLogService {
  private options: Required<Omit<ActionLogServiceOptions, 'workspacePath' | 'source' | 'agentName'>> &
    Pick<ActionLogServiceOptions, 'source' | 'agentName'>;
  private workspacePath: string | null = null;
  private workspaceId: string | null = null;
  private workspaceName: string | null = null;
  private eventsDir: string | null = null;
  private memoriesDir: string | null = null;
  private memoryPaths: Record<MemoryCategory, string> | null = null;
  private graphPaths: { nodes: string; edges: string } | null = null;
  private indexPath: string | null = null;
  private summaryPath: string | null = null;
  private sessionSummaryPath: string | null = null;
  private metaPath: string | null = null;
  private seq = 0;
  private currentDate: string | null = null;
  private currentFile: string | null = null;
  private currentFileBytes = 0;
  private queue: ActionLogEvent[] = [];
  private sessionSummaryQueue: SessionSummaryItem[] = [];
  private memoryQueue: MemoryItem[] = [];
  private graphNodeQueue: MemoryGraphNode[] = [];
  private graphEdgeQueue: MemoryGraphEdge[] = [];
  private summaryItems: ActionLogSummaryItem[] = [];
  private summaryDirty = false;
  private runAggregates = new Map<string, RunAggregate>();
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private flushPending = false;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private createdAt = Date.now();
  private sqliteAdapter: ActionLogSqliteAdapter | null = null;

  constructor(options: ActionLogServiceOptions = {}) {
    this.options = {
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      indexStride: options.indexStride ?? DEFAULT_INDEX_STRIDE,
      summaryWindow: options.summaryWindow ?? DEFAULT_SUMMARY_WINDOW,
      maxSummaryChars: options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
      source: options.source,
      agentName: options.agentName,
    };

    if (options.workspacePath) {
      void this.setWorkspace(options.workspacePath);
    }
  }

  async setWorkspace(workspacePath: string): Promise<void> {
    const resolved = path.resolve(workspacePath);
    if (this.workspacePath === resolved) {
      return;
    }

    await this.flush();

    this.workspacePath = resolved;
    this.workspaceName = path.basename(resolved);
    this.workspaceId = buildWorkspaceId(resolved);

    const workspaceDir = path.join(WORKSPACES_DIR, this.workspaceId);
    this.eventsDir = path.join(workspaceDir, 'events');
    this.memoriesDir = path.join(workspaceDir, 'memories');
    this.memoryPaths = {
      progress: path.join(this.memoriesDir, 'progress.jsonl'),
      standard: path.join(this.memoriesDir, 'standards.jsonl'),
      lesson: path.join(this.memoriesDir, 'lessons.jsonl'),
      pinned: path.join(this.memoriesDir, 'pinned.jsonl'),
    };
    this.graphPaths = {
      nodes: path.join(this.memoriesDir, 'graph_nodes.jsonl'),
      edges: path.join(this.memoriesDir, 'graph_edges.jsonl'),
    };
    this.indexPath = path.join(this.eventsDir, 'index.jsonl');
    this.summaryPath = path.join(this.eventsDir, 'recent_summary.json');
    this.sessionSummaryPath = this.memoriesDir
      ? path.join(this.memoriesDir, 'session_summary.jsonl')
      : null;
    this.metaPath = path.join(this.eventsDir, 'meta.json');
    this.currentDate = null;
    this.currentFile = null;
    this.currentFileBytes = 0;
    this.sessionSummaryQueue = [];
    this.memoryQueue = [];
    this.graphNodeQueue = [];
    this.graphEdgeQueue = [];
    this.runAggregates.clear();
    this.ready = false;

    this.initPromise = this.initializeWorkspace();
    await this.initPromise;

    try {
      const { NeoxDatabase } = await import('@neoxlabs/platform/platform/database.js');
      const db = new NeoxDatabase();
      this.sqliteAdapter = new ActionLogSqliteAdapter(db, resolved);
    } catch {
      // Non-fatal: fall back to JSONL only
    }
  }

  formatFilePath(filePath: string): string {
    if (!this.workspacePath) return filePath;
    const relative = path.relative(this.workspacePath, filePath);
    if (!relative || relative.startsWith('..')) {
      return filePath;
    }
    return relative;
  }

  record(input: ActionLogEventInput): void {
    if (!this.workspacePath || !this.workspaceId) {
      return;
    }

    const event: ActionLogEvent = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      seq: ++this.seq,
      ts: input.ts ?? Date.now(),
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      type: input.type,
      sessionId: input.sessionId,
      runId: input.runId,
      actor: input.actor,
      summary: input.summary,
      reason: input.reason,
      files: input.files,
      data: input.data,
    };

    this.queue.push(event);
    this.updateSummary(event);
    this.updateRunAggregate(event);
    this.maybeQueueSessionSummary(event);
    this.queueGraphEntries(this.extractGraphEntries(event));

    const flushOnResult = event.type === 'run_result' || event.type === 'run_error';
    if (this.queue.length >= this.options.batchSize || flushOnResult) {
      void this.flush();
    }
  }

  createRunId(): string {
    return crypto.randomUUID();
  }

  /**
   * 公开的记忆写入接口 — 供 LLM 工具调用
   */
  addMemoryItem(item: Omit<MemoryItem, 'schemaVersion' | 'id' | 'ts'>): void {
    const full: MemoryItem = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...item,
    };
    this.queueMemoryEntries([full], 'event');
    void this.flush();
  }

  async getContextSummary(options?: {
    language?: 'zh' | 'en';
    maxItems?: number;
    maxChars?: number;
    maxSessionItems?: number;
    maxMemoryItems?: number;
    query?: string;
  }): Promise<string | null> {
    const _t0 = Date.now();
    const _elapsed = () => `${Date.now() - _t0}ms`;
    const query = options?.query?.trim();
    cliLogger.info('CTX_SUMMARY', `[START] query="${query ?? '(none)'}"`);

    await this.ensureReady();
    cliLogger.debug('CTX_SUMMARY', `[1/6] ensureReady done ${_elapsed()}`);

    if (this.summaryItems.length === 0) {
      await this.loadSummarySnapshot();
    }
    cliLogger.debug('CTX_SUMMARY', `[2/6] loadSummarySnapshot done ${_elapsed()}, items=${this.summaryItems.length}`);

    const language = options?.language ?? 'zh';
    const maxItems = options?.maxItems ?? this.options.summaryWindow;
    const maxSessionItems = options?.maxSessionItems ?? DEFAULT_SESSION_SUMMARY_ITEMS;
    const maxMemoryItems = options?.maxMemoryItems ?? DEFAULT_MEMORY_ITEMS;
    const maxChars = options?.maxChars ?? this.options.maxSummaryChars;
    const labels =
      language === 'zh'
        ? {
          memoryHeader: '## 项目记忆（自动）',
          pinned: '### 固定',
          progress: '### 进度',
          standard: '### 规范',
          lesson: '### 教训',
          sessionHeader: '## 会话摘要',
          activityHeader: '## 最近工作摘要',
        }
        : {
          memoryHeader: '## Project Memory (Auto)',
          pinned: '### Pinned',
          progress: '### Progress',
          standard: '### Standards',
          lesson: '### Lessons',
          sessionHeader: '## Session Summary',
          activityHeader: '## Recent Workspace Activity',
        };

    let queryContext: { tokens: string[]; graphMatches: Set<string> } | null = null;
    if (query) {
      const tokens = this.tokenizeQuery(query);
      cliLogger.debug('CTX_SUMMARY', `[3/6] tokenize done ${_elapsed()}, tokens=${tokens.length}: [${tokens.join(',')}]`);
      queryContext = {
        tokens,
        graphMatches: await this.getGraphRunMatches(tokens),
      };
      cliLogger.debug('CTX_SUMMARY', `[3/6] graphRunMatches done ${_elapsed()}, matches=${queryContext.graphMatches.size}`);
    } else {
      cliLogger.debug('CTX_SUMMARY', `[3/6] no query, skip graph ${_elapsed()}`);
    }

    const sessionItems = query && queryContext
      ? await this.getRelevantSessionSummaries(query, maxSessionItems, queryContext)
      : await this.getRecentSessionSummaries(maxSessionItems);
    cliLogger.debug('CTX_SUMMARY', `[4/6] sessionSummaries done ${_elapsed()}, count=${sessionItems.length}`);

    const memoryItems = query && queryContext
      ? await this.getRelevantMemoryItems(query, maxMemoryItems, queryContext)
      : {
        pinned: await this.getRecentMemoryItems('pinned', maxMemoryItems),
        progress: await this.getRecentMemoryItems('progress', maxMemoryItems),
        standard: await this.getRecentMemoryItems('standard', maxMemoryItems),
        lesson: await this.getRecentMemoryItems('lesson', maxMemoryItems),
      };
    cliLogger.debug('CTX_SUMMARY', `[5/6] memoryItems done ${_elapsed()}, pinned=${memoryItems.pinned.length} progress=${memoryItems.progress.length} standard=${memoryItems.standard.length} lesson=${memoryItems.lesson.length}`);

    const pinnedItems = memoryItems.pinned;
    const progressItems = memoryItems.progress;
    const standardItems = memoryItems.standard;
    const lessonItems = memoryItems.lesson;
    const recentItems = this.summaryItems.slice(-maxItems);

    const formatLines = (items: { ts: number; summary: string }[]) =>
      items.map(item => {
        const timestamp = formatSummaryTimestamp(item.ts);
        return `- [${timestamp}] ${item.summary}`;
      });

    const sessionLines = formatLines(sessionItems);
    const pinnedLines = formatLines(pinnedItems);
    const progressLines = formatLines(progressItems);
    const standardLines = formatLines(standardItems);
    const lessonLines = formatLines(lessonItems);
    const recentLines = formatLines(recentItems);

    const memorySections: { key: MemoryCategory; title: string; lines: string[] }[] = [
      { key: 'pinned', title: labels.pinned, lines: pinnedLines },
      { key: 'progress', title: labels.progress, lines: progressLines },
      { key: 'standard', title: labels.standard, lines: standardLines },
      { key: 'lesson', title: labels.lesson, lines: lessonLines },
    ];

    const activitySection = { key: 'activity', title: labels.activityHeader, lines: recentLines };
    const sessionSection = { key: 'session', title: labels.sessionHeader, lines: sessionLines };

    if (
      memorySections.every(section => section.lines.length === 0) &&
      sessionLines.length === 0 &&
      recentLines.length === 0
    ) {
      return null;
    }

    const buildSummary = () => {
      const sections: string[] = [];
      const memoryBlocks = memorySections
        .filter(section => section.lines.length > 0)
        .map(section => `${section.title}\n${section.lines.join('\n')}`);
      if (memoryBlocks.length > 0) {
        sections.push(`${labels.memoryHeader}\n${memoryBlocks.join('\n')}`);
      }
      if (sessionSection.lines.length > 0) {
        sections.push(`${sessionSection.title}\n${sessionSection.lines.join('\n')}`);
      }
      if (activitySection.lines.length > 0) {
        sections.push(`${activitySection.title}\n${activitySection.lines.join('\n')}`);
      }
      return sections.join('\n');
    };

    const trimOrder: Array<MemoryCategory | 'session' | 'activity'> = [
      'activity',
      'session',
      'lesson',
      'standard',
      'progress',
      'pinned',
    ];

    const sectionMap = new Map<string, { lines: string[] }>([
      ['activity', activitySection],
      ['session', sessionSection],
      ...memorySections.map(section => [section.key, section] as const),
    ]);

    let summary = buildSummary();
    if (summary.length > maxChars) {
      let guard = 0;
      while (summary.length > maxChars && guard < 500) {
        guard += 1;
        let trimmed = false;
        for (const key of trimOrder) {
          const section = sectionMap.get(key);
          if (section && section.lines.length > 0) {
            section.lines.shift();
            trimmed = true;
            break;
          }
        }
        if (!trimmed) {
          break;
        }
        summary = buildSummary();
      }
    }

    cliLogger.info('CTX_SUMMARY', `[DONE] ${_elapsed()}, resultLen=${summary.length}`);
    return summary;
  }

  async getMemoryInjectionSummary(options?: {
    language?: 'zh' | 'en';
    query?: string;
    maxChars?: number;
    maxSessionItems?: number;
    maxMemoryItems?: number;
    includePersistent?: boolean;
    includeLastRun?: boolean;
    includeSessionSummaries?: boolean;
  }): Promise<string | null> {
    await this.ensureReady();
    if (this.summaryItems.length === 0) {
      await this.loadSummarySnapshot();
    }

    const language = options?.language ?? 'zh';
    const maxMemoryItems = options?.maxMemoryItems ?? DEFAULT_MEMORY_ITEMS;
    const maxSessionItems = options?.maxSessionItems ?? DEFAULT_SESSION_SUMMARY_ITEMS;
    const maxChars = options?.maxChars ?? this.options.maxSummaryChars;
    const includePersistent = options?.includePersistent ?? true;
    const includeLastRun = options?.includeLastRun ?? true;
    const includeSessionSummaries = options?.includeSessionSummaries ?? true;
    const query = options?.query?.trim();

    const labels =
      language === 'zh'
        ? {
          memoryHeader: '## 项目记忆',
          pinned: '### 固定',
          progress: '### 进度',
          standard: '### 规范',
          lesson: '### 教训',
          sessionHeader: '## 相关会话摘要',
          lastRunHeader: '## 上次任务摘要',
        }
        : {
          memoryHeader: '## Project Memory',
          pinned: '### Pinned',
          progress: '### Progress',
          standard: '### Standards',
          lesson: '### Lessons',
          sessionHeader: '## Related Session Summaries',
          lastRunHeader: '## Last Run Summary',
        };

    let queryContext: { tokens: string[]; graphMatches: Set<string> } | null = null;
    if (query) {
      const tokens = this.tokenizeQuery(query);
      queryContext = {
        tokens,
        graphMatches: await this.getGraphRunMatches(tokens),
      };
    }

    let memorySections: { key: MemoryCategory; title: string; lines: string[] }[] = [];
    if (includePersistent) {
      const memoryItems = query && queryContext
        ? await this.getRelevantMemoryItems(query, maxMemoryItems, queryContext)
        : {
          pinned: await this.getRecentMemoryItems('pinned', maxMemoryItems),
          progress: await this.getRecentMemoryItems('progress', maxMemoryItems),
          standard: await this.getRecentMemoryItems('standard', maxMemoryItems),
          lesson: await this.getRecentMemoryItems('lesson', maxMemoryItems),
        };

      // Filter out low-confidence items (rule-extracted garbage like run_error at 0.4)
      // pinned/standard are user-curated or high-value, skip filtering for them
      const filterLowConfidence = (items: MemoryItem[]) =>
        items.filter(item => (item.confidence ?? 1) >= 0.5);
      if (Array.isArray(memoryItems.lesson)) {
        memoryItems.lesson = filterLowConfidence(memoryItems.lesson as MemoryItem[]);
      }
      if (Array.isArray(memoryItems.progress)) {
        memoryItems.progress = filterLowConfidence(memoryItems.progress as MemoryItem[]);
      }

      const formatLines = (items: { ts: number; summary: string }[]) =>
        items.map(item => `- [${formatSummaryTimestamp(item.ts)}] ${item.summary}`);

      memorySections = [
        { key: 'pinned', title: labels.pinned, lines: formatLines(memoryItems.pinned) },
        { key: 'progress', title: labels.progress, lines: formatLines(memoryItems.progress) },
        { key: 'standard', title: labels.standard, lines: formatLines(memoryItems.standard) },
        { key: 'lesson', title: labels.lesson, lines: formatLines(memoryItems.lesson) },
      ];
    }

    const lastRunItem = includeLastRun ? await this.getLastMeaningfulSessionSummary() : null;
    const lastRunLines = lastRunItem
      ? [`- [${formatSummaryTimestamp(lastRunItem.ts)}] ${lastRunItem.summary}`]
      : [];

    let sessionLines: string[] = [];
    if (includeSessionSummaries) {
      const sessionItems = query && queryContext
        ? await this.getRelevantSessionSummaries(query, maxSessionItems, queryContext)
        : await this.getRecentSessionSummaries(maxSessionItems);
      const filtered = sessionItems.filter(item => !this.isMetaQuerySummary(item.summary));
      const deduped = lastRunItem
        ? filtered.filter(item => item.id !== lastRunItem.id)
        : filtered;
      sessionLines = deduped.map(item => `- [${formatSummaryTimestamp(item.ts)}] ${item.summary}`);
    }

    if (
      memorySections.every(section => section.lines.length === 0) &&
      sessionLines.length === 0 &&
      lastRunLines.length === 0
    ) {
      return null;
    }

    const buildSummary = () => {
      const sections: string[] = [];
      const memoryBlocks = memorySections
        .filter(section => section.lines.length > 0)
        .map(section => `${section.title}\n${section.lines.join('\n')}`);
      if (memoryBlocks.length > 0) {
        sections.push(`${labels.memoryHeader}\n${memoryBlocks.join('\n')}`);
      }
      if (sessionLines.length > 0) {
        sections.push(`${labels.sessionHeader}\n${sessionLines.join('\n')}`);
      }
      if (lastRunLines.length > 0) {
        sections.push(`${labels.lastRunHeader}\n${lastRunLines.join('\n')}`);
      }
      return sections.join('\n');
    };

    const trimOrder: Array<MemoryCategory | 'session' | 'lastRun'> = [
      'session',
      'lastRun',
      'lesson',
      'standard',
      'progress',
      'pinned',
    ];

    const sectionMap = new Map<string, { lines: string[] }>([
      ['session', { lines: sessionLines }],
      ['lastRun', { lines: lastRunLines }],
      ...memorySections.map(section => [section.key, section] as const),
    ]);

    let summary = buildSummary();
    if (summary.length > maxChars) {
      let guard = 0;
      while (summary.length > maxChars && guard < 500) {
        guard += 1;
        let trimmed = false;
        for (const key of trimOrder) {
          const section = sectionMap.get(key);
          if (section && section.lines.length > 0) {
            section.lines.shift();
            trimmed = true;
            break;
          }
        }
        if (!trimmed) {
          break;
        }
        summary = buildSummary();
      }
    }

    if (summary.length > maxChars) {
      summary = truncateText(summary, maxChars);
    }

    cliLogger.info('MEMORY_INJECT', 'Context memory hit', {
      query: query ? truncateText(query, 80) : undefined,
      includePersistent,
      includeLastRun,
      includeSessionSummaries,
      memoryCounts: Object.fromEntries(
        memorySections.map(section => [section.key, section.lines.length])
      ),
      sessionCount: sessionLines.length,
      lastRun: lastRunLines.length > 0,
      summaryChars: summary.length,
    });

    return summary;
  }

  /**
   * 一条记忆在界面上的样子。
   *
   *  `type` 是**桶** (短期/会话/长期/永久), `eventType` 是它原本的**事件类型**
   *  (run_result / checkpoint / file_change …)。两个都要, 因为界面上是两件事:
   *  桶决定它归哪一栏, 事件类型决定它到底算不算"记忆"——
   *  `Run completed in 13751ms` 和 `Checkpoint saved: cp_…` 是运行遥测, 不是用户
   *  理解的记忆, 但它们确实躺在短期桶里。只有会话/长期/永久那三个桶是纯人类内容,
   *  没有 eventType。
   */

  async getMemoryEntries(options?: {
    type?: 'all' | 'shortTerm' | 'session' | 'longTerm' | 'pinned';
    query?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    await this.ensureReady();
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 50;
    const want = (t: string) => type === 'all' || type === t;
    const out: MemoryEntry[] = [];

    const pushJsonl = async (
      filePath: string | undefined,
      bucket: 'session' | 'longTerm' | 'pinned',
      category?: MemoryCategory,
    ) => {
      if (!filePath) return;
      const rows = await this.readJsonlTail<{ id?: string; ts?: number; summary?: string }>(filePath, limit);
      for (const r of rows) {
        if (!r?.summary) continue;
        /* 会话/长期/永久三个桶是纯人类内容, 没有事件类型, 一律不是遥测 */
        out.push({
          id: r.id ?? `${bucket}-${r.ts ?? 0}`, type: bucket, telemetry: false,
          ...(category ? { category } : {}),
          content: r.summary, timestamp: r.ts ?? 0,
        });
      }
    };

    if (want('shortTerm')) {
      if (this.summaryItems.length === 0) await this.loadSummarySnapshot();
      for (const it of this.summaryItems.slice(-limit)) {
        if (!it?.summary) continue;
        out.push({
          id: it.id, type: 'shortTerm', eventType: it.type,
          telemetry: TELEMETRY_EVENT_TYPES.includes(it.type),
          content: it.summary, timestamp: it.ts,
        });
      }
    }
    if (want('session')) await pushJsonl(this.sessionSummaryPath ?? undefined, 'session');
    if (want('longTerm')) {
      /* 长期 = 进度 + 规范 + 教训 三个文件 (与 getMemoryStats 的口径一致) */
      for (const key of ['progress', 'standard', 'lesson'] as const) {
        await pushJsonl(this.memoryPaths?.[key], 'longTerm', key);
      }
    }
    if (want('pinned')) await pushJsonl(this.memoryPaths?.pinned, 'pinned', 'pinned');

    const q = options?.query?.trim().toLowerCase();
    const filtered = q ? out.filter(e => e.content.toLowerCase().includes(q)) : out;
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered.slice(0, limit);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    await this.ensureReady();
    if (this.summaryItems.length === 0) {
      await this.loadSummarySnapshot();
    }

    const shortTermCount = this.summaryItems.length;
    const shortTermSize = this.summaryPath ? await this.getFileSize(this.summaryPath) : 0;

    const sessionCount = this.sessionSummaryPath
      ? await this.countJsonlLines(this.sessionSummaryPath)
      : 0;
    const sessionSize = this.sessionSummaryPath
      ? await this.getFileSize(this.sessionSummaryPath)
      : 0;

    const progressPath = this.memoryPaths?.progress;
    const standardPath = this.memoryPaths?.standard;
    const lessonPath = this.memoryPaths?.lesson;
    const pinnedPath = this.memoryPaths?.pinned;

    const progressCount = progressPath ? await this.countJsonlLines(progressPath) : 0;
    const standardCount = standardPath ? await this.countJsonlLines(standardPath) : 0;
    const lessonCount = lessonPath ? await this.countJsonlLines(lessonPath) : 0;
    const pinnedCount = pinnedPath ? await this.countJsonlLines(pinnedPath) : 0;

    const progressSize = progressPath ? await this.getFileSize(progressPath) : 0;
    const standardSize = standardPath ? await this.getFileSize(standardPath) : 0;
    const lessonSize = lessonPath ? await this.getFileSize(lessonPath) : 0;
    const pinnedSize = pinnedPath ? await this.getFileSize(pinnedPath) : 0;

    const longTermCount = progressCount + standardCount + lessonCount;
    const longTermSize = progressSize + standardSize + lessonSize;

    const totalCount = shortTermCount + sessionCount + longTermCount + pinnedCount;
    const totalSize = shortTermSize + sessionSize + longTermSize + pinnedSize;

    const buildEntry = (count: number, sizeBytes: number, path?: string): MemoryStatsEntry => ({
      count,
      sizeBytes,
      path,
    });

    return {
      shortTerm: buildEntry(shortTermCount, shortTermSize, this.summaryPath ?? undefined),
      session: buildEntry(sessionCount, sessionSize, this.sessionSummaryPath ?? undefined),
      longTerm: {
        total: buildEntry(longTermCount, longTermSize),
        progress: buildEntry(progressCount, progressSize, progressPath),
        standard: buildEntry(standardCount, standardSize, standardPath),
        lesson: buildEntry(lessonCount, lessonSize, lessonPath),
      },
      pinned: buildEntry(pinnedCount, pinnedSize, pinnedPath),
      totals: buildEntry(totalCount, totalSize),
    };
  }

  async getRecentSessionSummaries(maxItems = DEFAULT_SESSION_SUMMARY_ITEMS): Promise<SessionSummaryItem[]> {
    await this.ensureReady();
    if (!this.sessionSummaryPath) {
      return [];
    }
    return this.readJsonlTail<SessionSummaryItem>(this.sessionSummaryPath, maxItems);
  }

  async getRecentEventSummaries(options?: {
    sessionId?: string;
    runId?: string;
    maxItems?: number;
  }): Promise<ActionLogSummaryItem[]> {
    await this.ensureReady();
    if (this.summaryItems.length === 0) {
      await this.loadSummarySnapshot();
    }
    const maxItems = options?.maxItems ?? this.options.summaryWindow;
    let items = this.summaryItems;
    if (options?.sessionId) {
      items = items.filter(item => item.sessionId === options.sessionId);
    }
    if (options?.runId) {
      items = items.filter(item => item.runId === options.runId);
    }
    if (items.length <= maxItems) {
      return items;
    }
    return items.slice(items.length - maxItems);
  }

  private async getLastMeaningfulSessionSummary(): Promise<SessionSummaryItem | null> {
    if (!this.sessionSummaryPath) {
      return null;
    }
    const items = await this.readJsonlTail<SessionSummaryItem>(this.sessionSummaryPath, 8);
    if (items.length === 0) {
      return null;
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (!this.isMetaQuerySummary(items[i].summary)) {
        return items[i];
      }
    }
    return items[items.length - 1] ?? null;
  }

  private isMetaQuerySummary(summary: string): boolean {
    if (!summary) return false;
    const normalized = summary.trim().toLowerCase();
    return /(user:|用户:)?\s*(上次|之前|前面|上一|继续|回顾|resume|continue|previous|last)/i.test(normalized);
  }

  private stripUserPrefix(text: string): string {
    return text.replace(/^(user|用户)\s*[:：]\s*/i, '').trim();
  }

  private isGreeting(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return true;
    }
    const englishGreeting = /^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i;
    if (englishGreeting.test(normalized)) {
      return true;
    }
    const chineseGreetings = ['你好', '您好', '哈喽', '嗨', '在吗', '早上好', '下午好', '晚上好', '晚安'];
    return chineseGreetings.some(greeting => normalized.startsWith(greeting));
  }

  private isLowValuePrompt(text: string): boolean {
    const normalized = this.stripUserPrefix(text);
    if (!normalized) {
      return true;
    }
    if (this.isGreeting(normalized)) {
      return true;
    }
    if (this.isMetaQuerySummary(normalized)) {
      return true;
    }
    if (this.isIdentityQuery(normalized)) {
      return true;
    }
    return normalized.length <= 2;
  }

  /**
   * 检测身份查询类提问（"你是谁"、"你是什么模型" 等）
   * 这类对话的 session summary 不应被保存，因为模型回答中的自我介绍
   * 会在跨模型使用时造成身份混乱（如 GPT 被注入 "基于 Claude"）
   */
  private isIdentityQuery(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    const patterns = [
      /^你是谁/, /^你是什么/, /^你叫什么/,
      /^who are you/i, /^what are you/i, /^what model/i,
      /^你是哪个/, /^你是啥/, /^介绍一?下你自己/,
    ];
    return patterns.some(p => p.test(normalized));
  }

  private isLowValueMemorySummary(summary: string): boolean {
    const normalized = this.stripUserPrefix(summary);
    if (!normalized) {
      return true;
    }
    if (this.isGreeting(normalized)) {
      return true;
    }
    if (this.isMetaQuerySummary(normalized)) {
      return true;
    }
    return /(会话已建立|打招呼|session (started|created))/i.test(normalized);
  }

  async getRecentMemoryItems(
    category: MemoryCategory,
    maxItems = DEFAULT_MEMORY_ITEMS
  ): Promise<MemoryItem[]> {
    await this.ensureReady();
    if (!this.memoryPaths) {
      return [];
    }
    const filePath = this.memoryPaths[category];
    return this.readJsonlTail<MemoryItem>(filePath, maxItems);
  }

  /**
   * 清空指定类别（或全部）的长期记忆
   */
  async clearMemoryItems(category?: MemoryCategory): Promise<{ cleared: string[]; errors: string[] }> {
    await this.ensureReady();
    const cleared: string[] = [];
    const errors: string[] = [];
    if (!this.memoryPaths) return { cleared, errors };

    const categories: MemoryCategory[] = category
      ? [category]
      : ['pinned', 'progress', 'standard', 'lesson'];

    for (const cat of categories) {
      const filePath = this.memoryPaths[cat];
      try {
        await fs.writeFile(filePath, '', 'utf-8');
        cleared.push(cat);
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          errors.push(`${cat}: ${e.message}`);
        } else {
          cleared.push(cat); // 文件不存在也算清空成功
        }
      }
    }
    return { cleared, errors };
  }

  async clearVolatileSummaries(kind: 'shortTerm' | 'session' | 'both' = 'both'): Promise<{ cleared: string[]; errors: string[] }> {
    await this.ensureReady();
    const cleared: string[] = [];
    const errors: string[] = [];

    if (kind === 'shortTerm' || kind === 'both') {
      /* 先清内存再删盘 —— 反过来的话中间那一刻的 flush 会把文件又写回来 */
      this.summaryItems = [];
      this.summaryDirty = false;
      this.runAggregates.clear();
      if (this.summaryPath) {
        try { await fs.unlink(this.summaryPath); cleared.push('shortTerm'); }
        catch (e: any) { if (e.code === 'ENOENT') cleared.push('shortTerm'); else errors.push(`shortTerm: ${e.message}`); }
      } else {
        cleared.push('shortTerm');
      }
    }

    if (kind === 'session' || kind === 'both') {
      this.sessionSummaryQueue = [];
      if (this.sessionSummaryPath) {
        try { await fs.writeFile(this.sessionSummaryPath, '', 'utf-8'); cleared.push('session'); }
        catch (e: any) { if (e.code === 'ENOENT') cleared.push('session'); else errors.push(`session: ${e.message}`); }
      } else {
        cleared.push('session');
      }
    }

    return { cleared, errors };
  }

  /**
   * 删掉一条记忆 (设置页每条上的 ×)。记错的、过期的要能单独删 —— 只有「全部清空」的话,
   * 用户为一条错的只能把对的一起扔掉, 记忆就永远不纯。
   * 在长期 / 永久 / 会话摘要几份文件里按 id 找, 找到就重写那份文件; 还没落盘的队列里也删。
   */
  async deleteMemoryEntry(id: string): Promise<boolean> {
    await this.ensureReady();
    if (!id) return false;
    this.memoryQueue = this.memoryQueue.filter((m) => m.id !== id);
    this.sessionSummaryQueue = this.sessionSummaryQueue.filter((s) => s.id !== id);
    await this.flush();
    const files = [
      ...(this.memoryPaths ? Object.values(this.memoryPaths) : []),
      ...(this.sessionSummaryPath ? [this.sessionSummaryPath] : []),
    ];
    for (const file of files) {
      let text: string;
      try { text = await fs.readFile(file, 'utf-8'); } catch { continue; }
      const lines = text.split('\n');
      const kept = lines.filter((line) => {
        if (!line.trim()) return false;
        try { return (JSON.parse(line) as { id?: string }).id !== id; } catch { return true; }
      });
      if (kept.length === lines.filter((l) => l.trim()).length) continue;
      await fs.writeFile(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
      return true;
    }
    return false;
  }

  private async getRelevantSessionSummaries(
    query: string,
    maxItems: number,
    queryContext?: { tokens: string[]; graphMatches: Set<string> }
  ): Promise<SessionSummaryItem[]> {
    if (!this.sessionSummaryPath) {
      return [];
    }
    const candidates = await this.readJsonlTail<SessionSummaryItem>(
      this.sessionSummaryPath,
      maxItems * 6
    );
    return this.rankRelevantItems(candidates, query, maxItems, undefined, queryContext);
  }

  private async getRelevantMemoryItems(
    query: string,
    maxItems: number,
    queryContext?: { tokens: string[]; graphMatches: Set<string> }
  ): Promise<Record<MemoryCategory, MemoryItem[]>> {
    if (!this.memoryPaths) {
      return { progress: [], standard: [], lesson: [], pinned: [] };
    }

    const categories: MemoryCategory[] = ['pinned', 'progress', 'standard', 'lesson'];
    const results: Record<MemoryCategory, MemoryItem[]> = {
      pinned: [],
      progress: [],
      standard: [],
      lesson: [],
    };

    for (const category of categories) {
      const candidates = await this.readJsonlTail<MemoryItem>(
        this.memoryPaths[category],
        maxItems * 6
      );
      results[category] = await this.rankRelevantItems(
        candidates,
        query,
        maxItems,
        category,
        queryContext
      );
    }

    return results;
  }

  private async rankRelevantItems<T extends { summary: string; ts: number; files?: string[]; runId?: string; confidence?: number }>(
    items: T[],
    query: string,
    maxItems: number,
    category?: MemoryCategory,
    queryContext?: { tokens: string[]; graphMatches: Set<string> }
  ): Promise<T[]> {
    const tokens = queryContext?.tokens ?? this.tokenizeQuery(query);
    if (tokens.length === 0) {
      return items.slice(-maxItems);
    }

    const graphMatches = queryContext?.graphMatches ?? await this.getGraphRunMatches(tokens);
    const now = Date.now();

    const scored = items.map(item => {
      const lexical = this.scoreLexical(tokens, item.summary);
      const pathScore = this.scorePath(tokens, item.files);
      const recency = this.scoreRecency(now, item.ts);
      const confidence = item.confidence ?? 0.5;
      const graphScore = item.runId && graphMatches.has(item.runId) ? 1 : 0;
      const evidenceScore = item.summary && item.summary.length > 0 ? 1 : 0;

      let score =
        0.35 * lexical +
        0.2 * pathScore +
        0.2 * graphScore +
        0.15 * recency +
        0.1 * confidence;

      if (category === 'pinned' && score < 0.2) {
        score = 0.2;
      }

      if (evidenceScore === 0) {
        score *= 0.8;
      }

      return { item, score };
    });

    await this.applyEvidencePenalty(scored, maxItems);

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(entry => entry.score > 0).slice(0, maxItems).map(entry => entry.item);
  }

  private async applyEvidencePenalty<T extends { item: { files?: string[] }; score: number }>(
    scored: T[],
    maxItems: number
  ): Promise<void> {
    if (!this.workspacePath) {
      return;
    }
    const candidates = scored.slice(0, Math.min(scored.length, maxItems * 2));
    for (const entry of candidates) {
      const file = entry.item.files?.[0];
      if (!file) continue;
      const resolved = this.resolveWorkspacePath(file);
      try {
        await fs.stat(resolved);
      } catch {
        entry.score *= 0.7;
      }
    }
  }

  private resolveWorkspacePath(filePath: string): string {
    if (path.isAbsolute(filePath) || !this.workspacePath) {
      return filePath;
    }
    return path.join(this.workspacePath, filePath);
  }

  private tokenizeQuery(query: string): string[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return [];
    }
    const tokens = trimmed
      .split(/[^a-z0-9/_\-.]+/g)
      .map(token => token.trim())
      .filter(token => token.length > 2);
    if (tokens.length === 0 && trimmed.length > 0) {
      return [trimmed];
    }
    return tokens.slice(0, 16);
  }

  private scoreLexical(tokens: string[], summary: string): number {
    if (!summary) return 0;
    const text = summary.toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (text.includes(token)) {
        hits += 1;
      }
    }
    return hits === 0 ? 0 : Math.min(1, hits / tokens.length);
  }

  private scorePath(tokens: string[], files?: string[]): number {
    if (!files || files.length === 0) {
      return 0;
    }
    let hits = 0;
    for (const file of files) {
      const lower = file.toLowerCase();
      for (const token of tokens) {
        if (lower.includes(token)) {
          hits += 1;
          break;
        }
      }
    }
    if (hits === 0) {
      return 0;
    }
    return Math.min(1, hits / files.length);
  }

  private scoreRecency(now: number, ts: number): number {
    const ageMs = Math.max(0, now - ts);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const halfLifeDays = 7;
    return Math.exp(-Math.log(2) * ageDays / halfLifeDays);
  }

  private async getGraphRunMatches(tokens: string[]): Promise<Set<string>> {
    if (!this.graphPaths || tokens.length === 0) {
      return new Set();
    }

    const nodes = await this.readJsonlTail<MemoryGraphNode>(this.graphPaths.nodes, 4000, {
      tailBytes: GRAPH_TAIL_BYTES,
      requireSummary: false,
    });
    const matchingNodeIds = new Set<string>();
    for (const node of nodes) {
      if (!node?.label) {
        continue;
      }
      const label = node.label.toLowerCase();
      for (const token of tokens) {
        if (label.includes(token)) {
          matchingNodeIds.add(node.id);
          break;
        }
      }
    }

    if (matchingNodeIds.size === 0) {
      return new Set();
    }

    const edges = await this.readJsonlTail<MemoryGraphEdge>(this.graphPaths.edges, 6000, {
      tailBytes: GRAPH_TAIL_BYTES,
      requireSummary: false,
    });
    const matches = new Set<string>();
    for (const edge of edges) {
      if (!edge?.runId) {
        continue;
      }
      if (matchingNodeIds.has(edge.to) || matchingNodeIds.has(edge.from)) {
        matches.add(edge.runId);
      }
    }

    return matches;
  }

  private async readJsonlTail<T>(
    filePath: string,
    maxItems: number,
    options?: { tailBytes?: number; requireSummary?: boolean }
  ): Promise<T[]> {
    const tailBytes = options?.tailBytes ?? SESSION_SUMMARY_TAIL_BYTES;
    const requireSummary = options?.requireSummary ?? true;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        return [];
      }
      const start = Math.max(0, stat.size - tailBytes);
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        let text = buffer.toString('utf-8');
        if (start > 0) {
          const firstNewline = text.indexOf('\n');
          if (firstNewline !== -1) {
            text = text.slice(firstNewline + 1);
          }
        }
        const lines = text.split('\n').filter(line => line.trim().length > 0);
        const items: T[] = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as T;
            if (requireSummary) {
              const summary = (parsed as { summary?: string })?.summary;
              if (summary) {
                items.push(parsed);
              }
            } else {
              items.push(parsed);
            }
          } catch {
            // Ignore malformed lines.
          }
        }
        return items.slice(-maxItems);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }

  private async countJsonlLines(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      let count = 0;
      let lastChar = '';
      let hasData = false;

      const stream = createReadStream(filePath, { encoding: 'utf-8' });

      stream.on('data', (chunk: string | Buffer) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        hasData = true;
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === '\n') {
            count += 1;
          }
        }
        lastChar = text[text.length - 1] || lastChar;
      });

      stream.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          resolve(0);
        } else {
          resolve(0);
        }
      });

      stream.on('end', () => {
        if (hasData && lastChar !== '\n') {
          count += 1;
        }
        resolve(count);
      });
    });
  }

  async flush(): Promise<void> {
    if (this.isFlushing) {
      this.flushPending = true;
      return;
    }
    if (!this.workspacePath || !this.workspaceId) {
      return;
    }

    this.isFlushing = true;
    try {
      await this.ensureReady();

      const batch = this.queue.splice(0, this.queue.length);
      const sessionBatch = this.sessionSummaryQueue.splice(0, this.sessionSummaryQueue.length);
      const memoryBatch = this.memoryQueue.splice(0, this.memoryQueue.length);
      const graphNodeBatch = this.graphNodeQueue.splice(0, this.graphNodeQueue.length);
      const graphEdgeBatch = this.graphEdgeQueue.splice(0, this.graphEdgeQueue.length);
      if (
        batch.length === 0 &&
        sessionBatch.length === 0 &&
        memoryBatch.length === 0 &&
        graphNodeBatch.length === 0 &&
        graphEdgeBatch.length === 0
      ) {
        if (this.summaryDirty) {
          await this.persistSummarySnapshot();
        }
        return;
      }

      let offset = this.currentFileBytes;
      const lines: string[] = [];
      const indexLines: string[] = [];

      if (batch.length > 0) {
        await this.ensureLogFile();
        for (const event of batch) {
          const line = JSON.stringify(event);
          const bytes = Buffer.byteLength(line) + 1;
          if (event.seq % this.options.indexStride === 0 && this.currentFile) {
            const entry: ActionLogIndexEntry = {
              schemaVersion: 1,
              seq: event.seq,
              ts: event.ts,
              file: path.basename(this.currentFile),
              offset,
            };
            indexLines.push(JSON.stringify(entry) + '\n');
          }
          lines.push(line + '\n');
          offset += bytes;
        }

        if (this.currentFile && lines.length > 0) {
          await fs.appendFile(this.currentFile, lines.join(''), 'utf-8');
          this.currentFileBytes = offset;
        }
      }

      if (this.indexPath && indexLines.length > 0) {
        await fs.appendFile(this.indexPath, indexLines.join(''), 'utf-8');
      }

      if (batch.length > 0) {
        await this.persistMeta();
      }
      await this.persistSummarySnapshot();

      if (this.sessionSummaryPath && sessionBatch.length > 0) {
        const lines = sessionBatch.map(item => JSON.stringify(item)).join('\n') + '\n';
        await fs.appendFile(this.sessionSummaryPath, lines, 'utf-8');
        cliLogger.info('SESSION_SUMMARY_FLUSHED', 'Session summaries persisted', {
          count: sessionBatch.length,
          path: this.sessionSummaryPath,
        });
      }

      if (this.memoryPaths && memoryBatch.length > 0) {
        const grouped = new Map<MemoryCategory, MemoryItem[]>();
        for (const item of memoryBatch) {
          const list = grouped.get(item.category);
          if (list) {
            list.push(item);
          } else {
            grouped.set(item.category, [item]);
          }
        }
        for (const [category, items] of grouped) {
          const filePath = this.memoryPaths[category];
          const lines = items.map(item => JSON.stringify(item)).join('\n') + '\n';
          await fs.appendFile(filePath, lines, 'utf-8');
        }
      }

      if (this.graphPaths && (graphNodeBatch.length > 0 || graphEdgeBatch.length > 0)) {
        if (graphNodeBatch.length > 0) {
          const lines = graphNodeBatch.map(item => JSON.stringify(item)).join('\n') + '\n';
          await fs.appendFile(this.graphPaths.nodes, lines, 'utf-8');
        }
        if (graphEdgeBatch.length > 0) {
          const lines = graphEdgeBatch.map(item => JSON.stringify(item)).join('\n') + '\n';
          await fs.appendFile(this.graphPaths.edges, lines, 'utf-8');
        }
      }
      if (this.sqliteAdapter) {
        try {
          if (batch.length > 0) this.sqliteAdapter.insertEvents(batch);
          if (sessionBatch.length > 0) this.sqliteAdapter.insertSessionSummaries(sessionBatch);
          if (memoryBatch.length > 0) this.sqliteAdapter.insertMemoryItems(memoryBatch);
          if (graphNodeBatch.length > 0) this.sqliteAdapter.insertGraphNodes(graphNodeBatch);
          if (graphEdgeBatch.length > 0) this.sqliteAdapter.insertGraphEdges(graphEdgeBatch);
        } catch { /* non-fatal: JSONL is still the primary */ }
      }
    } finally {
      this.isFlushing = false;
      if (this.flushPending) {
        this.flushPending = false;
        await this.flush();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private async initializeWorkspace(): Promise<void> {
    if (!this.eventsDir || !this.workspaceId || !this.workspacePath) {
      return;
    }

    await fs.mkdir(this.eventsDir, { recursive: true });
    if (this.memoriesDir) {
      await fs.mkdir(this.memoriesDir, { recursive: true });
    }
    await this.loadMeta();
    await this.loadSummarySnapshot();
    this.ensureFlushTimer();
    this.ready = true;
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (this.initPromise) {
      cliLogger.warn('CTX_SUMMARY', `ensureReady: waiting on initPromise (workspaceId=${this.workspaceId}, workspacePath=${this.workspacePath})`);
      await this.initPromise;
      cliLogger.info('CTX_SUMMARY', `ensureReady: initPromise resolved, ready=${this.ready}`);
    } else {
      cliLogger.warn('CTX_SUMMARY', `ensureReady: not ready AND no initPromise! (workspaceId=${this.workspaceId})`);
    }
  }

  private async ensureLogFile(): Promise<void> {
    if (!this.eventsDir) {
      return;
    }

    const today = getDateStamp(Date.now());
    if (this.currentDate === today && this.currentFile) {
      return;
    }

    this.currentDate = today;
    this.currentFile = path.join(this.eventsDir, `events-${today}.jsonl`);
    this.currentFileBytes = await this.getFileSize(this.currentFile);
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  private updateSummary(event: ActionLogEvent): void {
    if (!event.summary) {
      return;
    }

    this.summaryItems.push({
      id: event.id,
      ts: event.ts,
      type: event.type,
      summary: event.summary,
      files: event.files,
      sessionId: event.sessionId,
      runId: event.runId,
    });

    if (this.summaryItems.length > this.options.summaryWindow) {
      this.summaryItems.splice(0, this.summaryItems.length - this.options.summaryWindow);
    }

    this.summaryDirty = true;
  }

  private queueMemoryEntries(entries: MemoryItem[], source: 'event' | 'summarizer'): void {
    if (!entries.length) {
      return;
    }
    const filtered = entries.filter(entry => !this.isLowValueMemorySummary(entry.summary));
    if (filtered.length === 0) {
      return;
    }
    this.memoryQueue.push(...filtered);
    for (const entry of filtered) {
      cliLogger.info('MEMORY_WRITE', 'Memory item recorded', {
        source,
        category: entry.category,
        summary: truncateText(entry.summary, 160),
        runId: entry.runId,
        sessionId: entry.sessionId,
        files: entry.files?.slice(0, 3),
        confidence: entry.confidence,
      });
    }
  }

  private queueGraphEntries(entries: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }): void {
    if (entries.nodes.length > 0) {
      this.graphNodeQueue.push(...entries.nodes);
    }
    if (entries.edges.length > 0) {
      this.graphEdgeQueue.push(...entries.edges);
    }
  }


  private extractGraphEntries(event: ActionLogEvent): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
    const nodes: MemoryGraphNode[] = [];
    const edges: MemoryGraphEdge[] = [];
    if (!this.graphPaths || !event.runId) {
      return { nodes, edges };
    }

    const taskNode = this.buildGraphNode({
      id: `task:${event.runId}`,
      type: 'task',
      label: truncateText(event.summary ?? event.data?.prompt ?? 'Task', 120),
      event,
    });

    if (event.type === 'run_start') {
      nodes.push(taskNode);
    }

    if (event.type === 'tool_call_start') {
      const toolName = event.data?.name;
      if (toolName) {
        const toolNode = this.buildGraphNode({
          id: `tool:${toolName}`,
          type: 'tool',
          label: toolName,
          event,
        });
        nodes.push(toolNode);
        edges.push(this.buildGraphEdge({
          type: 'uses',
          from: taskNode.id,
          to: toolNode.id,
          event,
        }));
      }
    }

    if (event.type === 'file_change' && event.files?.length) {
      for (const file of event.files) {
        const fileNode = this.buildGraphNode({
          id: `file:${file}`,
          type: 'file',
          label: file,
          event,
        });
        nodes.push(fileNode);
        edges.push(this.buildGraphEdge({
          type: 'touches',
          from: taskNode.id,
          to: fileNode.id,
          event,
        }));
      }
    }

    return { nodes, edges };
  }

  private buildGraphNode(options: {
    id: string;
    type: MemoryGraphNode['type'];
    label: string;
    event: ActionLogEvent;
  }): MemoryGraphNode {
    return {
      schemaVersion: 1,
      id: options.id,
      type: options.type,
      label: options.label,
      ts: options.event.ts,
      sessionId: options.event.sessionId,
      runId: options.event.runId,
      evidence: { eventId: options.event.id },
    };
  }

  private buildGraphEdge(options: {
    type: MemoryGraphEdge['type'];
    from: string;
    to: string;
    event: ActionLogEvent;
  }): MemoryGraphEdge {
    return {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      type: options.type,
      from: options.from,
      to: options.to,
      ts: options.event.ts,
      sessionId: options.event.sessionId,
      runId: options.event.runId,
      evidence: { eventId: options.event.id },
    };
  }


  private updateRunAggregate(event: ActionLogEvent): void {
    if (!event.runId) {
      return;
    }

    let aggregate = this.runAggregates.get(event.runId);
    if (!aggregate) {
      aggregate = {
        sessionId: event.sessionId,
        startTs: event.ts,
        toolCalls: 0,
        fileChanges: 0,
        planUpdates: 0,
        retries: 0,
        errors: 0,
        files: new Set<string>(),
      };
      this.runAggregates.set(event.runId, aggregate);
    }

    switch (event.type) {
      case 'run_start':
        aggregate.startTs = event.ts;
        aggregate.sessionId = event.sessionId;
        aggregate.promptSummary = event.summary ?? event.data?.prompt;
        break;
      case 'run_attempt':
        aggregate.provider = event.data?.providerName ?? event.data?.providerId;
        aggregate.model = event.data?.model;
        break;
      case 'tool_call_start':
        aggregate.toolCalls += 1;
        break;
      case 'file_change':
        aggregate.fileChanges += 1;
        if (event.files?.length) {
          for (const file of event.files) {
            if (aggregate.files.size >= MAX_SESSION_FILES) break;
            aggregate.files.add(file);
          }
        }
        break;
      case 'plan_update':
        aggregate.planUpdates += 1;
        break;
      case 'stream_retry':
        aggregate.retries += 1;
        break;
      case 'run_error':
        aggregate.errors += 1;
        aggregate.errorMessage = event.data?.message ?? event.summary;
        break;
      case 'run_result':
        aggregate.tokens = event.data?.totalTokens;
        aggregate.durationMs = event.data?.durationMs;
        aggregate.outputPreview = event.data?.outputPreview;
        break;
      default:
        break;
    }
  }

  private maybeQueueSessionSummary(event: ActionLogEvent): void {
    if (!event.runId) {
      return;
    }
    if (event.type !== 'run_result' && event.type !== 'run_error') {
      return;
    }

    const aggregate = this.runAggregates.get(event.runId);
    if (!aggregate) {
      return;
    }
    this.runAggregates.delete(event.runId);

    const durationMs = aggregate.durationMs ?? Math.max(0, event.ts - aggregate.startTs);
    const tokens = aggregate.tokens;
    const status =
      event.type === 'run_result'
        ? 'Completed'
        : `Failed: ${truncateText(aggregate.errorMessage ?? event.summary ?? 'Error', 120)}`;
    const extras: string[] = [];
    if (aggregate.toolCalls > 0) extras.push(`tools ${aggregate.toolCalls}`);
    if (aggregate.fileChanges > 0) extras.push(`files ${aggregate.fileChanges}`);
    if (aggregate.retries > 0) extras.push(`retries ${aggregate.retries}`);
    const extraSuffix = extras.length ? ` (${extras.join(', ')})` : '';
    const baseSummary = (aggregate.promptSummary ?? 'User request')
      .replace(/<(current-time|reply-language)>[\s\S]*?<\/\1>/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'User request';
    if (this.isLowValuePrompt(baseSummary)) {
      return;
    }
    // 原因：旧模型的自我介绍（"基于 Claude 构建"）会被注入到新模型的 context，
    // 导致跨模型使用时身份混乱（GPT 自称 Claude）。session summary 只保留元信息。
    const summary = truncateText(
      `${baseSummary} -> ${status}${extraSuffix}`,
      MAX_SESSION_SUMMARY_LENGTH
    );

    const files = Array.from(aggregate.files);
    const item: SessionSummaryItem = {
      schemaVersion: 1,
      id: event.id,
      ts: event.ts,
      sessionId: aggregate.sessionId,
      runId: event.runId,
      summary,
      files: files.length ? files : undefined,
      evidence: { eventId: event.id },
      model: aggregate.model,
      provider: aggregate.provider,
      toolCalls: aggregate.toolCalls || undefined,
      errors: aggregate.errors || (event.type === 'run_error' ? 1 : undefined),
      durationMs,
      tokens,
    };

    this.sessionSummaryQueue.push(item);
    cliLogger.info('SESSION_SUMMARY_QUEUED', 'Session summary queued', {
      runId: item.runId,
      sessionId: item.sessionId,
      summary: truncateText(item.summary, 160),
      files: item.files,
      toolCalls: item.toolCalls,
      retries: aggregate.retries,
      errors: item.errors,
      durationMs: item.durationMs,
      tokens: item.tokens,
    });
  }

  private async loadSummarySnapshot(): Promise<void> {
    if (!this.summaryPath) {
      return;
    }
    try {
      const raw = await fs.readFile(this.summaryPath, 'utf-8');
      const parsed = JSON.parse(raw) as ActionLogSummarySnapshot;
      if (parsed?.items?.length) {
        this.summaryItems = parsed.items.slice(-this.options.summaryWindow);
      }
    } catch {
      // Ignore missing or invalid summary.
    }
  }

  private async persistSummarySnapshot(): Promise<void> {
    if (!this.summaryPath || !this.workspaceId || !this.summaryDirty) {
      return;
    }

    const snapshot: ActionLogSummarySnapshot = {
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      updatedAt: Date.now(),
      windowSize: this.options.summaryWindow,
      items: this.summaryItems,
    };

    const tempPath = `${this.summaryPath}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    await fs.rename(tempPath, this.summaryPath);
    this.summaryDirty = false;
  }

  private async loadMeta(): Promise<void> {
    if (!this.metaPath) {
      return;
    }
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as ActionLogMeta;
      if (parsed?.lastSeq) {
        this.seq = parsed.lastSeq;
      }
      if (parsed?.createdAt) {
        this.createdAt = parsed.createdAt;
      }
      if (parsed?.currentFile && this.eventsDir) {
        const filePath = path.join(this.eventsDir, parsed.currentFile);
        this.currentFile = filePath;
        this.currentDate = parsed.currentFile.slice('events-'.length, 'events-'.length + 10);
        this.currentFileBytes = await this.getFileSize(filePath);
      }
    } catch {
      // Ignore missing or invalid meta.
    }
  }

  private async persistMeta(): Promise<void> {
    if (!this.metaPath || !this.workspaceId || !this.workspacePath || !this.workspaceName) {
      return;
    }

    const meta: ActionLogMeta = {
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      workspaceName: this.workspaceName,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      lastSeq: this.seq,
      currentFile: this.currentFile ? path.basename(this.currentFile) : undefined,
      currentFileBytes: this.currentFileBytes,
      source: this.options.source,
      agentName: this.options.agentName,
    };

    const tempPath = `${this.metaPath}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(meta, null, 2), 'utf-8');
    await fs.rename(tempPath, this.metaPath);
  }
}
