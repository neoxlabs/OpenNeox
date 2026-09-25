/**
 * Short-term memory system for managing conversation history
 *
 * 核心设计：区分「执行确认」和「推理信息」
 * - Ephemeral: 执行确认型，不进入长期上下文（write_file, edit_file...）
 * - Contextual: 信息供给型，进入上下文（readfile, grep...）
 * - Summarized: 摘要型，压缩后进入上下文（test, build...）
 */

import type { Message } from '../types/index.js';
import {
  ToolResultType,
  type ToolResult,
  getResultForLLM,
} from '../core/types/toolResult.js';
import { getToolResultType } from '../core/toolClassification.js';
import {
  extractToolImages,
  extractToolImageText, buildImageToolSummaryText,
  buildImageAttachmentMessage,
} from '../utils/imageToolResult.js';
import { cliLogger } from '../platform/cliLogger.js';

/**
 * 带元数据的消息
 */
interface MessageWithMeta extends Message {
  /** 工具结果分类 */
  _resultType?: ToolResultType;
  /** 工具名称 */
  _toolName?: string;
  /** 时间戳 */
  _timestamp?: number;
  /** 估算的 token 数 */
  _estimatedTokens?: number;
  /** 内部标签（用于系统消息替换） */
  _tag?: string;
}

// Ephemeral 消息的有效期（60秒后清理）
const EPHEMERAL_TTL = 60 * 1000;

/**
 * 估算字符串的 token 数
 * 基于 OpenAI tiktoken 的经验值：
 * - 英文: ~4 chars/token (0.25 tokens/char)
 * - CJK: ~1.5 chars/token (0.67 tokens/char)
 */
