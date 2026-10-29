export type MemoryCategory = 'progress' | 'standard' | 'lesson' | 'pinned';

export interface MemoryItem {
  schemaVersion: 1;
  id: string;
  ts: number;
  category: MemoryCategory;
  summary: string;
  sessionId?: string;
  runId?: string;
  files?: string[];
  evidence?: { eventId: string };
  confidence?: number;
  tags?: string[];
}

export type MemoryGraphNodeType = 'task' | 'file' | 'tool';
export type MemoryGraphEdgeType = 'touches' | 'uses';

export interface MemoryGraphNode {
  schemaVersion: 1;
  id: string;
  type: MemoryGraphNodeType;
  label: string;
  ts: number;
  sessionId?: string;
  runId?: string;
  evidence?: { eventId: string };
}

export interface MemoryGraphEdge {
  schemaVersion: 1;
  id: string;
  type: MemoryGraphEdgeType;
  from: string;
  to: string;
  ts: number;
  sessionId?: string;
  runId?: string;
  evidence?: { eventId: string };
}
