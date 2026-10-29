import type { TaskResult, ContextSharingStrategy } from '@neoxlabs/platform/utils/config.js';
import type { Message, LLMProvider } from './taskAnalyzer.js';

/**
 * 共享上下文
 */
export interface SharedContext {
  fromModel: string;
  toModel: string;
  result: TaskResult;
  messages: Message[];
  timestamp: Date;
}

/**
 * SharedContextManager - 共享上下文管理器
 * 在不同模型间共享执行上下文
 */
export class SharedContextManager {
  private contextStore: Map<string, SharedContext>;
  private summarizer?: LLMProvider;
  private summarizerModel: string;

  constructor(summarizer?: LLMProvider, summarizerModel: string = 'claude-haiku') {
    this.contextStore = new Map();
    this.summarizer = summarizer;
    this.summarizerModel = summarizerModel;
  }

  /**
   * 在模型间共享上下文
   * @param fromModel 源模型
   * @param toModel 目标模型
   * @param result 任务执行结果
   * @param strategy 共享策略
   * @returns 构建的上下文消息
   */
  async shareContext(
    fromModel: string,
    toModel: string,
    result: TaskResult,
    strategy: ContextSharingStrategy
  ): Promise<Message[]> {
    let messages: Message[];

    switch (strategy) {
      case 'full':
        messages = await this.buildFullContext(result);
        break;
      case 'summary':
        messages = await this.buildSummaryContext(result);
        break;
      case 'selective':
        messages = await this.buildSelectiveContext(result);
        break;
      default:
        messages = await this.buildFullContext(result);
    }

    // 存储共享上下文
    const contextKey = `${fromModel}->${toModel}`;
    this.contextStore.set(contextKey, {
      fromModel,
      toModel,
      result,
      messages,
      timestamp: new Date(),
    });

    return messages;
  }

  /**
   * 构建完整上下文（适合上下文窗口大的模型）
   */
  private async buildFullContext(result: TaskResult): Promise<Message[]> {
    return [
      {
        role: 'system',
        content: `前序任务(${result.task.type})已完成，以下是执行结果:\n\n任务描述: ${result.task.description}\n执行模型: ${result.model}\n\n结果:\n${result.output}`,
      },
    ];
  }

  /**
   * 构建摘要上下文（节省tokens）
   */
  private async buildSummaryContext(result: TaskResult): Promise<Message[]> {
    if (!this.summarizer) {
      // 如果没有 summarizer，降级到 selective
      return this.buildSelectiveContext(result);
    }

    try {
      // 用轻量模型生成摘要
      const summaryPrompt = `请总结以下任务执行结果，保留关键信息，控制在500字以内:

任务类型: ${result.task.type}
任务描述: ${result.task.description}
执行模型: ${result.model}

执行结果:
${result.output}

请提供简洁的摘要，保留所有重要信息和结论。`;

      const response = await this.summarizer.chat(
        [{ role: 'user', content: summaryPrompt }],
        { temperature: 0.3, maxTokens: 500 }
      );

      return [
        {
          role: 'system',
          content: `前序任务(${result.task.type})的执行摘要:\n${response.content}`,
        },
      ];
    } catch (error) {
      console.error('[SharedContextManager] Failed to generate summary, using selective:', error);
      return this.buildSelectiveContext(result);
    }
  }

  /**
   * 构建选择性上下文（只传关键信息）
   */
  private async buildSelectiveContext(result: TaskResult): Promise<Message[]> {
    // 提取关键信息
    const keyInfo = this.extractKeyInformation(result);

    return [
      {
        role: 'system',
        content: `前序任务完成，关键信息:\n- 任务类型: ${result.task.type}\n- 复杂度: ${result.task.estimatedComplexity}\n- 关键结果: ${keyInfo}`,
      },
    ];
  }

