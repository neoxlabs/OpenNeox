import type { Message, ChatCompletionResponse, Tool, LLMProvider, StructuredOutputDefinition, TokenUsage, MessageContentPart } from '../types/index.js';
import { dumpLlmPayloadIfEnabled } from '../utils/payloadDump.js';
import { getTextFromContent } from '../utils/messageUtils.js';
import { cliLogger } from '../platform/cliLogger.js';
import type { ProviderRetryConfig } from '../types/retryConfig.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';
import { truncateToolOutput, WIRE_TOOL_OUTPUT_MAX_UNITS } from '../utils/toolOutputTruncation.js';
import { resolveEffortPayload, resolveDefaultThinkingLevel } from '../schemas/index.js';

interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type StreamLifecycleChunk = { type: 'stream_retry' | 'stream_recovered' };

function isStreamLifecycleChunk(chunk: unknown): chunk is StreamLifecycleChunk {
  return !!chunk && typeof chunk === 'object' && (((chunk as { type?: string }).type === 'stream_retry') || ((chunk as { type?: string }).type === 'stream_recovered'));
}

interface KimiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | any[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
  reasoning_content?: string;
  /** 百炼显式缓存：Anthropic 风格 cache_control */
  cache_control?: { type: 'ephemeral' };
}

interface ChatCompletionsRequest {
  model: string;
  messages: KimiMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{
    type: 'function' | 'builtin_function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  response_format?: { type: 'json_object' };
  thinking?: { type: 'enabled' | 'disabled' };
  /** Kimi 缓存优化：相同 key 的请求共享前缀缓存 */
  prompt_cache_key?: string;
}

/** Kimi 内置工具名 → Neox 工具名 的映射 */
const KIMI_BUILTIN_TOOL_MAP: Record<string, string> = {
  '$web_search': 'web_search',
};

/** Neox 工具名 → Kimi 内置工具名 的映射 */
const NEOX_TO_KIMI_BUILTIN_MAP: Record<string, string> = {
  'web_search': '$web_search',
};

export interface KimiProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  retry?: ProviderRetryConfig;
  /** Session ID — 用于 prompt_cache_key 优化缓存命中 */
  sessionId?: string;
}

export class KimiProvider implements LLMProvider {
  private client: OpenAICompatibleClient;
  private defaultModel: string;
  private sessionId: string;
  private baseUrl: string;
  /**
   *  缓存策略判定：
   * - 百炼 (dashscope) → 显式 cache_control（Anthropic 风格，命中 10%）
   * - Kimi 官方 (moonshot) → prompt_cache_key（自动前缀缓存）
   * - 其他 → prompt_cache_key 兜底
   */
  private readonly cacheStrategy: 'bailian_explicit' | 'moonshot_auto';

