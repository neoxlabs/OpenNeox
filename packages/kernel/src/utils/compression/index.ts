/**
 * 统一压缩管理器 - 整合 Tool 和 Message 压缩
 * Unified Compressor - Integrates Tool and Message compression
 */

import type { Message, LLMProvider } from '../../types/index.js';
import { estimateTokensFromMessages, estimateTokensForMessage } from '../../compat/memoryPressure.js';
import { cliLogger } from '../../platform/cliLogger.js';
import { ToolCompressor } from './toolCompressor.js';
import { MessageCompressor, MessagePriority } from './messageCompressor.js';
import { smartPruneToolOutputs, type SmartPruneResult } from './smartPruner.js';
import { LLMSummarizer, COMPACTION_SUMMARY_MARKER } from './llmSummarizer.js';
import {
  type CompressionContext,
  type BatchCompressionResult,
  type IToolCompressor,
  type IMessageCompressor,
  type IUnifiedCompressor,
} from './types.js';

// ============================================================================
// 配置
// ============================================================================

export interface UnifiedCompressorConfig {
  /** 调试模式 */
  debug?: boolean;
  /** 最小保留消息数 */
  minRecentMessages?: number;
  /** 默认 Token 预算 */
  defaultTokenBudget?: number;
  /** 是否启用 LLM 压缩 */
  enableLLMCompression?: boolean;
  /** LLM 压缩超时（毫秒） */
  llmTimeout?: number;
}

const DEFAULT_CONFIG: Required<UnifiedCompressorConfig> = {
  debug: false,
  minRecentMessages: 15,
  defaultTokenBudget: 100000,
  enableLLMCompression: true,
  llmTimeout: 30000,
};

// ============================================================================
// UnifiedCompressor 类
// ============================================================================

export class UnifiedCompressor implements IUnifiedCompressor {
  private config: Required<UnifiedCompressorConfig>;
  private toolCompressor: ToolCompressor;
  private messageCompressor: MessageCompressor;
  private llmSummarizer: LLMSummarizer;
  private llmProvider?: LLMProvider;
  private model?: string;
  private contextWindow?: number;

  constructor(config?: UnifiedCompressorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.debug = this.config.debug || process.env.CLI_DEBUG === '1';

    this.toolCompressor = new ToolCompressor({ debug: this.config.debug });
    this.messageCompressor = new MessageCompressor({
      debug: this.config.debug,
      toolCompressor: this.toolCompressor,
      minRecentMessages: this.config.minRecentMessages,
    });
    this.llmSummarizer = new LLMSummarizer({
      protectRecentCount: this.config.minRecentMessages,
    });
  }

  /**
   * 设置 LLM Provider（用于智能压缩）
   */
  setLLMProvider(provider: LLMProvider, model?: string): void {
    this.llmProvider = provider;
    this.model = model;
  }