function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    // CJK characters (Chinese, Japanese, Korean)
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)) {
      tokens += 0.67;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * 上下文健康状态
 */
export interface ContextHealth {
  /** 总 token 数 */
  totalTokens: number;
  /** 工具结果 token 数 */
  toolResultTokens: number;
  /** 工具结果占比 */
  toolResultRatio: number;
  /** 消息数量 */
  messageCount: number;
  /** 工具消息数量 */
  toolMessageCount: number;
  /** 警告信息 */
  warnings: string[];
  /** 是否应该压缩 */
  shouldCompress: boolean;
  /** 是否应该清理 */
  shouldCleanup: boolean;
  /** 分类统计 */
  byType: {
    ephemeral: { count: number; tokens: number };
    contextual: { count: number; tokens: number };
    summarized: { count: number; tokens: number };
    other: { count: number; tokens: number };
  };
}

/**
 * 消息条数上限是保险丝，不是常规的上下文约束。上下文容量由 token 预算和自动压缩控制；
 * 条数上限只在压缩停用或异常时阻止进程无界增长。上限必须显著高于压缩阈值，避免每轮删除
 * 一条消息而持续改变前缀，破坏上游的前缀缓存。
 */
export const MEMORY_BACKSTOP_MESSAGES = 20_000;

/** 保险丝触发后一次砍到这个比例 —— 见 safeTrimMessages 上方注释 (批量扔, 不要每轮扔)。 */
const TRIM_TO_RATIO = 0.7;

export class ShortTermMemory {
  private messages: MessageWithMeta[] = [];
  private maxMessages: number;

  /**
   *  增量持久化 hook —— 每次添加消息后触发。
   * 用于 AgentRuntimeHost 订阅并 debounce-flush 到 SQLite,
   * 避免"只在 turn 完成时才持久化"导致 ui:dev rebuild / 进程崩溃时丢整轮对话。
   */
  private onMessageAddedListeners: Array<(role: Message['role']) => void> = [];

  constructor(maxMessages: number = MEMORY_BACKSTOP_MESSAGES) {
    this.maxMessages = maxMessages;
  }

  /** 订阅消息新增事件;返回取消订阅函数 */
  onMessageAdded(listener: (role: Message['role']) => void): () => void {
    this.onMessageAddedListeners.push(listener);
    return () => {
      this.onMessageAddedListeners = this.onMessageAddedListeners.filter(l => l !== listener);
    };
  }

  private emitMessageAdded(role: Message['role']): void {
    for (const listener of this.onMessageAddedListeners) {
      try { listener(role); } catch { /* listener 内部错误不应该影响 memory 主路径 */ }
    }
  }

  /**
   *  安全裁切消息：确保 tool_call/tool_result 配对不被破坏
   *
   * OpenAI/Claude/MiniMax 等 API 要求：
   * 每个 assistant 消息中的 tool_calls 必须有对应的 tool role 消息
   * 如果裁切时把 tool result 切掉了但保留了 assistant(tool_calls)，API 会返回 400
   */
  private safeTrimMessages(messages: MessageWithMeta[], maxCount: number): MessageWithMeta[] {
    if (messages.length <= maxCount) return messages;

    // 第一步：按数量初步裁切
    let trimmed = messages.slice(-maxCount);

    // 第二步：检查裁切后的第一个消息是否是 orphaned tool result
    // 如果是，向后跳过直到找到非 tool 消息
    while (trimmed.length > 0 && trimmed[0].role === 'tool') {
      trimmed = trimmed.slice(1);
    }

    // 第三步：检查开头的 assistant(tool_calls) 是否有完整的 tool results
    if (trimmed.length > 0 && trimmed[0].role === 'assistant' && trimmed[0].tool_calls?.length) {
      const expectedToolCallIds = new Set(
        trimmed[0].tool_calls
          .filter((tc): tc is NonNullable<typeof tc> => !!tc && typeof (tc as any).id === 'string')
          .map(tc => tc.id as string),
      );
      // 检查后续消息中是否存在所有的 tool result
      const foundToolCallIds = new Set<string>();
      for (let i = 1; i < trimmed.length; i++) {
        if (trimmed[i].role === 'tool' && trimmed[i].tool_call_id) {
          foundToolCallIds.add(trimmed[i].tool_call_id!);
        }
        // 遇到下一个 user/assistant 消息就停止搜索
        if (trimmed[i].role === 'user' || (trimmed[i].role === 'assistant' && i > 0)) {
          break;
        }
      }
      // 如果有缺失的 tool result，删掉这个不完整的 assistant 消息
      const allFound = [...expectedToolCallIds].every(id => foundToolCallIds.has(id));
      if (!allFound) {
        cliLogger.warn('MEMORY', 'safeTrimMessages: Dropping incomplete assistant(tool_calls) at boundary', {
          expectedIds: [...expectedToolCallIds],
          foundIds: [...foundToolCallIds],
        });
        // 跳过这个 assistant 及其 orphaned tool results
        let skipUntil = 1;
        while (skipUntil < trimmed.length && trimmed[skipUntil].role === 'tool') {
          skipUntil++;
        }
        trimmed = trimmed.slice(skipUntil);
      }
    }

    return trimmed;
  }

  /**
   * 添加普通消息
   */
  add(message: Message): void {
    // 估算 token 数
    const contentStr = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    const tokens = estimateTokens(contentStr);

    /* 相同内容的 system 消息保持幂等，避免重复占用上下文并改变缓存前缀。
     * 内容不同的 system 消息仍可用于补充 prompt 或动态区段。 */
    if (message.role === 'system'
        && typeof message.content === 'string'
        && this.messages.some(m => m.role === 'system' && m.content === message.content)) {
      cliLogger.warn('MEMORY', '[DUP_SYSTEM] identical system message re-added — skipped', {
        chars: message.content.length,
        stack: (new Error('dup-system-trace').stack || '').split('\n').slice(2, 7).join(' | '),
      });
      return;
    }

    const messageWithMeta: MessageWithMeta = {
      ...message,
      _timestamp: Date.now(),
      _estimatedTokens: tokens,
    };
    this.messages.push(messageWithMeta);

    //  DEBUG: 追踪 assistant 消息的 tool_calls ID
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('MEMORY', 'Assistant message with tool_calls added:', {
          toolCallCount: message.tool_calls.length,
          toolCallIds: message.tool_calls
            .filter((tc): tc is NonNullable<typeof tc> => !!tc?.function)
            .map(tc => ({ id: tc.id, name: tc.function.name })),
        });
      }
    }

    // Trim old messages if exceeding max
    if (this.messages.length > this.maxMessages) {
      // Keep system message if it exists, then keep last N messages
      const systemMessages = this.messages.filter(m => m.role === 'system');
      const otherMessages = this.messages.filter(m => m.role !== 'system');
      //  FIX: Use safe trimming that preserves tool_call/tool_result pairs
      /* 批量砍, 不要每轮砍一条 —— 每轮砍一条 = 每轮前缀都变 = 缓存永远建不起来。
         一次砍到 70%, 之后几百轮前缀纹丝不动, 全程高命中。 */
      const target = Math.max(1, Math.floor(this.maxMessages * TRIM_TO_RATIO) - systemMessages.length);
      const trimmedOthers = this.safeTrimMessages(otherMessages, target);

      this.messages = [...systemMessages, ...trimmedOthers];
    }

    this.emitMessageAdded(message.role);
  }

  /**
   *   前缀缓存根治: 瞬时督导 nudge (EFFICIENCY TIP / reasoning / repair) 顺序追加。
   *
   *   临时提示追加到对话尾部。Anthropic adapter 会把所有 system 消息合并为顶层 system 块，
   *   动态提示放入该块会使整个缓存前缀随提示变化；尾部追加只影响缓存断点之后的新内容。
   *   追加策略如下:
   *     - 末尾是 tool/user 且 string content → 直接拼到该消息尾部 (最优, 不新增消息);
   *     - 否则 (assistant / 数组 content) → 退化为独立 user 消息 (仍在尾部)。
   *   一律**不进 system 块**。role 一律非 system。
   */
  appendReminder(text: string): void {
    if (!text) return;
    const trimmed = text.trim();
    const wrapped = trimmed.startsWith('<system-reminder>')
      ? trimmed
      : `<system-reminder>\n${trimmed}\n</system-reminder>`;
    const last = this.messages[this.messages.length - 1];
    if (last && (last.role === 'tool' || last.role === 'user') && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${wrapped}`;
      last._estimatedTokens = estimateTokens(last.content);
      // 就地追加, 不新增消息 → 不触发 emitMessageAdded (UI 不该冒新气泡)
      return;
    }
    this.add({ role: 'user', content: wrapped });
  }

  /**
   * 添加工具结果（根据工具类型分类处理）
   *
   *  Ephemeral: 只保留简化的状态信息，标记为可清理
   *  Contextual: 完整保留
   *  Summarized: 压缩后保留
   */
  addToolResult(
    toolCallId: string,
    toolName: string,
    rawOutput: string,
  ): void {
    /* 图片结果协议 (__NEOX_IMAGE_RESULT__) — readfile 读图/PDF转页/浏览器截图/
     * computer_snapshot(axBlind) 走这里。外壳可能是 Contextual ToolResult JSON,
     * 真图在 content 里。tool 消息只放文本摘要, 真图片作为合成 user 消息紧随注入。 */
    const toolImages = extractToolImages(rawOutput);
    if (toolImages) {
      const summary = buildImageToolSummaryText(toolName, toolImages, extractToolImageText(rawOutput));
      this.messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: toolName,
        content: summary,
        _resultType: ToolResultType.CONTEXTUAL,
        _toolName: toolName,
        _timestamp: Date.now(),
        _estimatedTokens: estimateTokens(summary),
      });
      this.emitMessageAdded('tool');
      this.add(buildImageAttachmentMessage(toolName, toolImages));
      cliLogger.info('MEMORY', `addToolResult: ${toolName} returned ${toolImages.length} image(s) — injected as attachment message`);
      return;
    }

    const resultType = getToolResultType(toolName);

    // 尝试解析工具返回的 JSON
    let parsedResult: ToolResult | null = null;
    try {
      const parsed = JSON.parse(rawOutput);
      // 检查是否是新格式的 ToolResult
      if (parsed.type && parsed.status && parsed.summary) {
        parsedResult = parsed as ToolResult;
      }
    } catch {
      // 不是 JSON，使用原始输出
    }

    let content: string;
    let effectiveResultType = resultType;

    if (parsedResult) {
      /** 使用解析后的结果类型（工具自己声明的类型优先） **/
      effectiveResultType = parsedResult.type as ToolResultType || resultType;

      /** 使用 getResultForLLM 生成适合 LLM 的精简结果 **/
      content = getResultForLLM(parsedResult);

      /* 解析结果只在 debug 日志中记录有限预览，避免常规日志构造和写入完整工具输出。 */
      cliLogger.debug('MEMORY', `addToolResult: ${toolName} parsed as ToolResult`, {
        resultType: effectiveResultType,
        contentPreview: content.substring(0, 300),
        rawLength: rawOutput.length,
        contentLength: content.length,
      });

    } else {
      // 旧格式：直接使用原始输出
      content = rawOutput;

      //  DEBUG: 追踪原始输出
      cliLogger.debug('MEMORY', `addToolResult: ${toolName} using raw output`, {
        rawOutput: rawOutput.substring(0, 500),
        rawLength: rawOutput.length,
      });
    }

    const messageWithMeta: MessageWithMeta = {
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content,
      _resultType: effectiveResultType,
      _toolName: toolName,
      _timestamp: Date.now(),
      _estimatedTokens: estimateTokens(content),
    };

    //  DEBUG: 追踪 tool 消息的 tool_call_id
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('MEMORY', 'Tool result message added:', {
        toolName,
        toolCallId,
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
      });
    }

    this.messages.push(messageWithMeta);

    // Trim old messages if exceeding max
    if (this.messages.length > this.maxMessages) {
      const systemMessages = this.messages.filter(m => m.role === 'system');
      const otherMessages = this.messages.filter(m => m.role !== 'system');
      //  FIX: Use safe trimming that preserves tool_call/tool_result pairs
      /* 同上: 批量砍到 70%, 保住前缀缓存 */
      const target2 = Math.max(1, Math.floor(this.maxMessages * TRIM_TO_RATIO) - systemMessages.length);
      const trimmedOthers = this.safeTrimMessages(otherMessages, target2);
      this.messages = [...systemMessages, ...trimmedOthers];
    }

    this.emitMessageAdded('tool');
  }

  /**
   * 剥离消息中的内部元数据，返回干净的 Message
   * Strip internal metadata from message, return clean Message for API
   */
  private stripMetadata(msg: MessageWithMeta): Message {
    const { _resultType, _toolName, _timestamp, _estimatedTokens, _tag, ...cleanMessage } = msg;
    return cleanMessage as Message;
  }

  /**
   * 获取所有消息（剥离内部元数据，用于发送给 LLM）
   * Get all messages (stripped of internal metadata, for sending to LLM)
   */
  getAll(): Message[] {
    return this.messages.map(msg => this.stripMetadata(msg));
  }

  /**
   * 获取带元数据的原始消息（仅用于内部统计）
   * Get raw messages with metadata (for internal statistics only)
   */
  private getRawMessages(): MessageWithMeta[] {
    return this.messages;
  }

  /**
   * 获取发送给 LLM 的消息
   * 剥离内部元数据
   *
   *  CRITICAL FIX: 不再过滤 EPHEMERAL 类型的 tool 消息！
   *
   * OpenAI Responses API 要求每个 function_call 必须有对应的 function_call_output，
   * 否则会返回 400 错误："No tool output found for function call xxx"
   *
   * EPHEMERAL 类型只是一个分类标记（用于UI展示或统计），不应该影响消息历史的完整性。
   */
  getMessagesForLLM(): Message[] {
    //  FIX: 移除 EPHEMERAL 过滤逻辑，直接返回所有消息（剥离元数据）
    const filteredMessages = this.messages.map(msg => this.stripMetadata(msg));

    //  CRITICAL FIX: Last-line-of-defense validation
    // Ensure all assistant(tool_calls) have matching tool results
    // Remove any orphaned messages to prevent API 400 errors
    const validated = this.validateToolCallPairing(filteredMessages);

    //  DEBUG: 追踪返回给 LLM 的消息列表
    if (process.env.CLI_DEBUG === '1') {
      const assistantMsgs = validated.filter(m => m.role === 'assistant');
      const toolMsgs = validated.filter(m => m.role === 'tool');

      cliLogger.debug('MEMORY', 'Messages for LLM:', {
        totalMessages: validated.length,
        assistantCount: assistantMsgs.length,
        toolCount: toolMsgs.length,
        droppedByValidation: filteredMessages.length - validated.length,
        messageSequence: validated.map(m => m.role).join(' -> '),
      });

      // 追踪最后几条消息的详细信息
      const lastMessages = validated.slice(-5);
      lastMessages.forEach((msg, idx) => {
        if (msg.role === 'assistant' && msg.tool_calls) {
          cliLogger.debug('MEMORY', `Message ${validated.length - 5 + idx} (assistant):`, {
            toolCalls: msg.tool_calls
              .filter((tc): tc is NonNullable<typeof tc> => !!tc?.function)
              .map(tc => ({ id: tc.id, name: tc.function.name }))
          });
        } else if (msg.role === 'tool') {
          cliLogger.debug('MEMORY', `Message ${validated.length - 5 + idx} (tool):`, {
            name: msg.name,
            tool_call_id: msg.tool_call_id,
            contentLength: typeof msg.content === 'string' ? msg.content.length : 0
          });
        }
      });
    }

    return validated;
  }

  /**
   *  验证 tool_call/tool_result 配对完整性
   *
   * 规则：
   * 1. 每个 assistant.tool_calls[].id 必须有对应的 tool.tool_call_id
   * 2. 每个 tool.tool_call_id 必须能找到对应的 assistant.tool_calls[].id
   * 3. 不满足条件的消息组被整体移除
   */
  private validateToolCallPairing(messages: Message[]): Message[] {
    // 第一遍：收集所有 tool_call_id 和 tool result 的 tool_call_id
    const toolCallIdsByMsgIdx = new Map<number, Set<string>>();  // assistant msg index → tool_call_ids
    const toolResultIdToMsgIdx = new Map<string, number>();  // tool_call_id → tool msg index

    // 顺手 densify 历史里的稀疏/null tool_calls (旧 session 残留)
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const dense = msg.tool_calls.filter(
          (tc): tc is NonNullable<typeof tc> =>
            !!tc && typeof tc === 'object' && !!(tc as any).function,
        );
        if (dense.length !== msg.tool_calls.length) {
          cliLogger.warn('MEMORY',
            `validateToolCallPairing: densified sparse/null tool_calls at msg[${i}] ${msg.tool_calls.length} → ${dense.length}`);
          msg.tool_calls = dense.length > 0 ? dense : undefined;
        }
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const ids = new Set(
          msg.tool_calls
            .filter((tc): tc is NonNullable<typeof tc> => !!tc && typeof tc === 'object')
            .map(tc => tc.id)
            .filter((id): id is string => typeof id === 'string' && !!id),
        );
        if (ids.size > 0) toolCallIdsByMsgIdx.set(i, ids);
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIdToMsgIdx.set(msg.tool_call_id, i);
      }
    }

    // 第二遍：标记需要删除的消息
    const indicesToRemove = new Set<number>();

    for (const [assistantIdx, expectedIds] of toolCallIdsByMsgIdx) {
      //  CRITICAL: 跳过消息列表中最后一条 assistant(tool_calls)
      // 对于 ask_user 等需要用户输入的工具，tool_result 在执行时还没有到达。
      // 如果此时删掉 assistant 消息，后来 tool_result 到达时就会变成 orphan，
      // 导致下一轮 API 调用因为 tool_call/tool_result 不匹配而 400 错误。
      const isLastAssistant = assistantIdx === Math.max(...toolCallIdsByMsgIdx.keys());
      if (isLastAssistant) {
        // 最后一条 assistant 消息可能正在等工具执行完成，跳过验证
        continue;
      }

      const missingIds: string[] = [];
      for (const id of expectedIds) {
        if (!toolResultIdToMsgIdx.has(id)) {
          missingIds.push(id);
        }
      }
      if (missingIds.length > 0) {
        cliLogger.warn('MEMORY', 'validateToolCallPairing: Removing orphaned assistant(tool_calls)', {
          messageIndex: assistantIdx,
          missingToolCallIds: missingIds,
          totalToolCalls: expectedIds.size,
        });
        // 移除 assistant 消息
        indicesToRemove.add(assistantIdx);
        // 移除它已有的 tool results（它们没有 assistant 了也是 orphan）
        for (const id of expectedIds) {
          const toolIdx = toolResultIdToMsgIdx.get(id);
          if (toolIdx !== undefined) {
            indicesToRemove.add(toolIdx);
          }
        }
      }
    }

    // 检查 orphaned tool results（有 tool_call_id 但找不到 assistant）
    for (const [toolCallId, toolIdx] of toolResultIdToMsgIdx) {
      let hasMatchingAssistant = false;
      for (const [, ids] of toolCallIdsByMsgIdx) {
        if (ids.has(toolCallId)) {
          hasMatchingAssistant = true;
          break;
        }
      }
      if (!hasMatchingAssistant) {
        cliLogger.warn('MEMORY', 'validateToolCallPairing: Removing orphaned tool result', {
          messageIndex: toolIdx,
          toolCallId,
        });
        indicesToRemove.add(toolIdx);
      }
    }

    if (indicesToRemove.size > 0) {
      cliLogger.warn('MEMORY', `validateToolCallPairing: Removed ${indicesToRemove.size} orphaned messages`);
      return messages.filter((_, idx) => !indicesToRemove.has(idx));
    }

    return messages;
  }

  /**
   * 是否已有对话内容（用户或助手消息）
   */
  hasConversationMessages(): boolean {
    return this.messages.some(msg => msg.role === 'user' || msg.role === 'assistant');
  }

  /**
   * 插入或更新带标签的 system 消息（用于记忆注入）
   */
  upsertSystemTagged(tag: string, content: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      this.removeSystemTagged(tag);
      return;
    }

    const existingIndex = this.messages.findIndex(
      msg => msg.role === 'system' && msg._tag === tag
    );
    if (existingIndex >= 0) {
      const existing = this.messages[existingIndex];
      if (existing.content === trimmed) {
        return;
      }
      this.messages[existingIndex] = {
        ...existing,
        content: trimmed,
        _timestamp: Date.now(),
        _estimatedTokens: estimateTokens(trimmed),
      };
      return;
    }

    const message: MessageWithMeta = {
      role: 'system',
      content: trimmed,
      _tag: tag,
      _timestamp: Date.now(),
      _estimatedTokens: estimateTokens(trimmed),
    };

    const insertAt = this.getSystemInsertIndex();
    this.messages = [
      ...this.messages.slice(0, insertAt),
      message,
      ...this.messages.slice(insertAt),
    ];
  }

  /**
   * 移除带标签的 system 消息
   */
  removeSystemTagged(tag: string): void {
    const before = this.messages.length;
    this.messages = this.messages.filter(
      msg => !(msg.role === 'system' && msg._tag === tag)
    );
    if (before !== this.messages.length && process.env.CLI_DEBUG === '1') {
      cliLogger.debug('MEMORY', `Removed system tag: ${tag}`);
    }
  }

  private getSystemInsertIndex(): number {
    let idx = 0;
    while (idx < this.messages.length && this.messages[idx].role === 'system') {
      idx += 1;
    }
    return idx;
  }

  /**
   * 清理过期的 ephemeral 消息
   * @returns 清理的消息数量
   */
  cleanupEphemeral(): number {
    const before = this.messages.length;
    const toolCallIds = new Set<string>();

    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const call of msg.tool_calls) {
          if (call.id) {
            toolCallIds.add(call.id);
          }
        }
      }
    }

    this.messages = this.messages.filter(msg => {
      // 保留非 ephemeral 消息
      if (msg._resultType !== ToolResultType.EPHEMERAL) {
        return true;
      }
      if (msg.role !== 'tool') {
        return true;
      }
      if (!msg.tool_call_id) {
        return true;
      }
      // 保留仍有对应 tool_call 的结果，避免历史不匹配
      return toolCallIds.has(msg.tool_call_id);
    });

    return before - this.messages.length;
  }

  /**
   * 获取内存统计（基础版）
   */
  getStats(): {
    total: number;
    ephemeral: number;
    contextual: number;
    summarized: number;
    other: number;
  } {
    const stats = {
      total: this.messages.length,
      ephemeral: 0,
      contextual: 0,
      summarized: 0,
      other: 0,
    };

    for (const msg of this.messages) {
      if (msg._resultType === ToolResultType.EPHEMERAL) {
        stats.ephemeral++;
      } else if (msg._resultType === ToolResultType.CONTEXTUAL) {
        stats.contextual++;
      } else if (msg._resultType === ToolResultType.SUMMARIZED) {
        stats.summarized++;
      } else {
        stats.other++;
      }
    }

    return stats;
  }

  /**
   * 检查上下文健康状态（完整版）
   * 包含 token 估算和警告
   */
  checkContextHealth(): ContextHealth {
    const byType = {
      ephemeral: { count: 0, tokens: 0 },
      contextual: { count: 0, tokens: 0 },
      summarized: { count: 0, tokens: 0 },
      other: { count: 0, tokens: 0 },
    };

    let totalTokens = 0;
    let toolResultTokens = 0;
    let toolMessageCount = 0;

    for (const msg of this.messages) {
      const tokens = msg._estimatedTokens || estimateTokens(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      );
      totalTokens += tokens;

      if (msg.role === 'tool') {
        toolMessageCount++;
        toolResultTokens += tokens;

        if (msg._resultType === ToolResultType.EPHEMERAL) {
          byType.ephemeral.count++;
          byType.ephemeral.tokens += tokens;
        } else if (msg._resultType === ToolResultType.CONTEXTUAL) {
          byType.contextual.count++;
          byType.contextual.tokens += tokens;
        } else if (msg._resultType === ToolResultType.SUMMARIZED) {
          byType.summarized.count++;
          byType.summarized.tokens += tokens;
        } else {
          byType.other.count++;
          byType.other.tokens += tokens;
        }
      } else {
        byType.other.count++;
        byType.other.tokens += tokens;
      }
    }

    const ratio = totalTokens > 0 ? toolResultTokens / totalTokens : 0;
    const warnings: string[] = [];

    // 警告条件
    if (ratio > 0.5) {
      warnings.push(`Tool results占用 ${(ratio * 100).toFixed(1)}% 的上下文（超过50%警戒线）`);
    } else if (ratio > 0.4) {
      warnings.push(`Tool results占用 ${(ratio * 100).toFixed(1)}% 的上下文（接近警戒线）`);
    }

    if (totalTokens > 180000) {
      warnings.push(`上下文已达 ${totalTokens} tokens（超过180k，建议清理）`);
    } else if (totalTokens > 150000) {
      warnings.push(`上下文已达 ${totalTokens} tokens（接近180k）`);
    }

    if (toolMessageCount > 100) {
      warnings.push(`工具调用历史过长（${toolMessageCount} 条）`);
    } else if (toolMessageCount > 60) {
      warnings.push(`工具调用历史较长（${toolMessageCount} 条）`);
    }

    if (byType.ephemeral.count > 10) {
      warnings.push(`积累了 ${byType.ephemeral.count} 条 ephemeral 消息，建议清理`);
    }

    return {
      totalTokens,
      toolResultTokens,
      toolResultRatio: ratio,
      messageCount: this.messages.length,
      toolMessageCount,
      warnings,
      shouldCompress: ratio > 0.3 || totalTokens > 120000,
      shouldCleanup: totalTokens > 150000 || byType.ephemeral.count > 5,
      byType,
    };
  }

  /**
   * 获取 token 统计摘要（用于日志）
   */
  getTokenSummary(): string {
    const health = this.checkContextHealth();
    const parts = [
      `Total: ${health.totalTokens} tokens`,
      `Tool: ${health.toolResultTokens} (${(health.toolResultRatio * 100).toFixed(1)}%)`,
      `Messages: ${health.messageCount}`,
    ];

    if (health.byType.ephemeral.count > 0) {
      parts.push(`Ephemeral: ${health.byType.ephemeral.count}`);
    }

    return parts.join(' | ');
  }

  /**
   * 计算内存占用大小（估算）
   *  NEW: Calculate memory footprint in KB
   */
  getMemoryFootprint(): {
    totalKB: number;
    messagesKB: number;
    messageCount: number;
    averageKBPerMessage: number;
  } {
    // 计算所有消息的 JSON 序列化大小
    const messagesStr = JSON.stringify(this.messages);
    const messageSizeBytes = new Blob([messagesStr]).size;
    const messageSizeKB = Math.round((messageSizeBytes / 1024) * 10) / 10;

    // 估算对象本身的开销（元数据、指针等）
    // 每条消息的元数据开销约 100-200 字节
    const metadataOverheadBytes = this.messages.length * 150;
    const totalBytes = messageSizeBytes + metadataOverheadBytes;
    const totalKB = Math.round((totalBytes / 1024) * 10) / 10;

    return {
      totalKB,
      messagesKB: messageSizeKB,
      messageCount: this.messages.length,
      averageKBPerMessage: this.messages.length > 0
        ? Math.round((totalKB / this.messages.length) * 10) / 10
        : 0,
    };
  }

  /**
   * 打印详细的内存和上下文统计
   *  NEW: Log comprehensive memory stats
   */
  logMemoryStats(): void {
    const health = this.checkContextHealth();
    const footprint = this.getMemoryFootprint();

    cliLogger.info('MEMORY_STATS', 'ShortTermMemory snapshot', {
      // 内存占用
      memoryTotalKB: footprint.totalKB,
      memoryMessagesKB: footprint.messagesKB,
      avgKBPerMessage: footprint.averageKBPerMessage,

      // Token 统计
      totalTokens: health.totalTokens,
      toolResultTokens: health.toolResultTokens,
      toolResultRatio: `${(health.toolResultRatio * 100).toFixed(1)}%`,

      // 消息数量
      messageCount: health.messageCount,
      toolMessageCount: health.toolMessageCount,
      maxMessages: this.maxMessages,

      // 分类统计
      byType: {
        ephemeral: `${health.byType.ephemeral.count} msgs, ${health.byType.ephemeral.tokens} tokens`,
        contextual: `${health.byType.contextual.count} msgs, ${health.byType.contextual.tokens} tokens`,
        summarized: `${health.byType.summarized.count} msgs, ${health.byType.summarized.tokens} tokens`,
        other: `${health.byType.other.count} msgs, ${health.byType.other.tokens} tokens`,
      },

      // 警告
      warnings: health.warnings.length > 0 ? health.warnings : ['None'],
      shouldCompress: health.shouldCompress,
      shouldCleanup: health.shouldCleanup,
    });
  }

  clear(): void {
    // Keep system messages only
    const systemMessages = this.messages.filter(m => m.role === 'system');
    this.messages = systemMessages;
  }

  setMessages(messages: Message[]): void {
    const incoming = Array.isArray(messages) ? messages : [];
    const systemMessages = incoming.filter(m => m.role === 'system');
    const otherMessages = incoming.filter(m => m.role !== 'system');

    /* 系统消息的内部标签可能在发送给模型的清理流程中被移除。系统消息内容在压缩链中
     * 保持不变，因此恢复状态时通过内容重新识别标签，让后续更新继续复用原位置。 */
    const tagByContent = new Map<string, string>();
    for (const msg of this.messages) {
      if (msg.role === 'system' && msg._tag) {
        tagByContent.set(String(msg.content ?? ''), msg._tag);
      }
    }
    const restoreTag = (m: Message): MessageWithMeta => {
      const tag = tagByContent.get(String(m.content ?? ''));
      return tag ? ({ ...m, _tag: tag } as MessageWithMeta) : (m as MessageWithMeta);
    };
    const maxOthers = Math.max(0, this.maxMessages - systemMessages.length);
    //  FIX: Use safe trimming that preserves tool_call/tool_result pairs
    const trimmedOthers = maxOthers > 0 ? this.safeTrimMessages(
      otherMessages.map(m => ({ ...m, _timestamp: Date.now() } as MessageWithMeta)),
      maxOthers
    ) : [];
    // 添加时间戳
    this.messages = [
      ...systemMessages.map(m => ({ ...restoreTag(m), _timestamp: Date.now() } as MessageWithMeta)),
      ...trimmedOthers,
    ];
  }

  get length(): number {
    return this.messages.length;
  }
}
