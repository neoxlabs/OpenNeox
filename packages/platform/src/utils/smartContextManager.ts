/**
 * SmartContextManager - 智能上下文管理器
 *
 * 基于消息优先级的分层保留策略，支持 LLM 驱动的历史压缩
 * 参考 Claude Code、Cursor、Droid 的最佳实践
 *
 * @see PROMPT_OPTIMIZATION_STRATEGY.md Phase 3
 */

import type { Message, LLMProvider } from '@neoxlabs/kernel/types/index.js';
import { estimateTokensFromMessages, estimateTokensForMessage } from '@neoxlabs/kernel/compat/memoryPressure.js';
import { getTextFromContent } from '@neoxlabs/kernel/utils/messageUtils.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 消息优先级枚举
 * 数值越小，优先级越高
 */
export enum MessagePriority {
  CRITICAL = 0,    // 必须保留（系统消息、最近消息）
  HIGH = 1,        // 高优先级（工具调用、错误信息）
  MEDIUM = 2,      // 中优先级（用户消息、助手回复）
  LOW = 3,         // 低优先级（成功的工具结果）
  COMPRESSIBLE = 4, // 可压缩（旧的工具结果）
}

/**
 * 带优先级标签的消息
 */
export interface PrioritizedMessage {
  message: Message;
  priority: MessagePriority;
  tokens: number;
  index: number;           // 原始位置
  timestamp?: number;
  reason: string;         // 优先级判断原因
}

/**
 * 上下文裁剪选项
 */
export interface SmartContextOptions {
  /** 当前迭代次数 */
  iteration?: number;
  /** LLM Provider（用于智能压缩） */
  llmProvider?: LLMProvider;
  /** 模型名称 */
  model?: string;
  /** 最小保留消息数（不包括系统消息） */
  minHistoryMessages?: number;
  /** 是否启用 LLM 压缩 */
  enableLLMCompression?: boolean;
  /** 触发 LLM 压缩的最小消息数 */
  minMessagesForCompression?: number;
  /** 调试模式 */
  debug?: boolean;
}

/**
 * 上下文裁剪结果
 */
export interface SmartContextResult {
  messages: Message[];
  originalCount: number;  // 原始消息数量
  droppedCount: number;
  compressedCount: number;
  priorityStats: Record<MessagePriority, number>;
  originalTokens: number;  // 原始 token 数量
  estimatedTokens: number;
  compressionSummary?: string;
  debugInfo?: {
    originalTokens: number;
    savedTokens: number;
    decisions: string[];
  };
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_MIN_HISTORY = 15;
const DEFAULT_MIN_MESSAGES_FOR_COMPRESSION = 5;

// 错误关键词（用于识别错误消息）
const ERROR_PATTERNS = [
  /error/i,
  /错误/,
  /failed/i,
  /失败/,
  /exception/i,
  /异常/,
  /❌/,
  /warning/i,
  /警告/,
];

// LLM 压缩 Prompt
const COMPRESSION_SYSTEM_PROMPT = `You are a conversation summarizer. Create a concise summary preserving:
1. Key decisions and their rationale
2. Important file paths and code changes
3. Unresolved issues or next steps
4. Technical details that affect future actions

Output only the summary in the same language as the input.`;

const COMPRESSION_SYSTEM_PROMPT_ZH = `你是一个对话摘要助手。创建简洁的摘要，保留：
1. 关键决策及其理由
2. 重要的文件路径和代码变更
3. 未解决的问题或后续步骤
4. 影响后续操作的技术细节

只输出摘要，使用与输入相同的语言。`;

// ============================================================================
// SmartContextManager 类
// ============================================================================

export class SmartContextManager {
  private debug: boolean;

  constructor(options?: { debug?: boolean }) {
    this.debug = options?.debug ?? (process.env.CLI_DEBUG === '1');
  }

