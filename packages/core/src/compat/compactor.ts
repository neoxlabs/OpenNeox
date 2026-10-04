import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompatProfile } from '@neoxlabs/kernel/types/compat.js';
import type { Message, LLMProvider } from '@neoxlabs/kernel/types/index.js';
import { getTextFromContent } from '@neoxlabs/kernel/utils/messageUtils.js';
import type { Session, TimestampedSessionItem, MessageItem } from '@neoxlabs/kernel/types/session.js';
import { widenKeepStartForPairedBlocks } from '@neoxlabs/kernel/core/toolPairPreserver.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const DEFAULT_SUMMARY_HEADER = '# 会话历史摘要';
const MAX_SUMMARY_LINES = 60;
const MAX_LINE_LENGTH = 200;
const COMPACTION_QUALITY_LOG_VERSION = 1;

// ============================================================================
// ============================================================================

const COMPACTION_SYSTEM_PROMPT = `You are a highly skilled assistant tasked with summarizing conversation history.

Your goal is to create a concise yet comprehensive summary that captures:
1. The main topics and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file paths, and technical details
4. Current state of any ongoing tasks
5. Any unresolved issues or next steps

Guidelines:
- Be specific about file names, function names, and code snippets when relevant
- Preserve technical accuracy - don't generalize away important details
- Maintain chronological flow of events when helpful
- Keep the summary under 2000 tokens while preserving critical information
- Write in the same language as the conversation (Chinese if Chinese, English if English)
- Format the summary clearly with sections if needed

Output only the summary, no additional commentary.`;

const COMPACTION_SYSTEM_PROMPT_ZH = `你是一个专业的对话历史总结助手。

你的目标是创建一个简洁但全面的摘要，需要包含：
1. 讨论的主要主题和目标
2. 做出的关键决策及其理由
3. 重要的代码变更、文件路径和技术细节
4. 任何正在进行的任务的当前状态
5. 任何未解决的问题或后续步骤

指南：
- 在相关时具体说明文件名、函数名和代码片段
- 保持技术准确性 - 不要概括掉重要细节
- 在有帮助时保持事件的时间顺序
- 将摘要控制在 2000 tokens 以内，同时保留关键信息
- 使用与对话相同的语言（中文对话用中文，英文对话用英文）
- 如果需要，使用分节来清晰地格式化摘要

只输出摘要，不要添加额外的评论。`;

function detectLanguage(messages: Message[]): 'zh' | 'en' {
  // 检测对话中是否包含中文
  for (const message of messages) {
    const text = getTextFromContent(message.content);
    if (/[\u4e00-\u9fa5]/.test(text)) {
      return 'zh';
    }
  }
  return 'en';
}

function buildCompactionPrompt(messages: Message[]): string {
  const conversationParts: string[] = [];

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'Assistant' :
                 message.role === 'user' ? 'User' :
                 message.role === 'tool' ? 'Tool Result' : message.role;

    const content = getTextFromContent(message.content);

    // 处理工具调用
    let toolInfo = '';
    if (message.tool_calls?.length) {
      const toolNames = message.tool_calls.map(tc => tc.function.name).join(', ');
      toolInfo = ` [Called tools: ${toolNames}]`;
    }

    if (content || toolInfo) {
      // 截断过长的内容
      const truncatedContent = content.length > 1000
        ? content.slice(0, 1000) + '...[truncated]'
        : content;
      conversationParts.push(`[${role}]${toolInfo}\n${truncatedContent}`);
    }
  }

  return `Please summarize the following conversation history:\n\n---\n${conversationParts.join('\n\n---\n')}\n---\n\nProvide a comprehensive summary:`;
}

function approxTokensForMessage(message: Message): number {
  const contentText = getTextFromContent(message.content);
  const contentLength = contentText.length;
  const toolPayload = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return Math.ceil((contentLength + toolPayload) / 4);
}

