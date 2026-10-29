/**
 * Provider Adapters - 基础接口
 *
 * Adapter 组合 Constraints 和 PromptBuilder，提供统一的接口
 */

import type { Message, ChatCompletionResponse, Tool, StructuredOutputDefinition } from '@neoxlabs/kernel/types/index.js';
import type { BaseConstraints } from '../constraints/base.js';
import type { BasePromptBuilder } from '../prompts/base.js';

// ============================================================================
// 工具对消息修复 (tool_calls ↔ tool messages 成对校验)
// ============================================================================

/**
 * sanitizeToolPairs — 确保发给 LLM 的消息历史里每个 tool_call 都有对应的 tool message.
 *
 * DeepSeek / 部分 OpenAI 兼容严格 provider 强校验:
 *   "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"
 *
 * 产生孤儿的场景:
 *   · 上下文压缩/裁剪把 tool_result 切掉了但留了 assistant 的 tool_calls
 *   · tool 执行超时/crash 没回填 tool_result
 *   · crash-resume 的 repairMessageHistory 只对 stale session 跑,正常续会话漏了
 *
 * 策略(保守,不丢真实信息):
 *   1. 遍历找所有 assistant.tool_calls 里的 id → 收集需要的 tool_call_id 集合
 *   2. 遍历找已有的 tool messages → 收集已回填的 tool_call_id 集合
 *   3. 缺失的 id → 在对应 assistant 消息后面补一条 placeholder tool message
 *      (content = "[interrupted]", 让 LLM 知道工具没有输出)
 *   4. 有 tool message 但前面没有对应 assistant.tool_calls → 删掉(孤儿 tool response)
 */
function sanitizeToolPairs(messages: Message[]): Message[] {
  /* 快速路径: 没有 tool_calls 的对话直接返回 (绝大多数普通对话) */
  if (!messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.length)) {
    return messages;
  }

  /* 收集所有 assistant 要求的 tool_call_id */
  const requiredIds = new Set<string>();
  for (const m of messages) {
    if ((m as any).role === 'assistant' && (m as any).tool_calls) {
      for (const tc of (m as any).tool_calls) {
        if (tc.id) requiredIds.add(tc.id);
      }
    }
  }

  /* 收集已有 tool 回复的 id */
  const answeredIds = new Set<string>();
  for (const m of messages) {
    if ((m as any).role === 'tool' && (m as any).tool_call_id) {
      answeredIds.add((m as any).tool_call_id);
    }
  }

  /* 没有缺失 + 没有孤儿 tool response → 快速返回 */
  const missingIds = new Set([...requiredIds].filter((id) => !answeredIds.has(id)));
  const orphanToolIds = new Set([...answeredIds].filter((id) => !requiredIds.has(id)));
  if (missingIds.size === 0 && orphanToolIds.size === 0) return messages;

  /* 需要修补 — 重建数组 */
  const result: Message[] = [];
  for (const m of messages) {
    /* 删掉孤儿 tool response (前面没对应 assistant.tool_calls 的) */
    if ((m as any).role === 'tool' && (m as any).tool_call_id && orphanToolIds.has((m as any).tool_call_id)) {
      continue;
    }
    result.push(m);
    /* 如果是 assistant 带 tool_calls, 检查有没有缺失的 id 需要补 */
    if ((m as any).role === 'assistant' && (m as any).tool_calls) {
      for (const tc of (m as any).tool_calls) {
        if (tc.id && missingIds.has(tc.id)) {
          result.push({
            role: 'tool',
            content: '[interrupted]',
            tool_call_id: tc.id,
          } as any);
          missingIds.delete(tc.id);
        }
      }
    }
  }
  return result;
}


// ============================================================================
// 类型定义
// ============================================================================

/** Chat 选项 */
export interface ChatOptions {
  /** 模型名称 */
  model?: string;

  /** 工具列表 */
  tools?: Tool[];

  /** 温度参数 */
  temperature?: number;

  /** Structured output 定义 */
  structuredOutput?: StructuredOutputDefinition;

  /** 禁用默认 system prompt 注入（保留现有消息） */
  disableSystemPrompt?: boolean;

  /** 自定义 system prompt（覆盖默认 prompt 构建器） */
  systemPromptOverride?: string;

  /** 最大输入 tokens */
  maxInputTokens?: number;

  /** Top P 采样 */
  topP?: number;

  /** Top K 采样 */
  topK?: number;

  /** 停止序列 */
  stopSequences?: string[];

  /** Abort 信号 */
  signal?: AbortSignal;

  /** 最大输出 tokens */
  maxTokens?: number;

  /** Fine-Grained Tool Streaming — 工具参数不缓冲直接流式输出 */
  enableFGTS?: boolean;

  disableThinking?: boolean;

  /** 用户选的思考档位 (off/low/high/max…), provider 按 schemas/models/<id>.yaml 的 effort_map 翻译 */
  effortLevel?: string;

  /** Provider 特定的额外参数 */
  [key: string]: any;
}

/** 准备好的请求 */
export interface PreparedRequest {
  /** 处理后的消息列表（包含 system prompt） */
  messages: Message[];

  /** 标准化后的选项 */
  options: ChatOptions;

  /** 验证结果 */
  validation?: {
    valid: boolean;
    errors?: string[];
    warnings?: string[];
  };
}

// ============================================================================
// Provider Adapter 接口
// ============================================================================

/**
 * Provider Adapter 接口
 *
 * 职责：
 * 1. 组合 Constraints 和 PromptBuilder
 * 2. 验证请求参数
 * 3. 注入 system prompt
 * 4. 标准化参数
 * 5. 调用底层 provider
 */
export interface ProviderAdapter {
  /** 约束验证器 */
  readonly constraints: BaseConstraints;