  /**
   * 智能裁剪消息历史
   * 基于优先级 + 分层保留 + 可选 LLM 压缩
   */
  async trimSmart(
    messages: Message[],
    tokenBudget: number,
    options: SmartContextOptions = {}
  ): Promise<SmartContextResult> {
    const decisions: string[] = [];
    const originalTokens = estimateTokensFromMessages(messages);

    if (this.debug) {
      decisions.push(`[SmartContext] Original: ${messages.length} messages, ~${originalTokens} tokens`);
      decisions.push(`[SmartContext] Budget: ${tokenBudget} tokens`);
    }

    // 如果已经在预算内，直接返回
    if (originalTokens <= tokenBudget) {
      if (this.debug) {
        decisions.push('[SmartContext] Within budget, no trimming needed');
      }
      return {
        messages,
        originalCount: messages.length,
        droppedCount: 0,
        compressedCount: 0,
        priorityStats: this.countPriorities(messages, options),
        originalTokens,
        estimatedTokens: originalTokens,
        debugInfo: this.debug ? { originalTokens, savedTokens: 0, decisions } : undefined,
      };
    }

    // Step 1: 给消息打优先级标签
    const prioritized = this.prioritizeMessages(messages, options);

    if (this.debug) {
      const stats = this.countPrioritiesFromPrioritized(prioritized);
      decisions.push(`[SmartContext] Priority distribution: CRITICAL=${stats[MessagePriority.CRITICAL]}, HIGH=${stats[MessagePriority.HIGH]}, MEDIUM=${stats[MessagePriority.MEDIUM]}, LOW=${stats[MessagePriority.LOW]}`);
    }

    // Step 2: 分层保留
    const kept: PrioritizedMessage[] = [];
    let usedTokens = 0;

    // 阶段 1: 保留所有 CRITICAL 消息（系统消息、最近消息）
    for (const msg of prioritized) {
      if (msg.priority === MessagePriority.CRITICAL) {
        kept.push(msg);
        usedTokens += msg.tokens;
      }
    }

    if (this.debug) {
      decisions.push(`[SmartContext] After CRITICAL: ${kept.length} messages, ${usedTokens} tokens`);
    }

    // 阶段 2: 尽可能保留 HIGH 优先级消息
    for (const msg of prioritized) {
      if (msg.priority === MessagePriority.HIGH && !kept.includes(msg)) {
        if (usedTokens + msg.tokens <= tokenBudget) {
          kept.push(msg);
          usedTokens += msg.tokens;
        }
      }
    }

    if (this.debug) {
      decisions.push(`[SmartContext] After HIGH: ${kept.length} messages, ${usedTokens} tokens`);
    }

    // 阶段 3: 保留 MEDIUM 消息（用户和助手消息）
    const remaining = tokenBudget - usedTokens;
    const mediumMsgs = prioritized.filter(m => m.priority === MessagePriority.MEDIUM && !kept.includes(m));
    const lowMsgs = prioritized.filter(m => m.priority === MessagePriority.LOW && !kept.includes(m));
    const mediumTokens = mediumMsgs.reduce((sum, m) => sum + m.tokens, 0);

    if (mediumTokens <= remaining) {
      // 全部保留
      kept.push(...mediumMsgs);
      usedTokens += mediumTokens;
      if (this.debug) {
        decisions.push(`[SmartContext] All MEDIUM messages fit: ${mediumMsgs.length} messages`);
      }
    } else {
      const enableCompression = options.enableLLMCompression !== false;
      const minForCompression = options.minMessagesForCompression ?? DEFAULT_MIN_MESSAGES_FOR_COMPRESSION;

      if (enableCompression && options.llmProvider) {
        const messagesToCompress = [...mediumMsgs, ...lowMsgs];

        if (messagesToCompress.length >= minForCompression) {
          if (this.debug) {
            decisions.push(`[SmartContext] Attempting LLM compression for ${messagesToCompress.length} messages (MEDIUM+LOW)`);
          }

          const compressed = await this.compressWithLLM(
            messagesToCompress.map(m => m.message),
            options.llmProvider,
            options.model
          );

          if (compressed) {
            const compressedTokens = estimateTokensForMessage({ role: 'user', content: compressed });
            if (usedTokens + compressedTokens <= tokenBudget) {
              kept.push({
                message: { role: 'user', content: `[压缩的历史记录]\n${compressed}`, name: 'CompressedHistory' },
                priority: MessagePriority.MEDIUM,
                tokens: compressedTokens,
                index: -1,
                reason: 'LLM compressed history',
              });
              usedTokens += compressedTokens;

              const originalCompressedTokens = messagesToCompress.reduce((sum, m) => sum + m.tokens, 0);
              if (this.debug) {
                decisions.push(`[SmartContext] LLM compression saved ~${originalCompressedTokens - compressedTokens} tokens`);
              }

              // 返回压缩结果
              return this.buildResult(kept, messages.length, messagesToCompress.length, originalTokens, decisions, compressed);
            }
          } else if (this.debug) {
            decisions.push(`[SmartContext] LLM compression failed, falling back to selective retention`);
          }
        }
      }

      const sortedMedium = [...mediumMsgs].sort((a, b) => b.index - a.index);
      for (const msg of sortedMedium) {
        if (usedTokens + msg.tokens <= tokenBudget) {
          kept.push(msg);
          usedTokens += msg.tokens;
        }
      }

      if (this.debug) {
        const keptMedium = kept.filter(m => m.priority === MessagePriority.MEDIUM).length;
        decisions.push(`[SmartContext] Kept ${keptMedium} of ${mediumMsgs.length} MEDIUM messages (selective retention)`);
      }
    }

    // 阶段 4: 如果还有空间，保留部分 LOW 消息（如果没被 LLM 压缩）
    const remainingLowMsgs = lowMsgs.filter(m => !kept.includes(m));
    for (const msg of remainingLowMsgs) {
      if (usedTokens + msg.tokens <= tokenBudget) {
        kept.push(msg);
        usedTokens += msg.tokens;
      }
    }

    return this.buildResult(kept, messages.length, 0, originalTokens, decisions);
  }


