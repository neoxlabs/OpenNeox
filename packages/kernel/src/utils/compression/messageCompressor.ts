/**
 * Message 压缩器 - 智能压缩对话消息
 * Message Compressor - Smart compression for conversation messages
 */

import type { Message, LLMProvider } from '../../types/index.js';
import { getTextFromContent } from '../messageUtils.js';
import { estimateTokensForMessage, estimateTokensFromMessages } from '../../compat/memoryPressure.js';
import { cliLogger } from '../../platform/cliLogger.js';
import { ToolCompressor } from './toolCompressor.js';
import {
  MessageType,
  type CompressionContext,
  type MessageCompressionResult,
  type BatchCompressionResult,
  type IMessageCompressor,
} from './types.js';

// ============================================================================
// 消息优先级
// ============================================================================

export enum MessagePriority {
  CRITICAL = 0,    // 必须保留（系统消息、最近消息）
  HIGH = 1,        // 高优先级（错误、重要工具调用）
  MEDIUM = 2,      // 中优先级（用户消息、助手回复）
  LOW = 3,         // 低优先级（成功的工具结果）
  COMPRESSIBLE = 4, // 可压缩（旧的、大的内容）
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_MIN_RECENT_MESSAGES = 15;  // 最近 N 条消息必须保留
const ERROR_PATTERNS = [
  /error/i, /错误/, /failed/i, /失败/,
  /exception/i, /异常/, /❌/, /warning/i, /警告/,
];

/** LLM 压缩 Prompt */
const CONVERSATION_COMPRESSION_PROMPT = {
  system: `你是一个对话历史压缩助手。请将对话压缩为简洁摘要，保留：
1. 用户的核心需求和目标
2. 关键决策和其理由
3. 重要的代码变更（文件路径、函数名）
4. 当前任务的状态
5. 未解决的问题

格式要求：
- 使用 markdown 格式
- 分点列出关键信息
- 保留技术细节（文件名、函数名、错误信息）
- 总长度控制在 800 字以内
- 使用与原对话相同的语言`,

  systemZh: `你是一个对话历史压缩助手。请将对话压缩为简洁摘要，保留：
1. 用户的核心需求和目标
2. 关键决策和其理由
3. 重要的代码变更（文件路径、函数名）
4. 当前任务的状态
5. 未解决的问题

格式要求：
- 使用 markdown 格式
- 分点列出关键信息
- 保留技术细节（文件名、函数名、错误信息）
- 总长度控制在 800 字以内`,

  user: (messages: string) =>
    `请压缩以下对话历史:\n\n${messages}`,
};

// ============================================================================
// 带优先级的消息
// ============================================================================

interface PrioritizedMessage {
  message: Message;
  priority: MessagePriority;
  tokens: number;
  index: number;
  type: MessageType;
  reason: string;
}

// ============================================================================
// MessageCompressor 类
// ============================================================================

export class MessageCompressor implements IMessageCompressor {
  private debug: boolean;
  private toolCompressor: ToolCompressor;
  private minRecentMessages: number;

  constructor(options?: {
    debug?: boolean;
    toolCompressor?: ToolCompressor;
    minRecentMessages?: number;
  }) {
    this.debug = options?.debug ?? (process.env.CLI_DEBUG === '1');
    this.toolCompressor = options?.toolCompressor ?? new ToolCompressor({ debug: this.debug });
    this.minRecentMessages = options?.minRecentMessages ?? DEFAULT_MIN_RECENT_MESSAGES;
  }

  /**
   * 压缩单条消息
   */
  async compressMessage(
    message: Message,
    context: CompressionContext
  ): Promise<MessageCompressionResult> {
    const originalTokens = estimateTokensForMessage(message);
    const messageType = this.getMessageType(message);

    // 系统消息不压缩
    if (messageType === MessageType.SYSTEM) {
      return {
        message,
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1,
        usedLLM: false,
        strategy: 'preserve_system',
      };
    }

    // Tool 结果消息 - 使用 ToolCompressor
    if (messageType === MessageType.TOOL_RESULT && message.role === 'tool') {
      const toolName = message.name || 'unknown';
      const content = getTextFromContent(message.content);

      const result = await this.toolCompressor.compress(toolName, content, context);

      const compressedMessage: Message = {
        ...message,
        content: result.content,
      };
      const compressedTokens = estimateTokensForMessage(compressedMessage);

      return {
        message: compressedMessage,
        originalTokens,
        compressedTokens,
        compressionRatio: compressedTokens / originalTokens,
        usedLLM: result.usedLLM,
        strategy: `tool_${result.strategy}`,
      };
    }

    // 其他消息 - 根据长度决定是否压缩
    const content = getTextFromContent(message.content);
    if (content.length > 3000 && context.llmProvider && context.enableLLMCompression !== false) {
      // 长消息使用 LLM 压缩
      const compressed = await this.compressLongContent(content, context);
      if (compressed) {
        const compressedMessage: Message = {
          ...message,
          content: compressed,
        };
        const compressedTokens = estimateTokensForMessage(compressedMessage);

        return {
          message: compressedMessage,
          originalTokens,
          compressedTokens,
          compressionRatio: compressedTokens / originalTokens,
          usedLLM: true,
          strategy: 'llm_content_compression',
        };
      }
    }

    // 不需要压缩
    return {
      message,
      originalTokens,
      compressedTokens: originalTokens,
      compressionRatio: 1,
      usedLLM: false,
      strategy: 'preserve',
    };
  }

