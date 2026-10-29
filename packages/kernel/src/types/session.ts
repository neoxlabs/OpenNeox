/**
 * Session 会话类型定义
 *
 * 支持对话历史的持久化存储和恢复
 * 参考 Claude Code (JSONL) 和 OpenAI Codex (JSONL) 的设计
 */

import type { Message, ToolCall } from './index.js';

// ============================================================================
// Session Item 类型 - 会话中的各种项目
// ============================================================================

/**
 * 会话元数据
 */
export interface SessionMeta {
  /** 会话 ID */
  sessionId: string;
  /** 创建时间 */
  createdAt: string;
  /** Agent 名称 */
  agentName?: string;
  /** 模型名称 */
  model?: string;
  /** 自定义元数据 */
  metadata?: Record<string, any>;
}

/**
 * 消息项
 */
export interface MessageItem {
  type: 'message';
  data: Message;
}

/**
 * 工具调用项
 */
export interface ToolCallItem {
  type: 'tool_call';
  data: {
    id: string;
    name: string;
    arguments: string;
  };
}

/**
 * 工具结果项
 */
export interface ToolResultItem {
  type: 'tool_result';
  data: {
    callId: string;
    name: string;
    result: string;
    success: boolean;
  };
}

/**
 * 元数据项
 */
export interface MetaItem {
  type: 'meta';
  data: SessionMeta;
}

/**
 * 压缩历史项（用于上下文压缩）
 */
export interface CompactedItem {
  type: 'compacted';
  data: {
    summary: string;
    originalCount: number;
    compactedAt: string;
    method?: 'lightweight' | 'smart'; // 压缩方式
    llmTokensUsed?: number; // 智能压缩消耗的 tokens
  };
}

/**
 * 回滚点标记
 */
export interface CheckpointItem {
  type: 'checkpoint';
  data: {
    id: string;
    name?: string;
    description?: string;
    /**
     * Shadow Git HEAD for the workspace at checkpoint creation time. When present,
     * rollback can restore conversation and files to the same point; when absent,
     * rollback only trims conversation history.
     */
    fileCheckpointId?: string;
  };
}

/**
 * 文件快照项（用于文件操作回滚）
 */
export interface FileSnapshotItem {
  type: 'file_snapshot';
  data: {
    /** 文件路径（相对于工作目录） */
    filePath: string;
    /** 文件原始内容（null 表示文件不存在） */
    originalContent: string | null;
    /** 操作类型 */
    operation: 'create' | 'modify' | 'delete';
    /** 操作后的内容（用于验证） */
    newContent?: string;
  };
}

/**
 * 文件编辑快照项（精确到行/字符串的编辑）
 */
export interface FileEditSnapshotItem {
  type: 'file_edit_snapshot';
  data: {
    /** 文件路径 */
    filePath: string;
    /** 被替换的原始字符串 */
    oldString: string;
    /** 新字符串 */
    newString: string;
    /** 起始行号（0-indexed） */
    startLine: number;
    /** 原始行数 */
    oldLineCount: number;
    /** 新行数 */
    newLineCount: number;
    /** 是否替换所有匹配 */
    replaceAll: boolean;
    /** 替换次数 */
    replacementCount: number;
  };
}

/**
 * 会话项联合类型
 */
export type SessionItem =
  | MessageItem
  | ToolCallItem
  | ToolResultItem
  | MetaItem
  | CompactedItem
  | CheckpointItem
  | FileSnapshotItem
  | FileEditSnapshotItem;

/**
 * 带时间戳的会话项（存储格式）
 */
export interface TimestampedSessionItem {
  /** 项目内容 */
  item: SessionItem;
  /** 时间戳 */
  timestamp: number;
  /** 序号（用于排序） */
  seq: number;
}

// ============================================================================
// Session 接口
// ============================================================================

/**
 * Session 接口
 *
 * 核心方法：
 * - getItems: 获取历史
 * - addItems: 添加项目
 * - popItem: 撤销最近一项
 * - popToCheckpoint: 回滚到检查点
 * - clearSession: 清空会话
 */
export interface Session {
  /** 会话 ID */
  readonly sessionId: string;