  constructor(config: KimiProviderConfig) {
    this.defaultModel = config.defaultModel || 'kimi-k2.7-code';
    this.sessionId = config.sessionId || `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.baseUrl = config.baseUrl || 'https://api.moonshot.cn/v1';

    //  根据 baseUrl 判定缓存策略
    const urlLower = this.baseUrl.toLowerCase();
    this.cacheStrategy = (urlLower.includes('dashscope') || urlLower.includes('aliyun'))
      ? 'bailian_explicit'
      : 'moonshot_auto';

    this.client = new OpenAICompatibleClient({
      apiKey: config.apiKey,
      baseUrl: this.baseUrl,
      providerName: 'Kimi',
      retry: config.retry,
    });

    cliLogger.info(
      'Kimi',
      `链路自检 baseUrl=${this.baseUrl} defaultModel=${this.defaultModel} cacheStrategy=${this.cacheStrategy} sessionId=${this.sessionId}`
    );
    if (this.cacheStrategy === 'bailian_explicit') {
      cliLogger.info('Kimi', '百炼模式：使用 cache_control ephemeral 显式缓存（命中 10% 价格）');
    } else {
      cliLogger.info('Kimi', '官方模式：使用 prompt_cache_key 自动前缀缓存');
    }
  }

  private logPayloadSummary(stage: 'chat' | 'stream', payload: ChatCompletionsRequest): void {
    const msgs = payload.messages || [];
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    const assistantWithTools = msgs.filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);
    const assistantMissingReasoning = assistantWithTools.filter(m => !m.reasoning_content);
    const emptyToolContent = toolMsgs.filter(m => {
      const c = m.content;
      if (c == null) return true;
      if (typeof c === 'string') return c.trim().length === 0;
      if (Array.isArray(c)) return c.length === 0;
      return false;
    });
    const toolCallIds = new Set(
      assistantWithTools.flatMap(m => (m.tool_calls || []).map(tc => tc.id))
    );
    const toolResponseIds = new Set(toolMsgs.map(m => m.tool_call_id).filter(Boolean) as string[]);
    const missingToolResponses: string[] = [];
    toolCallIds.forEach(id => {
      if (!toolResponseIds.has(id)) missingToolResponses.push(id);
    });

    const summary = {
      stage,
      model: payload.model,
      stream: payload.stream,
      thinking: payload.thinking?.type,
      temperature: payload.temperature,
      max_tokens: payload.max_tokens,
      prompt_cache_key: payload.prompt_cache_key,
      cacheStrategy: this.cacheStrategy,
      messages: msgs.length,
      toolMessages: toolMsgs.length,
      assistantWithTools: assistantWithTools.length,
      assistantMissingReasoning: assistantMissingReasoning.length,
      emptyToolContent: emptyToolContent.length,
      unmatchedToolCallIds: missingToolResponses,
      tools: payload.tools?.length ?? 0,
      toolNames: payload.tools?.map(t => t.function.name).slice(0, 20),
    };
    cliLogger.info('Kimi', `payload summary: ${JSON.stringify(summary)}`);

    //  详细 messages 序列 dump — 出 400 时按此逐条对照 Moonshot 报错的 tool_call_id
    // 格式: "[idx] role=X (tool_call_ids=... | tool_call_id=... | content=first 60 chars | contentLen=... | name=...)"
    const sequenceLines: string[] = msgs.map((m, idx) => {
      const role = m.role;
      let detail = '';
      if (role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const ids = m.tool_calls.map(tc => `${tc.function?.name || '?'}:${tc.id}`).join(',');
        detail = `tool_calls=[${ids}]`;
      }
      if (role === 'tool') {
        detail = `tool_call_id=${m.tool_call_id || '(missing!)'} name=${m.name || '(missing)'}`;
      }
      const contentPreview = typeof m.content === 'string'
        ? m.content.slice(0, 60).replace(/\n/g, '\\n')
        : Array.isArray(m.content)
          ? `[array len=${m.content.length}]`
          : m.content === null ? 'null' : 'other';
      const contentLen = typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? m.content.length : 0);
      return `  [${idx}] role=${role} ${detail} | contentLen=${contentLen} | preview="${contentPreview}"`;
    });
    cliLogger.info('Kimi', `payload messages sequence (${msgs.length} total):\n${sequenceLines.join('\n')}`);

    if (missingToolResponses.length > 0) {
      cliLogger.warn(
        'Kimi',
        `⚠️ 发现 ${missingToolResponses.length} 个 assistant tool_call 没有对应的 tool 响应 (会触发 Moonshot 400): ${missingToolResponses.join(', ')}`
      );
    }
    if (assistantMissingReasoning.length > 0 && payload.thinking?.type === 'enabled') {
      cliLogger.warn(
        'Kimi',
        `⚠️ thinking=enabled 下有 ${assistantMissingReasoning.length} 个 assistant(含 tool_calls) 缺 reasoning_content (Moonshot K2.5 会 400)`
      );
    }
  }

  async chat(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      disableSystemPrompt?: boolean;
      signal?: AbortSignal;
      /** Per-call thinking override — 不传走 instance default (KIMI_THINKING env / setKimiThinking).
       * side-agent (title/summary/ack) 可传 disabled 以减少推理开销。 */
      thinking?: { type: 'enabled' | 'disabled' };
    }
  ): Promise<ChatCompletionResponse> {
    const model = options.model || this.defaultModel;
    const payload = this.buildChatCompletionsPayload(messages, {
      model,
      tools: options.tools,
      temperature: options.temperature ?? 1,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      stream: false,
      disableSystemPrompt: options.disableSystemPrompt,
      thinking: options.thinking,
    });

    this.logPayloadSummary('chat', payload);
    const raw = await this.client.postJson<any>('/chat/completions', payload, options.signal);
    return this.normalizeChatResponse(raw);
  }

  async *chatStreamed(
    messages: Message[],
    options: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      disableSystemPrompt?: boolean;
      signal?: AbortSignal;
      /** Per-call thinking override — 不传走 instance default (KIMI_THINKING env / setKimiThinking).
       * side-agent (title/summary/ack) 可传 disabled 以减少推理开销。 */
      thinking?: { type: 'enabled' | 'disabled' };
      /** D13: schema-driven effort level. yaml effort_map[level] 的 native fields spread 进 payload. */
      effortLevel?: string;
    }
  ): AsyncGenerator<any> {
    const model = options.model || this.defaultModel;
    const payload = this.buildChatCompletionsPayload(messages, {
      model,
      tools: options.tools,
      temperature: options.temperature ?? 1,
      structuredOutput: options.structuredOutput,
      maxInputTokens: options.maxInputTokens,
      stream: true,
      disableSystemPrompt: options.disableSystemPrompt,
      thinking: options.thinking,
    });

    /* D13 effort_map 真生效: yaml 字段 spread 到 payload (不覆盖既有 fields, 因 thinking 等可能已设) */
    /* 用户没选 effort 时按 yaml default_level 注入默认思考档 (跟 anthropic/openai client 对齐) */
    const effectiveEffortLevel = options.effortLevel ?? resolveDefaultThinkingLevel(model) ?? undefined;
    if (effectiveEffortLevel) {
      const resolved = resolveEffortPayload(model, effectiveEffortLevel);
      for (const [k, v] of Object.entries(resolved.payload)) {
        if (!(k in payload)) (payload as any)[k] = v;
      }
    }

    this.logPayloadSummary('stream', payload);
    for await (const chunk of this.client.streamJsonEvents('/chat/completions', payload, { signal: options.signal })) {
      if (isStreamLifecycleChunk(chunk)) {
        yield chunk;
        continue;
      }

      yield this.normalizeStreamChunk(chunk);
    }
  }

  private isK25Model(model: string): boolean {
    return model.startsWith('kimi-k2.5') || model === 'kimi-k2.5-preview';
  }

  private resolveThinkingType(): 'enabled' | 'disabled' {
    return process.env.KIMI_THINKING === 'disabled' ? 'disabled' : 'enabled';
  }

  private mapTools(tools?: Tool[]): ChatCompletionsRequest['tools'] | undefined {
    if (!tools || tools.length === 0) return undefined;

    //  所有工具保持原样传递给 Kimi API
    // web_search 的 Kimi 原生联网搜索($web_search) 已由 webTools.ts 内部处理
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 将 Neox 工具名映射回 Kimi 内置工具名（用于发送历史消息时保持一致）
   */
  private reverseMapToolName(name: string): string {
    return NEOX_TO_KIMI_BUILTIN_MAP[name] || name;
  }

  /**
   * 修复 assistant(tool_calls) 和 tool_result 的配对。
   * Moonshot/Kimi 对此要求很严:assistant 每个 tool_call_id 必须紧跟(在同一"段"内)
   * 一条 role='tool' 且 tool_call_id 匹配的响应,否则 400。
   *
   * 运行时上下文压缩 (messageCompressor.compressWithPriority) 按条独立打优先级,
   * 可能在预算紧张时保留 assistant 却丢掉部分或全部 tool 响应,形成 orphan tool_calls。
   * 这里在发送给 Moonshot 之前做防御性清理:把孤儿 tool_call 剥离成纯文本 assistant。
   */
  private sanitizeToolCallPairing(messages: Message[]): Message[] {
    // 收集每个 assistant 后续紧邻的 tool_call_id 集合
    const availableToolResponseIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.tool_call_id) {
        availableToolResponseIds.add(m.tool_call_id);
      }
    }

    const sanitized: Message[] = [];
    let strippedOrphans = 0;
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const keptCalls = m.tool_calls.filter(tc => tc.id && availableToolResponseIds.has(tc.id));
        if (keptCalls.length === m.tool_calls.length) {
          sanitized.push(m);
        } else {
          const dropped = m.tool_calls.length - keptCalls.length;
          strippedOrphans += dropped;
          const textContent = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? getTextFromContent(m.content)
              : '';
          if (keptCalls.length === 0) {
            // 全部孤儿:去掉 tool_calls,变成纯文本(若 content 为空则补占位,防止被后续 filter 掉)
            const patched: Message = {
              ...m,
              tool_calls: undefined,
              content: textContent && textContent.trim().length > 0
                ? textContent
                : '[previous tool call results were dropped by context compression]',
            };
            sanitized.push(patched);
          } else {
            sanitized.push({ ...m, tool_calls: keptCalls });
          }
        }
      } else {
        sanitized.push(m);
      }
    }

    // 移除孤儿 tool 响应(没有对应 assistant tool_call)
    const stillWantedIds = new Set<string>();
    for (const m of sanitized) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) if (tc.id) stillWantedIds.add(tc.id);
      }
    }
    const finalMessages = sanitized.filter(m => {
      if (m.role !== 'tool') return true;
      if (!m.tool_call_id) return false;
      return stillWantedIds.has(m.tool_call_id);
    });

    const droppedOrphanTools = sanitized.length - finalMessages.length;
    if (strippedOrphans > 0 || droppedOrphanTools > 0) {
      cliLogger.warn(
        'Kimi',
        `⚠️ sanitize tool pairing: stripped ${strippedOrphans} orphan tool_calls from assistant(s), dropped ${droppedOrphanTools} orphan tool responses. ` +
        `这通常是运行时上下文压缩(messageCompressor.compressWithPriority)没保证 tool_call/tool_result 配对导致。`
      );
    }

    //  防御 L2:修复"夹在 assistant(tool_calls) 和其 tool 响应之间"的非 tool 消息。
    // Moonshot 严格要求 assistant(tool_calls) 紧跟 tool 响应,中间不能插 system/user/普通 assistant。
    // 若发现夹带(例如 reasoning gate 注入的 [FOCUS] system、user 中断、其他 advisory 等),
    // 把它们挪到全部 tool 响应之后,保留 pairing 完整性。
    const reordered = this.repairToolCallBoundary(finalMessages);
    return reordered;
  }

  private repairToolCallBoundary(messages: Message[]): Message[] {
    const result: Message[] = [];
    let displacedCount = 0;
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      result.push(m);
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const expectedIds = new Set(m.tool_calls.map(tc => tc.id).filter((x): x is string => !!x));
        const toolResponses: Message[] = [];
        const displaced: Message[] = [];
        let seenToolCount = 0;
        let j = i + 1;
        // 向后扫描,把所有 tool 响应先收集,期间遇到非 tool 的消息暂存到 displaced
        while (j < messages.length && seenToolCount < expectedIds.size) {
          const next = messages[j];
          if (next.role === 'tool' && next.tool_call_id && expectedIds.has(next.tool_call_id)) {
            toolResponses.push(next);
            seenToolCount++;
          } else if (next.role === 'tool') {
            // 不属于当前 assistant 的 tool(可能是下一轮的孤儿,遇到就停)
            break;
          } else {
            // system / user / text-only assistant:被夹在中间,挪到 tool 响应后
            displaced.push(next);
            displacedCount++;
          }
          j++;
        }
        // 先 push tool 响应,再 push 被挪走的消息
        for (const tr of toolResponses) result.push(tr);
        for (const dm of displaced) result.push(dm);
        i = j;
        continue;
      }
      i++;
    }
    if (displacedCount > 0) {
      cliLogger.warn(
        'Kimi',
        `⚠️ sanitize tool pairing boundary: 把 ${displacedCount} 条夹在 assistant(tool_calls) 和 tool 响应之间的消息挪到后面。` +
        `根因:runner.ts 某处在 tool 执行前 push 了 system/user 消息(例如 reasoning gate [FOCUS]),会被 Moonshot 认为配对破坏 → 400。`
      );
    }
    return result;
  }

  private formatMessagesForChatCompletions(messages: Message[], disableSystemPrompt?: boolean): KimiMessage[] {
    const sanitized = this.sanitizeToolCallPairing(messages);
    const sourceMessages = disableSystemPrompt
      ? sanitized.filter(message => message.role !== 'system')
      : sanitized;

    const useBailianCache = this.cacheStrategy === 'bailian_explicit';

    return sourceMessages
      .filter(message => {
        const hasContent = message.content && (
          typeof message.content === 'string'
            ? message.content.trim().length > 0
            : Array.isArray(message.content) && message.content.length > 0
        );
        const hasToolCalls = !!(message.tool_calls && message.tool_calls.length > 0);
        return hasContent || hasToolCalls;
      })
      .map(message => {
        const formatted: KimiMessage = {
          role: message.role as KimiMessage['role'],
          content: null,
        };

        if (message.role === 'tool') {
          const rawContent = typeof message.content === 'string'
            ? message.content
            : getTextFromContent(message.content);
          formatted.content = truncateToolOutput(rawContent, WIRE_TOOL_OUTPUT_MAX_UNITS);
        } else if (Array.isArray(message.content)) {
          //  Kimi Vision 适配: 标准化 content parts
          // - image_url: 去掉 Kimi 不支持的 detail 字段
          // - text: 保持原样
          // - 其他类型 (thinking, tool_use 等): 转换为 text
          formatted.content = (message.content as MessageContentPart[])
            .map(part => {
              if (part?.type === 'image_url' && part?.image_url?.url) {
                return {
                  type: 'image_url',
                  image_url: { url: part.image_url.url },
                };
              }
              if (part?.type === 'text') {
                return { type: 'text', text: part.text || '' };
              }
              // 其他类型转换为 text（如 thinking, tool_use 等 Kimi 不支持的部分）
              if ('text' in part && typeof part.text === 'string' && part.text) {
                return { type: 'text', text: part.text };
              }
              return null;
            })
            .filter(Boolean);
        } else if (message.tool_calls && message.tool_calls.length > 0) {
          formatted.content = message.content || '';
        } else {
          formatted.content = message.content || null;
        }

        if (message.reasoning_content) {
          formatted.reasoning_content = message.reasoning_content;
        }

        if (message.name) {
          //  Kimi builtin 工具结果的 name 需要映射回 $web_search
          formatted.name = this.reverseMapToolName(message.name);
        }
        if (message.tool_call_id) formatted.tool_call_id = message.tool_call_id;
        if (message.tool_calls) {
          formatted.tool_calls = message.tool_calls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              //  Kimi builtin 工具调用的 name 需要映射回 $web_search
              name: this.reverseMapToolName(toolCall.function.name),
              arguments: toolCall.function.arguments,
            },
          }));
        }

        //  百炼显式缓存：给 system prompt 加 cache_control
        // 阿里云百炼的 Kimi K2.5 支持 Anthropic 风格的 cache_control
        // 标记 system prompt → 稳定内容被缓存 → 命中时只收 10% 价格
        if (useBailianCache && message.role === 'system') {
          formatted.cache_control = { type: 'ephemeral' };
        }

        return formatted;
      });
  }

  private buildChatCompletionsPayload(
    messages: Message[],
    options: {
      model: string;
      tools?: Tool[];
      temperature: number;
      structuredOutput?: StructuredOutputDefinition;
      maxInputTokens?: number;
      stream: boolean;
      disableSystemPrompt?: boolean;
      thinking?: { type: 'enabled' | 'disabled' };
    }
  ): ChatCompletionsRequest {
    const { model, tools, temperature, structuredOutput, maxInputTokens, stream, disableSystemPrompt, thinking } = options;

    //  Kimi 缓存优化：按平台选择缓存策略
    const payload: ChatCompletionsRequest = {
      model,
      messages: this.formatMessagesForChatCompletions(messages, disableSystemPrompt),
      stream,
    };

    //  Moonshot 官方：prompt_cache_key（自动前缀缓存需要此 key 关联）
    //  百炼：不传 prompt_cache_key（百炼不认，用 cache_control 替代）
    if (this.cacheStrategy === 'moonshot_auto') {
      payload.prompt_cache_key = this.sessionId || undefined;
    }
    // 百炼的 cache_control 已在 formatMessagesForChatCompletions 中注入到 system message

    if (!this.isK25Model(model)) {
      payload.temperature = temperature;
    } else {
      /* per-call thinking 优先于 instance default (setKimiThinking / KIMI_THINKING env).
       * side-agent 传 { type:'disabled' } 不污染主 agent 的 instance state. */
      payload.thinking = thinking ?? { type: this.resolveThinkingType() };
    }

    /* Kimi thinking 模型使用 4000 的默认输出预算；调用方显式值优先。 */
    const effectiveMaxTokens = maxInputTokens ?? (this.isK25Model(model) ? 4000 : undefined);
    if (effectiveMaxTokens !== undefined) {
      payload.max_tokens = effectiveMaxTokens;
    }

    const mappedTools = this.mapTools(tools);
    if (mappedTools && mappedTools.length > 0) {
      //  工具排序稳定化：按 name 排序，确保前缀缓存不被工具顺序变化打破
      payload.tools = [...mappedTools].sort((a, b) => a.function.name.localeCompare(b.function.name));
    }

    if (structuredOutput) {
      payload.response_format = { type: 'json_object' };
    }

    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    dumpLlmPayloadIfEnabled('kimi', payload);
    return payload;
  }

  private normalizeUsage(rawUsage: any): TokenUsage {
    const usage = rawUsage || {};

    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cached_tokens: usage.cached_tokens,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_write_input_tokens: usage.cache_write_input_tokens,
      prompt_tokens_details: usage.prompt_tokens_details,
      completion_tokens_details: usage.completion_tokens_details,
    };
  }

  private normalizeChatResponse(raw: any): ChatCompletionResponse {
    const choices = Array.isArray(raw?.choices) ? raw.choices : [];

    if (choices.length === 0) {
      throw new Error('Kimi returned empty choices');
    }

    const first = choices[0] || {};
    const message = first.message || {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall: any) => this.normalizeToolCall(toolCall))
      : undefined;

    /* Kimi K2.5 字段叫 reasoning_content, K2.6+ 改成 reasoning (breaking change).
     * adapter 内部统一 normalize 成 reasoning_content, 上游 runner / SessionContext 不需感知差异. */
    const rc = message.reasoning_content ?? message.reasoning ?? null;
    return {
      id: raw?.id || `kimi-${Date.now()}`,
      choices: [{
        message: {
          role: 'assistant',
          content: message.content ?? null,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(rc ? { reasoning_content: rc } : {}),
        },
        finish_reason: first.finish_reason || 'stop',
      }],
      usage: this.normalizeUsage(raw?.usage),
    };
  }

  /**
   * 标准化单个 tool_call
   * - $web_search → web_search (映射回 Neox 内部名称)
   * - 记录搜索 token 消耗
   * - 标记 __kimi_builtin 以便 runner 层特殊处理
   */
  private normalizeToolCall(toolCall: any): any {
    const rawName = toolCall?.function?.name || '';
    const rawArgs = toolCall?.function?.arguments || '{}';
    const neoxName = KIMI_BUILTIN_TOOL_MAP[rawName] || rawName;
    const isBuiltin = rawName in KIMI_BUILTIN_TOOL_MAP;

    // 记录 $web_search 的搜索结果 token 消耗
    if (isBuiltin && rawName === '$web_search') {
      try {
        const parsed = JSON.parse(rawArgs);
        const searchTokens = parsed?.usage?.total_tokens;
        if (searchTokens) {
          cliLogger.info('Kimi', `🔍 $web_search consumed ${searchTokens} tokens (search results)`);
        }
      } catch { /* ignore parse errors */ }
    }

    return {
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: neoxName,
        arguments: rawArgs,
      },
      // 标记这是 Kimi 内置工具，runner 层收到后直接返回 arguments
      ...(isBuiltin ? { __kimi_builtin: true, __kimi_original_name: rawName } : {}),
    };
  }

  private normalizeStreamChunk(chunk: any): any {
    if (!chunk || typeof chunk !== 'object') {
      return {
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
    }

    if (chunk.usage) {
      chunk.usage = this.normalizeUsage(chunk.usage);
    }

    if (!Array.isArray(chunk.choices)) {
      return {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
    }

    //  Remap Kimi builtin tool names in stream deltas
    for (const choice of chunk.choices) {
      const delta = choice?.delta;
      if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc?.function?.name && tc.function.name in KIMI_BUILTIN_TOOL_MAP) {
            // 记录原始名称，标记为 builtin
            tc.__kimi_builtin = true;
            tc.__kimi_original_name = tc.function.name;
            tc.function.name = KIMI_BUILTIN_TOOL_MAP[tc.function.name];
          }
        }
      }
      /* K2.6 把 reasoning_content 改名 reasoning. 在 delta 层统一 normalize 成 reasoning_content,
       * 上层 (runner.ts) 不需感知 model id 差异. */
      if (delta && !delta.reasoning_content && typeof delta.reasoning === 'string') {
        delta.reasoning_content = delta.reasoning;
        delete delta.reasoning;
      }
    }

    return chunk;
  }

  setKimiThinking(type: 'enabled' | 'disabled'): void {
    process.env.KIMI_THINKING = type;
    cliLogger.info('Kimi', `Thinking mode set to: ${type}`);
  }
}
