/**
 * 统一压缩系统 - 类型定义
 * Unified Compression System - Type Definitions
 */

import type { Message, LLMProvider } from '../../types/index.js';

// ============================================================================
// 压缩策略类型
// ============================================================================

/**
 * 压缩级别
 */
export enum CompressionLevel {
  NONE = 0,       // 不压缩，完整保留
  LIGHT = 1,      // 轻度压缩：截断过长内容
  MEDIUM = 2,     // 中度压缩：提取关键信息
  AGGRESSIVE = 3, // 激进压缩：只保留核心摘要
}

/**
 * 消息类型（用于选择压缩策略）
 */
export enum MessageType {
  SYSTEM = 'system',           // 系统消息
  USER = 'user',               // 用户消息
  ASSISTANT = 'assistant',     // 助手消息
  TOOL_CALL = 'tool_call',     // 工具调用
  TOOL_RESULT = 'tool_result', // 工具结果
}

/**
 * Tool 类型（用于选择特定的压缩策略）
 */
export enum ToolType {
  // 文件操作
  FILE_READ = 'file_read',       // Read 工具
  FILE_WRITE = 'file_write',     // Write 工具
  FILE_EDIT = 'file_edit',       // Edit 工具
  FILE_SEARCH = 'file_search',   // Glob/Grep 工具

  // 命令执行
  BASH = 'bash',                 // Bash 命令

  // 网络操作
  WEB_FETCH = 'web_fetch',       // WebFetch 工具
  WEB_SEARCH = 'web_search',     // WebSearch 工具

  // 图片/多媒体
  IMAGE_ANALYSIS = 'image_analysis', // 图片分析

  // 其他
  MCP = 'mcp',                   // MCP 工具
  TASK = 'task',                 // Task 子代理
  OTHER = 'other',               // 其他工具
}

// ============================================================================
// 压缩上下文
// ============================================================================

/**
 * 压缩上下文 - 包含压缩所需的所有信息
 */
export interface CompressionContext {
  /** LLM Provider（用于智能压缩） */
  llmProvider?: LLMProvider;
  /** 模型名称 */
  model?: string;
  /** Token 预算 */
  tokenBudget?: number;
  /** 模型上下文窗口大小（用于动态计算阈值） */
  contextWindow?: number;
  /** 当前迭代次数 */
  iteration?: number;
  /** 是否启用 LLM 压缩 */
  enableLLMCompression?: boolean;
  /** 手动 /compact: 即使已在 tokenBudget 内也强制跑 LLM 摘要 */
  force?: boolean;
  /**
   * 摘要器的逐轮参数 (收敛循环用) —— 保护区松紧由调用方按轮次收紧:
   * 第 1 轮 8K 尾部保护, 第 2 轮减半, 第 3 轮清零。
   * 给了它就完全接管 force 的默认覆盖。
   */
  summarizerOverrides?: {
    protectRecentTokens?: number;
    protectRecentCount?: number;
    protectHeadCount?: number;
    force?: boolean;
  };
  /** 压缩超时（毫秒） */
  timeout?: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 调试模式 */
  debug?: boolean;
}

// ============================================================================
// 压缩结果
// ============================================================================

/**
 * 单条消息压缩结果
 */
export interface MessageCompressionResult {
  /** 压缩后的消息 */
  message: Message;
  /** 原始 token 数 */
  originalTokens: number;
  /** 压缩后 token 数 */
  compressedTokens: number;
  /** 压缩比例 */
  compressionRatio: number;
  /** 是否使用了 LLM 压缩 */
  usedLLM: boolean;
  /** 压缩策略描述 */
  strategy: string;
}

/**
 * 批量消息压缩结果
 */
export interface BatchCompressionResult {
  /** 压缩后的消息列表 */
  messages: Message[];
  /** 原始消息数量 */
  originalCount: number;
  /** 压缩后消息数量 */
  compressedCount: number;
  /** 原始 token 数 */
  originalTokens: number;
  /** 压缩后 token 数 */
  compressedTokens: number;
  /** 节省的 token 数 */
  savedTokens: number;
  /** 压缩摘要（如果有） */
  summary?: string;
  /** 详细统计 */
  stats: {
    droppedMessages: number;
    llmCompressedMessages: number;
    truncatedMessages: number;
    preservedMessages: number;
  };
  /** 调试信息 */
  debugInfo?: string[];
}

// ============================================================================
// Tool 压缩结果
// ============================================================================

/**
 * Tool 结果压缩输出
 */
export interface ToolCompressionResult {
  /** 压缩后的内容 */
  content: string;
  /** 原始长度（字符） */
  originalLength: number;
  /** 压缩后长度（字符） */
  compressedLength: number;
  /** 使用的策略 */
  strategy: ToolType;
  /** 是否使用了 LLM */
  usedLLM: boolean;
  /** 提取的元数据 */
  metadata?: {
    filePath?: string;
    command?: string;
    exitCode?: number;
    errorType?: string;
    changedLines?: number;
    urls?: string[];
  };
}

// ============================================================================
// 压缩策略接口
// ============================================================================

/**
 * Tool 压缩策略接口
 */
export interface IToolCompressor {
  /** 支持的 tool 名称列表 */
  readonly supportedTools: string[];

  /** 获取 tool 类型 */
  getToolType(toolName: string): ToolType;

  /** 压缩 tool 结果 */
  compress(
    toolName: string,
    toolResult: string,
    context: CompressionContext
  ): Promise<ToolCompressionResult>;

  /** 判断是否需要 LLM 压缩 */
  needsLLMCompression(toolName: string, toolResult: string): boolean;
}

/**
 * Message 压缩策略接口
 */
export interface IMessageCompressor {
  /** 压缩单条消息 */
  compressMessage(
    message: Message,
    context: CompressionContext
  ): Promise<MessageCompressionResult>;

  /** 压缩消息列表（可能合并多条消息） */
  compressMessages(
    messages: Message[],
    context: CompressionContext
  ): Promise<BatchCompressionResult>;
}

/**
 * 统一压缩器接口
 */
export interface IUnifiedCompressor {
  /** 压缩整个对话历史 */
  compressHistory(
    messages: Message[],
    tokenBudget: number,
    context: CompressionContext
  ): Promise<BatchCompressionResult>;

  /** 注册 tool 压缩器 */
  registerToolCompressor(compressor: IToolCompressor): void;

  /** 设置消息压缩器 */
  setMessageCompressor(compressor: IMessageCompressor): void;
}