  /**
   *  设置模型上下文窗口大小（用于动态计算压缩阈值）
   */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
    if (this.config.debug) {
      cliLogger.info('UnifiedCompressor', `Context window set to: ${contextWindow}`);
    }
  }

  /**
   * 注册自定义 Tool 压缩器
   */
  registerToolCompressor(compressor: IToolCompressor): void {
    // 扩展点：允许注册自定义的 tool 压缩器
    // 目前使用内置的 ToolCompressor
    cliLogger.info('UnifiedCompressor', 'Custom tool compressor registered');
  }

  /**
   * 设置自定义 Message 压缩器
   */
  setMessageCompressor(compressor: IMessageCompressor): void {
    // 扩展点：允许替换 message 压缩器
    this.messageCompressor = compressor as MessageCompressor;
    cliLogger.info('UnifiedCompressor', 'Custom message compressor set');
  }

  /**
   * 压缩整个对话历史 — 主入口
   *
   * 到阈值 → 降级模型 LLM 摘要 → 替换旧消息。
   * 不裁剪、不截断 — 理解后重写。
   */
  async compressHistory(
    messages: Message[],
    tokenBudget: number,
    context?: Partial<CompressionContext>,
    onProgress?: (progress: import('./llmSummarizer.js').CompressionProgress) => void,
  ): Promise<BatchCompressionResult> {
    const startTime = Date.now();
    const originalTokens = estimateTokensFromMessages(messages);

    const llmProvider = context?.llmProvider || this.llmProvider;
    const model = context?.model || this.model;

    if (this.config.debug) {
      cliLogger.debug('UnifiedCompressor',
        `开始压缩: ${messages.length} 条消息, ${originalTokens} tokens → 预算 ${tokenBudget} tokens`
      );
    }

    if (originalTokens <= tokenBudget && !context?.force) {
      return {
        messages,
        originalCount: messages.length,
        compressedCount: messages.length,
        originalTokens,
        compressedTokens: originalTokens,
        savedTokens: 0,
        stats: { droppedMessages: 0, llmCompressedMessages: 0, truncatedMessages: 0, preservedMessages: messages.length },
      };
    }

    if (context?.force && originalTokens <= tokenBudget) {
      cliLogger.info('UnifiedCompressor',
        `Manual force: ${originalTokens} tok still within budget ${tokenBudget} — running LLM summarize anyway`);
    }

    if (!llmProvider || !model) {
      cliLogger.warn('UnifiedCompressor', 'No LLM provider available for compression — cannot compress');
      return {
        messages,
        originalCount: messages.length,
        compressedCount: messages.length,
        originalTokens,
        compressedTokens: originalTokens,
        savedTokens: 0,
        stats: { droppedMessages: 0, llmCompressedMessages: 0, truncatedMessages: 0, preservedMessages: messages.length },
      };
    }

    /* 压缩目标由调用方按统一 token 口径提供，手动和自动路径共享该预算。 */
    const force = !!context?.force;
    const effectiveBudget = tokenBudget;
    const summarizeOverrides = context?.summarizerOverrides
      ?? (force ? { protectRecentCount: 2, protectHeadCount: 0, force: true as const } : undefined);

    const result = await this.llmSummarizer.summarize(
      messages,
      effectiveBudget,
      llmProvider,
      model,
      onProgress,
      summarizeOverrides,
    );

    const elapsed = Date.now() - startTime;
    cliLogger.info('UnifiedCompressor',
      `LLM summarization done (${elapsed}ms): ${messages.length} → ${result.messages.length} msgs, ` +
      `${result.originalTokens} → ${result.compressedTokens} tok ` +
      `(saved ${result.savedTokens}, ${((result.savedTokens / result.originalTokens) * 100).toFixed(1)}%, ` +
      `${result.bucketDetails.filter(b => b.status === 'done').length} buckets, model=${result.summaryModel})`
    );

    /* 只有结果严格变小才提交压缩，否则保留原始消息和 token 账本。 */
    if (result.compressedTokens >= result.originalTokens) {
      cliLogger.warn('UnifiedCompressor',
        `Compression made context larger (${result.originalTokens} → ${result.compressedTokens} tok) — discarding result, keeping original`);
      const llmBuckets = result.bucketDetails.filter(b => b.status === 'done').length;
      return {
        messages,
        originalCount: messages.length,
        compressedCount: messages.length,
        originalTokens: result.originalTokens,
        compressedTokens: result.originalTokens,
        savedTokens: 0,
        stats: {
          droppedMessages: 0,
          // 保留 llm 计数 → UI 显示"摘要未缩小"而不是"可压区过小"
          llmCompressedMessages: llmBuckets,
          truncatedMessages: 0,
          preservedMessages: messages.length,
        },
      };
    }

    return {
      messages: result.messages,
      originalCount: messages.length,
      compressedCount: result.messages.length,
      originalTokens: result.originalTokens,
      compressedTokens: result.compressedTokens,
      savedTokens: result.savedTokens,
      summary: result.messages.find(m => m.content?.toString().includes(COMPACTION_SUMMARY_MARKER))?.content?.toString(),
      stats: {
        droppedMessages: result.summarizedCount,
        llmCompressedMessages: result.bucketDetails.filter(b => b.status === 'done').length,
        truncatedMessages: 0,
        preservedMessages: result.preservedCount,
      },
    };
  }

  /**
   * 只压缩大消息（不删除任何消息）
   */
  private async compressLargeMessagesOnly(
    messages: Message[],
    context: CompressionContext
  ): Promise<BatchCompressionResult> {
    const originalTokens = estimateTokensFromMessages(messages);
    const compressedMessages: Message[] = [];
    let llmCompressedCount = 0;
    let truncatedCount = 0;

    for (const msg of messages) {
      const tokens = estimateTokensForMessage(msg);

      // 只压缩大消息（超过 2000 tokens）
      if (tokens > 2000 && msg.role !== 'system') {
        const result = await this.messageCompressor.compressMessage(msg, context);
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
    };
  }

  /**
   * 实时压缩单个 Tool 结果（在 tool 执行后立即调用）
   */
  async compressToolResult(
    toolName: string,
    toolResult: string,
    context?: Partial<CompressionContext>
  ): Promise<string> {
    const fullContext: CompressionContext = {
      llmProvider: context?.llmProvider || this.llmProvider,
      model: context?.model || this.model,
      enableLLMCompression: context?.enableLLMCompression ?? this.config.enableLLMCompression,
      timeout: context?.timeout ?? this.config.llmTimeout,
      debug: this.config.debug,
    };

    const result = await this.toolCompressor.compress(toolName, toolResult, fullContext);
    return result.content;
  }

  /**
   * 获取压缩统计信息
   */
  getStats(): {
    config: UnifiedCompressorConfig;
    hasLLMProvider: boolean;
  } {
    return {
      config: this.config,
      hasLLMProvider: !!this.llmProvider,
    };
  }
}