  /**
   * 获取会话历史
   * @param limit 最大条数（可选，默认全部）
   * @returns 按时间正序的会话项
   */
  getItems(limit?: number): Promise<SessionItem[]>;

  /**
   * 添加会话项
   * @param items 要添加的项目
   */
  addItems(items: SessionItem[]): Promise<void>;

  /**
   * 移除并返回最近一项（撤销）
   * @returns 被移除的项，如果为空返回 null
   */
  popItem(): Promise<SessionItem | null>;

  /**
   * 批量撤销多项
   * @param count 撤销数量
   * @returns 被移除的项列表
   */
  popItems(count: number): Promise<SessionItem[]>;

  /**
   * 创建检查点
   * @param name 检查点名称（可选）
   * @param description 描述（可选）
   * @returns 检查点 ID
   */
  createCheckpoint(name?: string, description?: string, fileCheckpointId?: string): Promise<string>;

  /**
   * 回滚到检查点
   * @param checkpointId 检查点 ID
   * @returns 被移除的项数量
   */
  rollbackToCheckpoint(checkpointId: string): Promise<number>;

  /**
   * 获取所有检查点
   */
  getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>>;

  /**
   * 清空会话
   */
  clearSession(): Promise<void>;

  /**
   * 获取会话元数据
   */
  getMeta(): Promise<SessionMeta | null>;

  /**
   * 获取消息历史（便捷方法）
   */
  getMessages(): Promise<Message[]>;

  /**
   * 获取项目数量
   */
  getItemCount(): Promise<number>;

  /**
   * 获取完整时间线（包含时间戳/序号），用于重写或分析
   */
  getTimeline(): Promise<TimestampedSessionItem[]>;

  /**
   * 用新的时间线替换历史（需包含时间戳/序号）
   */
  replaceTimeline(items: TimestampedSessionItem[]): Promise<void>;
}

/**
 * Session 抽象基类
 */
export abstract class SessionABC implements Session {
  abstract readonly sessionId: string;
  abstract getItems(limit?: number): Promise<SessionItem[]>;
  abstract addItems(items: SessionItem[]): Promise<void>;
  abstract popItem(): Promise<SessionItem | null>;
  abstract popItems(count: number): Promise<SessionItem[]>;
  abstract createCheckpoint(name?: string, description?: string, fileCheckpointId?: string): Promise<string>;
  abstract rollbackToCheckpoint(checkpointId: string): Promise<number>;
  abstract getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>>;
  abstract clearSession(): Promise<void>;
  abstract getMeta(): Promise<SessionMeta | null>;
  abstract getMessages(): Promise<Message[]>;
  abstract getItemCount(): Promise<number>;
  abstract getTimeline(): Promise<TimestampedSessionItem[]>;
  abstract replaceTimeline(items: TimestampedSessionItem[]): Promise<void>;
}

// ============================================================================
// Session Manager 接口
// ============================================================================

/**
 * 会话信息
 */
export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  agentName?: string;
}

/**
 * Session Manager 接口
 */
export interface SessionManager {
  /**
   * 获取或创建会话
   */
  getSession(sessionId: string): Promise<Session>;

  /**
   * 列出所有会话
   */
  listSessions(): Promise<SessionInfo[]>;

  /**
   * 获取最近的会话
   */
  getMostRecent(): Promise<Session | null>;

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): Promise<boolean>;

  /**
   * 搜索会话（按内容）
   */
  searchSessions(query: string): Promise<SessionInfo[]>;
}

// ============================================================================
// 工具函数类型
// ============================================================================

/**
 * 从 Message 创建 SessionItem
 */
export function messageToSessionItem(message: Message): MessageItem {
  return { type: 'message', data: message };
}

/**
 * 从 SessionItem 提取 Message（如果是消息类型）
 */
export function sessionItemToMessage(item: SessionItem): Message | null {
  if (item.type === 'message') {
    return item.data;
  }
  return null;
}

/**
 * 生成会话 ID
 */
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const random = Math.random().toString(36).slice(2, 6);
  return `session_${date}_${time}_${random}`;
}