function approxTokensForItem(item: TimestampedSessionItem['item']): number {
  if (item.type === 'message') return approxTokensForMessage((item as MessageItem).data);
  if (item.type === 'tool_call') {
    const d = (item as any).data ?? {};
    return approxTokensForText(`${d.name ?? ''}${d.arguments ?? ''}`);
  }
  if (item.type === 'tool_result') {
    const d = (item as any).data ?? {};
    return approxTokensForText(`${d.name ?? ''}${d.result ?? ''}`);
  }
  /* meta / checkpoint / 快照这类是小项, 也不该被摘要吃掉 —— 按 0 计, 一律保留 */
  return 0;
}

function approxTokensForText(text: string): number {
  return Math.ceil((text.length || 0) / 4);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildSummaryText(messages: Message[], header: string): { summary: string; lines: number } {
  if (messages.length === 0) {
    return { summary: '', lines: 0 };
  }

  const lines: string[] = [];
  for (const message of messages) {
    if (lines.length >= MAX_SUMMARY_LINES) break;
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : message.role;
    const contentText = getTextFromContent(message.content);
    const content = contentText ? normalizeWhitespace(contentText) : '';
    const safeContent = content || (message.tool_calls?.length ? `Tool calls: ${message.tool_calls.map(tc => tc.function.name).join(', ')}` : 'No textual content');
    lines.push(`- [${role}] ${truncateText(safeContent, MAX_LINE_LENGTH)}`);
  }

  const summary = `${header}\n${lines.join('\n')}`;
  return { summary, lines: lines.length };
}

// ============================================================================
// LLM 智能压缩接口
// ============================================================================

export interface SmartCompactionOptions {
  session: Session;
  profile: CompatProfile;
  llmProvider: LLMProvider;
  model?: string;
  tailTokenBudget?: number;
  onProgress?: (stage: 'analyzing' | 'summarizing' | 'saving', detail?: string) => void;
  /** Timeout in milliseconds for LLM call (default: 60000 = 60s) */
  timeout?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface SmartCompactionResult {
  removedMessages: number;
  keptMessages: number;
  summaryText: string;
  estimatedTokensSaved: number;
  llmTokensUsed?: number;
  diagnostics?: SmartCompactionDiagnostics;
  detailedStats?: {
    before: {
      userTokens: number;
      assistantTokens: number;
      toolTokens: number;
      totalTokens: number;
    };
    after: {
      userTokens: number;
      assistantTokens: number;
      toolTokens: number;
      summaryTokens: number;
      totalTokens: number;
    };
    saved: {
      userTokens: number;
      assistantTokens: number;
      toolTokens: number;
      totalTokens: number;
    };
  };
}

export interface SmartCompactionDiagnostics {
  version: number;
  model?: string;
  language: 'zh' | 'en';
  contextWindow?: number;
  tailTokenBudget: number;
  minCompressibleTokens: number;
  messageCounts: {
    timelineMessages: number;
    systemMessages: number;
    nonSystemMessages: number;
    summarizedMessages: number;
    keptMessages: number;
    retainedMessagesIncludingSystem: number;
  };
  boundary: {
    keepStartInitial: number;
    keepStartAfterInvariant: number;
    invariantShift: number;
  };
  prompt: {
    systemPromptTokensApprox: number;
    userPromptChars: number;
    userPromptTokensApprox: number;
  };
  llm: {
    fallbackUsed: boolean;
    llmTokensUsed?: number;
    summaryChars: number;
    summaryTokensApprox: number;
  };
  tokens: {
    summarized: {
      user: number;
      assistant: number;
      tool: number;
      total: number;
    };
    keptTail: {
      user: number;
      assistant: number;
      tool: number;
      total: number;
    };
    afterEstimated: {
      tail: number;
      summary: number;
      total: number;
    };
    netSavedEstimated: number;
    compressionRatioEstimated: number;
  };
}

function isCompactionQualityLogEnabled(): boolean {
  return process.env.NEOX_COMPACTION_DEBUG === '1'
    || process.env.NEOX_DUMP_COMPACTION === '1';
}

export function dumpCompactionQualityIfEnabled(record: Record<string, unknown>): string | undefined {
  if (!isCompactionQualityLogEnabled()) return undefined;
  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs', 'compaction-quality');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `compaction-quality-${day}.jsonl`);
    const payload = {
      version: COMPACTION_QUALITY_LOG_VERSION,
      timestamp: new Date().toISOString(),
      ...record,
    };
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    // eslint-disable-next-line no-console
    console.error(`[COMPACTION_QUALITY] ${file}`);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * LLM 智能压缩 - 使用 AI 生成高质量的上下文摘要
 * 类似 Claude Code 的实现
 */
export async function smartCompactSession(
  options: SmartCompactionOptions
): Promise<SmartCompactionResult | null> {
  const { session, profile, llmProvider, model, onProgress, timeout = 60000, signal } = options;
  const tailBudget = options.tailTokenBudget ?? profile.tailTokenBudget ?? 20_000;

  if (!tailBudget || tailBudget <= 0) {
    return null;
  }

  onProgress?.('analyzing', 'Analyzing conversation history...');

  const timeline = await session.getTimeline();
  const messageEntries = timeline
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.item.type === 'message') as Array<{ entry: TimestampedSessionItem; index: number }>;

  if (messageEntries.length === 0) {
    return null;
  }

  const systemEntries = messageEntries.filter(({ entry }) => {
    const msg = (entry.item as MessageItem).data;
    return msg.role === 'system';
  });

  const nonSystemEntries = messageEntries.filter(({ entry }) => {
    const msg = (entry.item as MessageItem).data;
    return msg.role !== 'system';
  });

  if (nonSystemEntries.length === 0) {
    // 只有 system 消息，无需压缩
    return null;
  }

  // 不再有"保留N轮"等复杂判断，达到阈值就压缩
  let accumulated = 0;
  let keepStart = nonSystemEntries.length;

  for (let i = nonSystemEntries.length - 1; i >= 0; i--) {
    const message = (nonSystemEntries[i].entry.item as MessageItem).data;
    accumulated += approxTokensForMessage(message);
    if (accumulated >= tailBudget) {
      keepStart = i;
      break;
    }
  }

  if (keepStart >= nonSystemEntries.length) {
    if (nonSystemEntries.length <= 2) {
      // 只有1-2条消息，确实无法压缩
      return null;
    }
    // 强制压缩一半消息
    keepStart = Math.floor(nonSystemEntries.length / 2);
  }
  const keepStartInitial = keepStart;

  const allNonSystemMessages = nonSystemEntries.map(({ entry }) => (entry.item as MessageItem).data);
  const adjustedKeepStart = widenKeepStartForPairedBlocks(allNonSystemMessages, keepStart);
  if (adjustedKeepStart < keepStart) {
    keepStart = adjustedKeepStart;
  }

  const messagesToSummarize = nonSystemEntries.slice(0, keepStart).map(({ entry }) => (entry.item as MessageItem).data);
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const beforeStats = {
    userTokens: 0,
    assistantTokens: 0,
    toolTokens: 0,
    totalTokens: 0,
  };

  for (const msg of messagesToSummarize) {
    const tokens = approxTokensForMessage(msg);
    if (msg.role === 'user') {
      beforeStats.userTokens += tokens;
    } else if (msg.role === 'assistant') {
      beforeStats.assistantTokens += tokens;
    } else if (msg.role === 'tool') {
      beforeStats.toolTokens += tokens;
    }
    beforeStats.totalTokens += tokens;
  }

  const MIN_COMPRESSIBLE_TOKENS = (() => {
    const n = Number(process.env.NEOX_MIN_COMPRESSIBLE_TOKENS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
  })();
  if (beforeStats.totalTokens < MIN_COMPRESSIBLE_TOKENS) {
    return null;
  }

  // 统计保留的消息
  const keptMessages = nonSystemEntries.slice(keepStart).map(({ entry }) => (entry.item as MessageItem).data);
  const afterStatsKept = {
    userTokens: 0,
    assistantTokens: 0,
    toolTokens: 0,
    totalTokens: 0,
  };

  for (const msg of keptMessages) {
    const tokens = approxTokensForMessage(msg);
    if (msg.role === 'user') {
      afterStatsKept.userTokens += tokens;
    } else if (msg.role === 'assistant') {
      afterStatsKept.assistantTokens += tokens;
    } else if (msg.role === 'tool') {
      afterStatsKept.toolTokens += tokens;
    }
    afterStatsKept.totalTokens += tokens;
  }

  // 估算将节省的 tokens
  const estimatedTokensSaved = beforeStats.totalTokens;

  onProgress?.('summarizing', `Summarizing ${messagesToSummarize.length} messages with AI...`);

  // 检测语言并选择 prompt
  const language = detectLanguage(messagesToSummarize);
  const systemPrompt = language === 'zh' ? COMPACTION_SYSTEM_PROMPT_ZH : COMPACTION_SYSTEM_PROMPT;
  const userPrompt = buildCompactionPrompt(messagesToSummarize);

  // 调用 LLM 生成摘要
  let summary: string;
  let llmTokensUsed: number | undefined;
  let fallbackUsed = false;

  try {
    // Create a combined abort signal from timeout and external signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // Combine external signal with timeout signal
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          model,
          temperature: 0.3, // 低温度以获得更确定性的输出
          signal: combinedSignal,
        }
      );

      clearTimeout(timeoutId);
      summary = getTextFromContent(response.choices[0]?.message?.content) || '';
      llmTokensUsed = response.usage?.total_tokens;
    } catch (llmError: any) {
      clearTimeout(timeoutId);

      // Check if it was a timeout or cancellation
      if (llmError?.name === 'AbortError' || llmError?.code === 'ABORT_ERR') {
        console.warn('[SmartCompact] LLM call timed out or was cancelled, falling back to lightweight');
      } else {
        console.error('[SmartCompact] LLM call failed:', llmError.message);
      }
      throw llmError;
    }

    if (!summary.trim()) {
      // LLM 返回空摘要，回退到轻量级压缩
      console.warn('[SmartCompact] LLM returned empty summary, falling back to lightweight');
      const { summary: fallbackSummary } = buildSummaryText(messagesToSummarize, DEFAULT_SUMMARY_HEADER);
      summary = fallbackSummary;
      fallbackUsed = true;
    }
  } catch (error: any) {
    // LLM 调用失败，回退到轻量级压缩
    console.error('[SmartCompact] LLM call failed, falling back to lightweight:', error.message);
    const { summary: fallbackSummary } = buildSummaryText(messagesToSummarize, DEFAULT_SUMMARY_HEADER);
    summary = fallbackSummary;
    fallbackUsed = true;
  }

  onProgress?.('saving', 'Saving compacted history...');

  // 格式化摘要消息
  const header = language === 'zh' ? '# 对话历史摘要（AI 生成）' : '# Conversation Summary (AI Generated)';
  const formattedSummary = `${header}\n\n${summary}`;

  const retainedMessages = messageEntries.length - messagesToSummarize.length;
  const summaryTimestamp = messageEntries[0]?.entry.timestamp ?? Date.now();

  // 这样可以避免被误解析为包含 thinking block 的复杂内容
  const summaryMessage: TimestampedSessionItem = {
    item: {
      type: 'message',
      data: {
        role: 'user',
        content: formattedSummary, // 必须是 string 类型
        name: 'SmartCompactSummary',
      },
    } as MessageItem,
    timestamp: summaryTimestamp,
    seq: 0,
  };

  const compactedMeta: TimestampedSessionItem = {
    item: {
      type: 'compacted',
      data: {
        summary: truncateText(summary, 2000),
        originalCount: messagesToSummarize.length,
        compactedAt: new Date().toISOString(),
        method: 'smart', // 标记为智能压缩
        llmTokensUsed,
      },
    },
    timestamp: summaryTimestamp,
    seq: 0,
  };

  // 重建时间线
  const newTimeline: TimestampedSessionItem[] = [];
  let summaryInserted = false;

  const entriesToRemove = new Set(
    nonSystemEntries.slice(0, keepStart).map(({ entry }) => entry)
  );

  for (const current of timeline) {
    // 保留非消息项
    if (current.item.type !== 'message') {
      newTimeline.push({ ...current });
      continue;
    }

    const msg = (current.item as MessageItem).data;
    if (msg.role === 'system') {
      newTimeline.push({ ...current });
      continue;
    }

    // 检查是否需要删除此消息
    if (entriesToRemove.has(current)) {
      if (!summaryInserted) {
        newTimeline.push({ ...summaryMessage });
        newTimeline.push({ ...compactedMeta });
        summaryInserted = true;
      }
      // 跳过旧消息
    } else {
      // 保留此消息
      newTimeline.push({ ...current });
    }
  }

  if (!summaryInserted) {
    return null;
  }

  const normalizedTimeline = newTimeline.map((item, index) => ({
    item: item.item,
    timestamp: item.timestamp ?? Date.now(),
    seq: index,
  }));

  const beforeTokens = timeline.reduce((sum, e) => sum + approxTokensForItem(e.item), 0);
  const afterTokens = normalizedTimeline.reduce((sum, e) => sum + approxTokensForItem(e.item), 0);
  if (beforeTokens > 0 && afterTokens >= beforeTokens * 0.97) {
    return null;
  }

  await session.replaceTimeline(normalizedTimeline);

  const summaryTokens = approxTokensForMessage({
    role: 'user',
    content: formattedSummary,
  });

  const detailedStats = {
    before: beforeStats,
    after: {
      userTokens: afterStatsKept.userTokens,
      assistantTokens: afterStatsKept.assistantTokens,
      toolTokens: afterStatsKept.toolTokens,
      summaryTokens,
      totalTokens: afterStatsKept.totalTokens + summaryTokens,
    },
    saved: {
      userTokens: beforeStats.userTokens,
      assistantTokens: beforeStats.assistantTokens,
      toolTokens: beforeStats.toolTokens,
      totalTokens: beforeStats.totalTokens - summaryTokens, // 实际节省 = 移除的 - 摘要
    },
  };

  const diagnostics: SmartCompactionDiagnostics = {
    version: COMPACTION_QUALITY_LOG_VERSION,
    model,
    language,
    contextWindow: profile.contextWindow,
    tailTokenBudget: tailBudget,
    minCompressibleTokens: MIN_COMPRESSIBLE_TOKENS,
    messageCounts: {
      timelineMessages: messageEntries.length,
      systemMessages: systemEntries.length,
      nonSystemMessages: nonSystemEntries.length,
      summarizedMessages: messagesToSummarize.length,
      keptMessages: keptMessages.length,
      retainedMessagesIncludingSystem: retainedMessages,
    },
    boundary: {
      keepStartInitial,
      keepStartAfterInvariant: keepStart,
      invariantShift: keepStartInitial - keepStart,
    },
    prompt: {
      systemPromptTokensApprox: approxTokensForText(systemPrompt),
      userPromptChars: userPrompt.length,
      userPromptTokensApprox: approxTokensForText(userPrompt),
    },
    llm: {
      fallbackUsed,
      llmTokensUsed,
      summaryChars: formattedSummary.length,
      summaryTokensApprox: summaryTokens,
    },
    tokens: {
      summarized: {
        user: beforeStats.userTokens,
        assistant: beforeStats.assistantTokens,
        tool: beforeStats.toolTokens,
        total: beforeStats.totalTokens,
      },
      keptTail: {
        user: afterStatsKept.userTokens,
        assistant: afterStatsKept.assistantTokens,
        tool: afterStatsKept.toolTokens,
        total: afterStatsKept.totalTokens,
      },
      afterEstimated: {
        tail: afterStatsKept.totalTokens,
        summary: summaryTokens,
        total: afterStatsKept.totalTokens + summaryTokens,
      },
      netSavedEstimated: beforeStats.totalTokens - summaryTokens,
      compressionRatioEstimated: beforeStats.totalTokens > 0
        ? (afterStatsKept.totalTokens + summaryTokens) / (beforeStats.totalTokens + afterStatsKept.totalTokens)
        : 1,
    },
  };

  return {
    removedMessages: messagesToSummarize.length,
    keptMessages: retainedMessages,
    summaryText: formattedSummary,
    estimatedTokensSaved,
    llmTokensUsed,
    diagnostics,
    detailedStats,
  };
}