  /** Prompt 构建器 */
  readonly promptBuilder: BasePromptBuilder;

  /**
   * 准备请求
   * - 验证参数
   * - 注入 system prompt
   * - 标准化参数
   *
   * @param messages 消息列表
   * @param options Chat 选项
   * @returns 准备好的请求
   */
  prepareRequest(messages: Message[], options: ChatOptions): PreparedRequest;

  /**
   * 发送聊天请求（非流式）
   *
   * @param messages 消息列表
   * @param options Chat 选项
   * @returns 聊天响应
   */
  chat(messages: Message[], options: ChatOptions): Promise<ChatCompletionResponse>;

  /**
   * 发送聊天请求（流式）
   *
   * @param messages 消息列表
   * @param options Chat 选项
   * @returns 流式响应生成器
   */
  chatStreamed(
    messages: Message[],
    options: ChatOptions
  ): AsyncGenerator<any>;
}

// ============================================================================
// 基础 Adapter 抽象类
// ============================================================================

/**
 * 基础 Adapter 抽象类
 *
 * 提供通用的请求准备逻辑
 */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly constraints: BaseConstraints;
  abstract readonly promptBuilder: BasePromptBuilder;

  /**
   * 准备请求
   */
  prepareRequest(messages: Message[], options: ChatOptions): PreparedRequest {
    const {
      model,
      temperature,
      maxInputTokens,
      disableSystemPrompt,
      systemPromptOverride,
      ...otherOptions
    } = options;

    const outputMaxTokens = typeof (otherOptions as any).maxTokens === 'number' && (otherOptions as any).maxTokens > 0
      ? (otherOptions as any).maxTokens
      : undefined;

    // 1. 验证参数
    const validation = this.constraints.validateParams({
      model,
      temperature,
      ...(outputMaxTokens !== undefined ? { max_tokens: outputMaxTokens } : {}),
      ...otherOptions,
    });

    // 2. 标准化参数
    const normalizedOptions = this.constraints.normalizeParams({
      model,
      temperature,
      ...(outputMaxTokens !== undefined ? { max_tokens: outputMaxTokens } : {}),
      ...otherOptions,
    });

    const hasSystemMessage = messages.some((msg) => msg.role === 'system');
    const explicitSystemPrompt = systemPromptOverride?.trim();
    const shouldUseExplicitSystemPrompt = !disableSystemPrompt && !!explicitSystemPrompt;
    const shouldBuildDefaultSystemPrompt = !disableSystemPrompt && !shouldUseExplicitSystemPrompt && !hasSystemMessage;

    // 3. 构建 system prompt
    const systemPrompt = shouldUseExplicitSystemPrompt
      ? explicitSystemPrompt!
      : shouldBuildDefaultSystemPrompt
        ? this.promptBuilder.buildSystemPrompt({
          workDir: process.cwd(),
          language: this.detectLanguage(),
          modelName: model,
        })
        : null;

    // 4. 注入 system prompt 到消息列表
    const messagesWithSystem = !systemPrompt
      ? messages
      : this.injectSystemPrompt(messages, systemPrompt);

    // 5. 应用 token 限制
    const finalOptions: ChatOptions = {
      ...normalizedOptions,
      model,
      maxInputTokens: this.applyTokenLimits(model, maxInputTokens),
    };

    // 6. 确保 tool_calls / tool 消息成对 — DS/某些严格 provider 要求每个 tool_call_id
    //    都有对应 tool message, 否则 400. 上下文裁剪/crash 可能造成不配对, 这里修补.
    const sanitizedMessages = sanitizeToolPairs(messagesWithSystem);

    return {
      messages: sanitizedMessages,
      options: finalOptions,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    };
  }

  /**
   * 注入 system prompt
   */
  protected injectSystemPrompt(messages: Message[], systemPrompt: string): Message[] {
    // 检查是否已有 system message
    const hasSystemMessage = messages.some((msg) => msg.role === 'system');

    if (hasSystemMessage) {
      const systemTexts = messages
        .filter((msg) => msg.role === 'system')
        .map((msg) => this.normalizeSystemContent(msg.content))
        .filter((text) => text.length > 0);
      const mergedSystemPrompt = systemTexts.length > 0
        ? [systemPrompt, ...systemTexts].join('\n\n')
        : systemPrompt;
      const nonSystemMessages = messages.filter((msg) => msg.role !== 'system');

      return [
        { role: 'system', content: mergedSystemPrompt },
        ...nonSystemMessages,
      ];
    }

    // 在开头添加 system message
    return [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
  }

  private normalizeSystemContent(content: Message['content']): string {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
        })
        .join('');
      return text.trim();
    }
    return String(content).trim();
  }

  /**
   * 应用 token 限制
   */
  protected applyTokenLimits(model: string | undefined, requestedTokens?: number): number | undefined {
    if (!model) return requestedTokens;

    const limits = this.constraints.getTokenLimits(model);

    if (!requestedTokens) {
      // 使用推荐值
      return Math.min(4096, limits.maxOutput);
    }

    // 确保不超过模型限制
    return Math.min(requestedTokens, limits.maxOutput);
  }

  /**
   * 检测语言
   */
  protected detectLanguage(): 'zh' | 'en' {
    // 可以从环境变量、配置文件等读取
    // 暂时默认中文
    return process.env.NEOX_LANGUAGE === 'en' ? 'en' : 'zh';
  }

  /**
   * 抽象方法：发送聊天请求
   */
  abstract chat(messages: Message[], options: ChatOptions): Promise<ChatCompletionResponse>;

  /**
   * 抽象方法：发送流式聊天请求
   */
  abstract chatStreamed(messages: Message[], options: ChatOptions): AsyncGenerator<any>;
}