  /**
   * 压缩消息列表
   */
  async compressMessages(
    messages: Message[],
    context: CompressionContext
  ): Promise<BatchCompressionResult> {
    const debugInfo: string[] = [];
    const originalTokens = estimateTokensFromMessages(messages);
    const tokenBudget = context.tokenBudget || originalTokens;

    if (this.debug) {
      debugInfo.push(`[MessageCompressor] 开始压缩: ${messages.length} 条消息, ${originalTokens} tokens`);
      debugInfo.push(`[MessageCompressor] Token 预算: ${tokenBudget}`);
    }

    // 如果在预算内，只压缩单条大消息
    if (originalTokens <= tokenBudget) {
      return this.compressLargeMessages(messages, context, debugInfo);
    }

    // 超预算 - 需要分层压缩
    return this.compressWithPriority(messages, tokenBudget, context, debugInfo);
  }

  /**
   * 只压缩大消息（不删除任何消息）
   */
  private async compressLargeMessages(
    messages: Message[],
    context: CompressionContext,
    debugInfo: string[]
  ): Promise<BatchCompressionResult> {
    const originalTokens = estimateTokensFromMessages(messages);
    const compressedMessages: Message[] = [];
    let llmCompressedCount = 0;
    let truncatedCount = 0;

    for (const msg of messages) {
      const tokens = estimateTokensForMessage(msg);

      // 只压缩大消息（超过 2000 tokens）
      if (tokens > 2000 && msg.role !== 'system') {
        const result = await this.compressMessage(msg, context);
        compressedMessages.push(result.message);

        if (result.usedLLM) {
          llmCompressedCount++;
        } else if (result.compressionRatio < 1) {
          truncatedCount++;
        }
      } else {
        compressedMessages.push(msg);
      }
    }

    const compressedTokens = estimateTokensFromMessages(compressedMessages);

    if (this.debug) {
      debugInfo.push(`[MessageCompressor] 大消息压缩完成: LLM=${llmCompressedCount}, 截断=${truncatedCount}`);
    }

    return {
      messages: compressedMessages,
      originalCount: messages.length,
      compressedCount: compressedMessages.length,
      originalTokens,
      compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      stats: {
        droppedMessages: 0,
        llmCompressedMessages: llmCompressedCount,
        truncatedMessages: truncatedCount,
        preservedMessages: messages.length - llmCompressedCount - truncatedCount,
      },
      debugInfo: this.debug ? debugInfo : undefined,
    };
  }

