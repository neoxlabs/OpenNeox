/**
 * Command Handler Context
 * Provides the interface for command handlers to access CLI state
 */

import type { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { DefaultSessionManager, SessionSyncManager } from '@neoxlabs/core/memory/index.js';
import type { Session, SessionInfo, CheckpointItem } from '@neoxlabs/kernel/types/session.js';
import type { UndoResult, RollbackResult } from '@neoxlabs/core/memory/session-sync.js';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { colors } from '../constants.js';
import type { SelectionChoice } from '../cliTypes.js';
import type { NeoxClient } from '@neoxlabs/core/sdk/client.js';

/**
 * Minimal runtime-host surface used by command handlers
 */
export interface RuntimeHostLike {
  createCheckpoint(label?: string): Promise<string>;
  cleanupCheckpoints?(): Promise<void>;
  getCheckpointStats?(): Promise<unknown>;
  listCheckpoints(): Promise<CheckpointItem[]>;
  rollbackTo(checkpointId: string): Promise<RollbackResult>;
  listSessions(): Promise<SessionInfo[]>;
  getCurrentSessionId(): string | null | undefined;
  switchSession(id: string): Promise<Session>;
  createSession(model: string): Promise<Session>;
  getSessionInfo(): Promise<{
    sessionId: string;
    turnCount: number;
    messageCount: number;
    checkpointCount: number;
    meta: Record<string, unknown> | null;
  }>;
  undoTurns(count: number): Promise<UndoResult>;
  clearSession(): Promise<void>;
}

/**
 * Context interface passed to command handlers
 */
export interface CommandContext {
  // Runtime (null — server manages runtime host)
  runtimeHost: RuntimeHostLike | null;
  sdkClient?: NeoxClient | null;

  // UI
  uiController: InkUIAdapter | null;
  colors: typeof colors;

  // Session
  sessionEnabled: boolean;
  sessionManager: DefaultSessionManager;
  sessionSync: SessionSyncManager | null;
  currentSession?: Session;

  // State
  compatProfile: CompatProfile | null;
  autoCompactionInProgress: boolean;
  isRunning: boolean;
  workspacePath?: string;

  // Helpers
  logInfo: (message: string, details?: string) => void;
  activateSession: (session: Session, options?: { loadHistory?: boolean }) => Promise<number>;
  normalizeCheckpoints: (raw: unknown[]) => Array<{ id: string; name?: string; timestamp: number }>;
  withRuntimeEvents?: <T>(action: () => Promise<T>) => Promise<T>;

  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;

  // Interactive prompts
  promptSelect: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
  promptText?: (question: string, options?: { allowEmpty?: boolean; defaultValue?: string }) => Promise<string | null>;
}

/**
 * Normalize checkpoints array
 */
export function normalizeCheckpoints(raw: unknown[]): Array<{ id: string; name?: string; timestamp: number }> {
  const results: Array<{ id: string; name?: string; timestamp: number }> = [];
  for (const cp of raw) {
    const obj = (typeof cp === 'object' && cp !== null ? cp : {}) as Record<string, unknown>;
    const data = (typeof obj.data === 'object' && obj.data !== null ? obj.data : {}) as Record<string, unknown>;
    const id = obj.id ?? data.id;
    if (typeof id !== 'string') continue;
    const name = obj.name ?? obj.label ?? data.name;
    const timestamp = typeof obj.timestamp === 'number' ? obj.timestamp : typeof data.timestamp === 'number' ? data.timestamp : Date.now();
    results.push({ id, name: typeof name === 'string' ? name : undefined, timestamp });
  }
  return results;
}
