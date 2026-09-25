export type ActionLogActor = 'user' | 'assistant' | 'tool' | 'system';

export type ActionLogEventType =
  | 'run_start'
  | 'run_attempt'
  | 'run_result'
  | 'run_error'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'file_change'
  | 'plan_update'
  | 'checkpoint'
  | 'context_compaction'
  | 'stream_retry'
  | 'stream_recovered'
  | 'status';

export interface ActionLogEventInput {
  type: ActionLogEventType;
  sessionId?: string;
  runId?: string;
  actor?: ActionLogActor;
  summary?: string;
  reason?: string;
  files?: string[];
  data?: Record<string, any>;
  ts?: number;
}

export interface ActionLogEvent {
  schemaVersion: 1;
  id: string;
  seq: number;
  ts: number;
  workspaceId: string;
  workspacePath: string;
  type: ActionLogEventType;
  sessionId?: string;
  runId?: string;
  actor?: ActionLogActor;
  summary?: string;
  reason?: string;
  files?: string[];
  data?: Record<string, any>;
}

export interface ActionLogIndexEntry {
  schemaVersion: 1;
  seq: number;
  ts: number;
  file: string;
  offset: number;
}

export interface ActionLogSummaryItem {
  id: string;
  ts: number;
  type: ActionLogEventType;
  summary: string;
  files?: string[];
  sessionId?: string;
  runId?: string;
}

export interface ActionLogSummarySnapshot {
  schemaVersion: 1;
  workspaceId: string;
  updatedAt: number;
  windowSize: number;
  items: ActionLogSummaryItem[];
}

export interface SessionSummaryItem {
  schemaVersion: 1;
  id: string;
  ts: number;
  sessionId?: string;
  runId?: string;
  summary: string;
  files?: string[];
  evidence?: { eventId: string };
  model?: string;
  provider?: string;
  toolCalls?: number;
  errors?: number;
  durationMs?: number;
  tokens?: number;
}

export interface MemoryStatsEntry {
  count: number;
  sizeBytes: number;
  path?: string;
}

export interface MemoryStats {
  shortTerm: MemoryStatsEntry;
  session: MemoryStatsEntry;
  longTerm: {
    total: MemoryStatsEntry;
    progress: MemoryStatsEntry;
    standard: MemoryStatsEntry;
    lesson: MemoryStatsEntry;
  };
  pinned: MemoryStatsEntry;
  totals: MemoryStatsEntry;
}

export interface ActionLogMeta {
  schemaVersion: 1;
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  currentFile?: string;
  currentFileBytes?: number;
  source?: string;
  agentName?: string;
}