  /**
   * 基于优先级的分层压缩
   */
  private async compressWithPriority(
    messages: Message[],
    tokenBudget: number,
    context: CompressionContext,
    debugInfo: string[]
  ): Promise<BatchCompressionResult> {
    const originalTokens = estimateTokensFromMessages(messages);

    // Step 1: 给消息打优先级标签
    const prioritized = this.prioritizeMessages(messages);

    if (this.debug) {
      const stats = this.countPriorities(prioritized);
      debugInfo.push(`[MessageCompressor] 优先级分布: CRITICAL=${stats.critical}, HIGH=${stats.high}, MEDIUM=${stats.medium}, LOW=${stats.low}`);
    }

    // Step 2: 分层保留
    const kept: PrioritizedMessage[] = [];
    let usedTokens = 0;

    // 阶段 1: 保留所有 CRITICAL 消息
    for (const msg of prioritized) {
      if (msg.priority === MessagePriority.CRITICAL) {
        kept.push(msg);
        usedTokens += msg.tokens;
      }
    }

    if (this.debug) {
      debugInfo.push(`[MessageCompressor] CRITICAL 保留后: ${kept.length} 条, ${usedTokens} tokens`);
    }

    // 阶段 2: 压缩并保留 HIGH 消息
    const highMessages = prioritized.filter(m => m.priority === MessagePriority.HIGH && !kept.includes(m));
    for (const msg of highMessages) {
      // 尝试压缩
      const result = await this.compressMessage(msg.message, context);
      const compressedTokens = result.compressedTokens;

      if (usedTokens + compressedTokens <= tokenBudget) {
        kept.push({
          ...msg,
          message: result.message,
          tokens: compressedTokens,
        });
        usedTokens += compressedTokens;
      }
    }

    if (this.debug) {
      debugInfo.push(`[MessageCompressor] HIGH 保留后: ${kept.length} 条, ${usedTokens} tokens`);
    }

    // 阶段 3: 处理 MEDIUM + LOW 消息
    const remainingBudget = tokenBudget - usedTokens;
    const mediumLowMessages = prioritized.filter(
      m => (m.priority === MessagePriority.MEDIUM || m.priority === MessagePriority.LOW) && !kept.includes(m)
    );

    const mediumLowTokens = mediumLowMessages.reduce((sum, m) => sum + m.tokens, 0);

    if (mediumLowTokens <= remainingBudget) {
      // 全部放得下，先压缩再保留
      for (const msg of mediumLowMessages) {
        const result = await this.compressMessage(msg.message, context);
        kept.push({
          ...msg,
          message: result.message,
          tokens: result.compressedTokens,
        });
        usedTokens += result.compressedTokens;
      }
    } else {
      // 放不下 - 尝试 LLM 批量压缩
      if (context.llmProvider && context.enableLLMCompression !== false && mediumLowMessages.length >= 5) {
        const compressed = await this.compressBatchWithLLM(
          mediumLowMessages.map(m => m.message),
          context
        );

        if (compressed) {
          const summaryMessage: Message = {
            role: 'user',
            content: `[压缩的历史记录]\n${compressed}`,
            name: 'CompressedHistory',
          };
          const summaryTokens = estimateTokensForMessage(summaryMessage);

          if (usedTokens + summaryTokens <= tokenBudget) {
            kept.push({
              message: summaryMessage,
              priority: MessagePriority.MEDIUM,
              tokens: summaryTokens,
              index: -1,
              type: MessageType.USER,
              reason: 'LLM batch compressed',
            });
            usedTokens += summaryTokens;

            if (this.debug) {
              debugInfo.push(`[MessageCompressor] LLM 批量压缩: ${mediumLowMessages.length} 条 → 1 条摘要`);
            }
          }
        }
      }

      // 回退：保留最近的消息
      if (!kept.find(m => m.reason === 'LLM batch compressed')) {
        const sortedByRecency = [...mediumLowMessages].sort((a, b) => b.index - a.index);
        for (const msg of sortedByRecency) {
          const result = await this.compressMessage(msg.message, context);
          if (usedTokens + result.compressedTokens <= tokenBudget) {
            kept.push({
              ...msg,
              message: result.message,
              tokens: result.compressedTokens,
            });
            usedTokens += result.compressedTokens;
          }
        }
      }
    }

    // 按原始顺序排序
    const sortedKept = [...kept].sort((a, b) => {
      if (a.index === -1) return 0; // 压缩摘要放在原位置
      if (b.index === -1) return 0;
      return a.index - b.index;
    });

    const compressedMessages = sortedKept.map(m => m.message);
    const compressedTokens = estimateTokensFromMessages(compressedMessages);

    const droppedCount = messages.length - kept.length;
    const llmCompressedCount = kept.filter(m => m.reason.includes('LLM')).length;

    if (this.debug) {
      debugInfo.push(`[MessageCompressor] 最终: ${compressedMessages.length} 条, ${compressedTokens} tokens`);
      debugInfo.push(`[MessageCompressor] 节省: ${originalTokens - compressedTokens} tokens`);
    }

    return {
      messages: compressedMessages,
      originalCount: messages.length,
      compressedCount: compressedMessages.length,
      originalTokens,
      compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      stats: {
        droppedMessages: droppedCount,
        llmCompressedMessages: llmCompressedCount,
        truncatedMessages: 0,
        preservedMessages: kept.length - llmCompressedCount,
      },
      debugInfo: this.debug ? debugInfo : undefined,
    };
  }

