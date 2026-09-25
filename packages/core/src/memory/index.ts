/**
 * Memory 模块导出
 *
 * 提供会话持久化和管理功能
 */

// 类型导出
export type {
  Session,
  SessionItem,
  SessionMeta,
  SessionInfo,
  SessionManager,
  MessageItem,
  ToolCallItem,
  ToolResultItem,
  MetaItem,
  CompactedItem,
  CheckpointItem,
  FileSnapshotItem,
  FileEditSnapshotItem,
  TimestampedSessionItem
} from '@neoxlabs/kernel/types/session.js';

// 工具函数
export {
  generateSessionId,
  messageToSessionItem,
  sessionItemToMessage
} from '@neoxlabs/kernel/types/session.js';

// Session 实现
export { JSONLSession } from './jsonl-session.js';
export type { JSONLSessionOptions } from './jsonl-session.js';

export { SQLiteSession } from './sqlite-session.js';

export { MemorySession } from './memory-session.js';
export type { MemorySessionOptions } from './memory-session.js';

// ShortTermMemory (保留兼容)
export { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';

// SessionManager
export { DefaultSessionManager, getDefaultSessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';

// SessionSyncManager
export { SessionSyncManager } from './session-sync.js';
export type { SessionSyncOptions, UndoResult, RollbackResult } from './session-sync.js';

// ProjectMemoryV2 (层级化项目记忆)
export {
  loadProjectMemoryV2,
  matchRules,
  getModuleContext,
  formatProjectMemoryForPrompt,
} from './projectMemoryV2.js';
export type { ProjectMemoryV2Result, RuleEntry } from './projectMemoryV2.js';

// ModuleContext (模块上下文生成器)
export { runInit } from './moduleContext.js';
export type { InitScope, InitOptions, InitResult } from './moduleContext.js';

// DynamicContextInjector (动态上下文注入)
export { DynamicContextInjector } from './dynamicInjector.js';
export type { DynamicInjectorConfig } from './dynamicInjector.js';

// AutoMemoryEngine (自动记忆提取)
export { AutoMemoryEngine } from './autoMemoryEngine.js';
export type { AutoMemoryConfig } from './autoMemoryEngine.js';

// ============================================================================
// 便捷函数
// ============================================================================

import { JSONLSession } from './jsonl-session.js';
import { SQLiteSession } from './sqlite-session.js';
import { MemorySession } from './memory-session.js';
import { DefaultSessionManager } from './session-manager.js';

/**
 * 创建 JSONL 会话
 */
export function createJSONLSession(sessionId?: string, options?: {
  directory?: string;
  agentName?: string;
  model?: string;
}): JSONLSession {
  if (sessionId) {
    return new JSONLSession({ sessionId, ...options });
  }
  return JSONLSession.create(options);
}

/**
 * 创建内存会话
 */
export function createMemorySession(sessionId?: string, options?: {
  agentName?: string;
  model?: string;
  maxItems?: number;
}): MemorySession {
  if (sessionId) {
    return new MemorySession({ sessionId, ...options });
  }
  return MemorySession.create(options);
}

export async function getOrCreateSession(sessionId?: string): Promise<SQLiteSession> {
  const manager = new DefaultSessionManager();
  return await manager.getOrCreateSession(sessionId) as SQLiteSession;
}

/**
 * 继续最近的会话或创建新会话
 */
export async function continueSession(): Promise<SQLiteSession> {
  const manager = new DefaultSessionManager();
  return await manager.continueOrCreate() as SQLiteSession;
}

/**
 * 列出所有会话
 */
export async function listSessions() {
  const manager = new DefaultSessionManager();
  return manager.listSessions();
}