  /**
   * 提取关键信息
   */
  private extractKeyInformation(result: TaskResult): string {
    const output = result.output;
    const maxLength = 300;

    // 根据任务类型提取不同的关键信息
    switch (result.task.type) {
      case 'image_analysis':
        // 图像分析：提取物体、场景描述
        return this.truncateText(output, maxLength);

      case 'coding':
      case 'code_review':
        // 代码相关：提取函数签名、关键逻辑
        const codeBlocks = output.match(/```[\s\S]*?```/g);
        if (codeBlocks && codeBlocks.length > 0) {
          return `代码片段数量: ${codeBlocks.length}, 首个代码块: ${this.truncateText(codeBlocks[0], 200)}`;
        }
        return this.truncateText(output, maxLength);

      case 'debugging':
        // 调试：提取错误信息、解决方案
        const errorMatch = output.match(/错误|error|bug/gi);
        return errorMatch
          ? this.truncateText(output, maxLength)
          : `调试结果: ${this.truncateText(output, maxLength)}`;

      case 'data_analysis':
        // 数据分析：提取数值、趋势
        const numbers = output.match(/\d+(?:\.\d+)?%?/g);
        const hasNumbers = numbers && numbers.length > 0;
        return hasNumbers
          ? `数据摘要(含${numbers.length}个数值): ${this.truncateText(output, maxLength)}`
          : this.truncateText(output, maxLength);

      case 'summarization':
        // 总结：直接使用原文（已经是摘要）
        return this.truncateText(output, maxLength);

      default:
        return this.truncateText(output, maxLength);
    }
  }

  /**
   * 截断文本
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength) + '...';
  }

  /**
   * 获取存储的共享上下文
   */
  getStoredContext(fromModel: string, toModel: string): SharedContext | undefined {
    const contextKey = `${fromModel}->${toModel}`;
    return this.contextStore.get(contextKey);
  }

  /**
   * 清理过期的上下文（超过指定时间的）
   */
  cleanupOldContexts(maxAgeMs: number = 3600000): void {
    // 默认清理1小时前的上下文
    const now = Date.now();
    for (const [key, context] of this.contextStore.entries()) {
      if (now - context.timestamp.getTime() > maxAgeMs) {
        this.contextStore.delete(key);
      }
    }
  }

  /**
   * 清空所有存储的上下文
   */
  clearAll(): void {
    this.contextStore.clear();
  }

  /**
   * 获取上下文存储的统计信息
   */
  getStats(): {
    totalContexts: number;
    oldestContext?: Date;
    newestContext?: Date;
  } {
    const contexts = Array.from(this.contextStore.values());
    if (contexts.length === 0) {
      return { totalContexts: 0 };
    }

    const timestamps = contexts.map((c) => c.timestamp.getTime());
    return {
      totalContexts: contexts.length,
      oldestContext: new Date(Math.min(...timestamps)),
      newestContext: new Date(Math.max(...timestamps)),
    };
  }

  /**
   * 设置摘要生成器
   */
  setSummarizer(summarizer: LLMProvider, model?: string): void {
    this.summarizer = summarizer;
    if (model) {
      this.summarizerModel = model;
    }
  }

  /**
   * 估算上下文消息的 token 数量（粗略估算）
   */
  estimateTokens(messages: Message[]): number {
    // 粗略估算：英文约4字符=1token，中文约1.5字符=1token
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
    }

    // 取平均值：2.5字符约1token
    return Math.ceil(totalChars / 2.5);
  }

  /**
   * 根据 token 限制调整上下文
   */
  async adjustContextForTokenLimit(
    messages: Message[],
    maxTokens: number
  ): Promise<Message[]> {
    const estimatedTokens = this.estimateTokens(messages);

    if (estimatedTokens <= maxTokens) {
      return messages;
    }

    // 如果超出限制，尝试压缩
    const compressionRatio = maxTokens / estimatedTokens;
    const adjustedMessages: Message[] = [];

    for (const msg of messages) {
      const targetLength = Math.floor(msg.content.length * compressionRatio);
      adjustedMessages.push({
        ...msg,
        content: this.truncateText(msg.content, targetLength),
      });
    }

    return adjustedMessages;
  }
}