  /**
   * 获取消息类型
   */
  private getMessageType(message: Message): MessageType {
    if (message.role === 'system') return MessageType.SYSTEM;
    if (message.role === 'user') return MessageType.USER;
    if (message.role === 'tool') return MessageType.TOOL_RESULT;
    if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        return MessageType.TOOL_CALL;
      }
      return MessageType.ASSISTANT;
    }
    return MessageType.USER;
  }

  /**
   * 给消息分配优先级
   */
  private prioritizeMessages(messages: Message[]): PrioritizedMessage[] {
    const result: PrioritizedMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = estimateTokensForMessage(msg);
      const type = this.getMessageType(msg);
      const messagesFromEnd = messages.length - i;

      let priority: MessagePriority;
      let reason: string;

      // 规则 1: System 消息始终 CRITICAL
      if (type === MessageType.SYSTEM) {
        priority = MessagePriority.CRITICAL;
        reason = 'system message';
      }
      // 规则 2: 最近 N 条消息 CRITICAL
      else if (messagesFromEnd <= this.minRecentMessages) {
        priority = MessagePriority.CRITICAL;
        reason = `recent message (${messagesFromEnd} from end)`;
      }
      // 规则 3: 包含错误的消息 HIGH
      else if (this.containsError(msg)) {
        priority = MessagePriority.HIGH;
        reason = 'contains error';
      }
      // 规则 4: 工具调用消息 HIGH
      else if (type === MessageType.TOOL_CALL) {
        priority = MessagePriority.HIGH;
        reason = 'tool calls';
      }
      // 规则 5: 工具结果消息 HIGH（必须与工具调用配对）
      else if (type === MessageType.TOOL_RESULT) {
        priority = MessagePriority.HIGH;
        reason = 'tool result';
      }
      // 规则 6: 用户消息 MEDIUM
      else if (type === MessageType.USER) {
        priority = MessagePriority.MEDIUM;
        reason = 'user message';
      }
      // 规则 7: 助手消息 MEDIUM
      else if (type === MessageType.ASSISTANT) {
        priority = MessagePriority.MEDIUM;
        reason = 'assistant message';
      }
      // 默认 LOW
      else {
        priority = MessagePriority.LOW;
        reason = 'default';
      }

      result.push({
        message: msg,
        priority,
        tokens,
        index: i,
        type,
        reason,
      });
    }

    return result;
  }

  /**
   * 检查消息是否包含错误
   */
  private containsError(msg: Message): boolean {
    const content = getTextFromContent(msg.content);
    return ERROR_PATTERNS.some(pattern => pattern.test(content));
  }

  /**
   * 统计优先级分布
   */
  private countPriorities(prioritized: PrioritizedMessage[]): {
    critical: number;
    high: number;
    medium: number;
    low: number;
  } {
    return {
      critical: prioritized.filter(m => m.priority === MessagePriority.CRITICAL).length,
      high: prioritized.filter(m => m.priority === MessagePriority.HIGH).length,
      medium: prioritized.filter(m => m.priority === MessagePriority.MEDIUM).length,
      low: prioritized.filter(m => m.priority === MessagePriority.LOW).length,
    };
  }

  /**
   * 压缩长内容
   */
  private async compressLongContent(
    content: string,
    context: CompressionContext
  ): Promise<string | null> {
    if (!context.llmProvider) return null;

    try {
      const isZh = /[\u4e00-\u9fa5]/.test(content);
      const systemPrompt = isZh
        ? CONVERSATION_COMPRESSION_PROMPT.systemZh
        : CONVERSATION_COMPRESSION_PROMPT.system;

      // 截断过长内容
      const maxInput = 6000;
      const truncated = content.length > maxInput
        ? content.slice(0, maxInput) + '\n\n...[内容过长，已截断]...'
        : content;

      const response = await context.llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请压缩以下内容:\n\n${truncated}` },
        ],
        {
          model: context.model,
          temperature: 0.2,
        }
      );

      return getTextFromContent(response.choices[0]?.message?.content) || null;
    } catch (error: any) {
      cliLogger.warn('MessageCompressor', `LLM compression failed: ${error.message}`);
      return null;
    }
  }

  /**
   * 批量 LLM 压缩
   */
  private async compressBatchWithLLM(
    messages: Message[],
    context: CompressionContext
  ): Promise<string | null> {
    if (!context.llmProvider) return null;

    try {
      // 构建对话文本
      const conversationText = messages.map(msg => {
        const role = msg.role === 'assistant' ? 'Assistant' :
                     msg.role === 'user' ? 'User' :
                     msg.role === 'tool' ? 'Tool' : msg.role;
        const content = getTextFromContent(msg.content);
        // 截断过长内容
        const truncated = content.length > 800 ? content.slice(0, 800) + '...' : content;
        return `[${role}] ${truncated}`;
      }).join('\n\n');

      const isZh = /[\u4e00-\u9fa5]/.test(conversationText);
      const systemPrompt = isZh
        ? CONVERSATION_COMPRESSION_PROMPT.systemZh
        : CONVERSATION_COMPRESSION_PROMPT.system;

      const response = await context.llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: CONVERSATION_COMPRESSION_PROMPT.user(conversationText) },
        ],
        {
          model: context.model,
          temperature: 0.3,
        }
      );

      return getTextFromContent(response.choices[0]?.message?.content) || null;
    } catch (error: any) {
      cliLogger.warn('MessageCompressor', `Batch LLM compression failed: ${error.message}`);
      return null;
    }
  }
}

// 默认实例
export const messageCompressor = new MessageCompressor();