  /**
   * 给消息分配优先级
   */
  private prioritizeMessages(
    messages: Message[],
    options: SmartContextOptions
  ): PrioritizedMessage[] {
    const minHistory = options.minHistoryMessages ?? DEFAULT_MIN_HISTORY;
    const result: PrioritizedMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const tokens = estimateTokensForMessage(msg);
      const messagesFromEnd = messages.length - i;

      let priority: MessagePriority;
      let reason: string;

      // 规则 1: System 消息始终 CRITICAL
      if (msg.role === 'system') {
        priority = MessagePriority.CRITICAL;
        reason = 'system message';
      }
      // 规则 2: 最近 N 条消息 CRITICAL（保证最小历史）
      else if (messagesFromEnd <= minHistory) {
        priority = MessagePriority.CRITICAL;
        reason = `recent message (${messagesFromEnd} from end)`;
      }
      // 规则 3: 包含错误的消息 HIGH
      else if (this.containsError(msg)) {
        priority = MessagePriority.HIGH;
        reason = 'contains error';
      }
      // 规则 4: 工具调用消息 HIGH
      else if (msg.tool_calls && msg.tool_calls.length > 0) {
        priority = MessagePriority.HIGH;
        reason = 'tool calls';
      }
      // 规则 5: 用户消息 MEDIUM
      else if (msg.role === 'user') {
        priority = MessagePriority.MEDIUM;
        reason = 'user message';
      }
      // 规则 6: 助手消息（无工具调用）MEDIUM
      else if (msg.role === 'assistant') {
        priority = MessagePriority.MEDIUM;
        reason = 'assistant message';
      }
      // 规则 7: 工具结果消息 - 必须与工具调用配对，否则模型会重复调用
      else if (msg.role === 'tool') {
        // 工具结果必须保留，否则模型会认为工具没执行完而重复调用
        priority = MessagePriority.HIGH;
        reason = this.containsError(msg) ? 'error tool result' : 'tool result (paired with tool_call)';
      }
      // 默认 MEDIUM
      else {
        priority = MessagePriority.MEDIUM;
        reason = 'default';
      }

      // 特殊调整：高迭代次数时，提升错误相关消息优先级
      if (options.iteration && options.iteration > 10) {
        if (priority === MessagePriority.MEDIUM && this.containsError(msg)) {
          priority = MessagePriority.HIGH;
          reason += ' (elevated due to high iteration)';
        }
      }

      result.push({
        message: msg,
        priority,
        tokens,
        index: i,
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
   * 使用 LLM 压缩消息历史
   */
  private async compressWithLLM(
    messages: Message[],
    llmProvider: LLMProvider,
    model?: string
  ): Promise<string | null> {
    try {
      // 检测语言
      const isZh = this.detectChinese(messages);
      const systemPrompt = isZh ? COMPRESSION_SYSTEM_PROMPT_ZH : COMPRESSION_SYSTEM_PROMPT;

      // 构建压缩请求
      const conversationText = messages.map(msg => {
        const role = msg.role === 'assistant' ? 'Assistant' :
                     msg.role === 'user' ? 'User' :
                     msg.role === 'tool' ? 'Tool' : msg.role;
        const content = getTextFromContent(msg.content);
        // 截断过长内容
        const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
        return `[${role}] ${truncated}`;
      }).join('\n\n');

      const userPrompt = isZh
        ? `请总结以下对话历史：\n\n${conversationText}`
        : `Please summarize the following conversation:\n\n${conversationText}`;

      const response = await llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          model,
          temperature: 0.3,
          // Note: max_tokens is handled by the provider internally
        }
      );

      const summary = getTextFromContent(response.choices[0]?.message?.content);
      return summary?.trim() || null;
    } catch (error: any) {
      cliLogger.error('SmartContext', `LLM compression failed: ${error.message}`);
      return null;
    }
  }

  /**
   * 检测消息是否包含中文
   */
  private detectChinese(messages: Message[]): boolean {
    for (const msg of messages) {
      const content = getTextFromContent(msg.content);
      if (/[\u4e00-\u9fa5]/.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 统计优先级分布
   */
  private countPriorities(
    messages: Message[],
    options: SmartContextOptions
  ): Record<MessagePriority, number> {
    const prioritized = this.prioritizeMessages(messages, options);
    return this.countPrioritiesFromPrioritized(prioritized);
  }

  private countPrioritiesFromPrioritized(
    prioritized: PrioritizedMessage[]
  ): Record<MessagePriority, number> {
    const stats: Record<MessagePriority, number> = {
      [MessagePriority.CRITICAL]: 0,
      [MessagePriority.HIGH]: 0,
      [MessagePriority.MEDIUM]: 0,
      [MessagePriority.LOW]: 0,
      [MessagePriority.COMPRESSIBLE]: 0,
    };
    for (const msg of prioritized) {
      stats[msg.priority]++;
    }
    return stats;
  }

  /**
   * 构建结果
   */
  private buildResult(
    kept: PrioritizedMessage[],
    originalCount: number,
    compressedCount: number,
    originalTokens: number,
    decisions: string[],
    compressionSummary?: string
  ): SmartContextResult {
    // 按原始顺序排序
    const sorted = [...kept].sort((a, b) => a.index - b.index);
    const messages = sorted.map(m => m.message);
    const estimatedTokens = estimateTokensFromMessages(messages);

    return {
      messages,
      originalCount,
      droppedCount: originalCount - kept.length,
      compressedCount,
      priorityStats: this.countPrioritiesFromPrioritized(kept),
      originalTokens,
      estimatedTokens,
      compressionSummary,
      debugInfo: this.debug ? {
        originalTokens,
        savedTokens: originalTokens - estimatedTokens,
        decisions,
      } : undefined,
    };
  }
}

// 默认实例
export const smartContextManager = new SmartContextManager();