// ============================================================================
// 导出
// ============================================================================

// 默认实例
let defaultCompressor: UnifiedCompressor | null = null;

/**
 * 获取默认的统一压缩器实例
 */
export function getUnifiedCompressor(config?: UnifiedCompressorConfig): UnifiedCompressor {
  if (!defaultCompressor) {
    defaultCompressor = new UnifiedCompressor(config);
  }
  return defaultCompressor;
}

/**
 * 创建新的统一压缩器实例
 */
export function createUnifiedCompressor(config?: UnifiedCompressorConfig): UnifiedCompressor {
  return new UnifiedCompressor(config);
}

// 重新导出类型和子模块
export { ToolCompressor } from './toolCompressor.js';
export { MessageCompressor, MessagePriority } from './messageCompressor.js';
export { LLMSummarizer } from './llmSummarizer.js';
export {
  smartPruneToolOutputs,
  autoSmartPruneIfOverBudget,
  DEFAULT_PROTECT_TOOLS,
  DEFAULT_PROTECT_RECENT_TURNS,
  DEFAULT_MIN_PRUNE_TOKENS,
} from './smartPruner.js';
export type {
  SmartPruneOptions,
  SmartPruneResult,
  PrunedToolInfo,
  AutoSmartPruneOptions,
} from './smartPruner.js';
export * from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// 内部辅助:把 SmartPruneResult 转成 BatchCompressionResult(对齐外层协议)
// ════════════════════════════════════════════════════════════════════════════

function buildResultFromPrune(
  pruneResult: SmartPruneResult,
  originalTokens: number,
  afterPruneTokens: number,
  originalCount: number,
): BatchCompressionResult {
  return {
    messages: pruneResult.messages,
    originalCount,
    compressedCount: pruneResult.messages.length,
    originalTokens,
    compressedTokens: afterPruneTokens,
    savedTokens: originalTokens - afterPruneTokens,
    stats: {
      // Smart Pruning 不删除整条消息, 只把 tool_result 替换为 placeholder;
      // 在统计上计入 truncatedMessages。
      droppedMessages: 0,
      llmCompressedMessages: 0,
      truncatedMessages: pruneResult.prunedCount,
      preservedMessages: pruneResult.messages.length - pruneResult.prunedCount,
    },
  };
}
