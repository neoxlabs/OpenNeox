/**
 * Collapse conversation history into semantic layers before full compaction.
 *
 * Recent turns remain complete, middle turns retain assistant text while
 * compacting tool results, and older turns collapse into summaries.
 *
 * Relevance scoring can promote important older turns to the middle layer.
 *
 * Scoring uses local TF-IDF-style keyword matching and does not call an LLM.
 *
 * When the result is already below the target, callers can skip autocompaction.
 */

import type { Message } from '../types/index.js';
import { estimateTokensFromMessages } from '../compat/memoryPressure.js';
import { cliLogger } from '../platform/cliLogger.js';

export interface CollapseConfig {
  /** Layer 0: 最近保留完整的轮次数（默认 3） */
  recentTurns: number;
  /** Layer 1: 中间层保留的轮次数（默认 6） */
  middleTurns: number;
  /** 工具结果折叠后的最大字符数（默认 200） */
  toolResultMaxChars: number;
  /** 启用语义相关性评分（默认 true） */
  semanticScoring: boolean;
  /** 语义相关性阈值：高于此分的 turn 从 Layer 2 提升到 Layer 1（默认 0.3） */
  relevanceThreshold: number;
  /** 最多从 Layer 2 提升的 turn 数（防止提升太多导致压缩不足）（默认 3） */
  maxPromotedTurns: number;
}

const DEFAULT_CONFIG: CollapseConfig = {
  recentTurns: 3,
  middleTurns: 6,
  toolResultMaxChars: 200,
  semanticScoring: true,
  relevanceThreshold: 0.3,
  maxPromotedTurns: 3,
};

export interface CollapseResult {
  messages: Message[];
  collapsedCount: number;
  freedTokens: number;
  /** 折叠后是否已低于目标 token 数 */
  belowTarget: boolean;
}

/**
 * 将消息按"轮次"分组
 * 一个轮次 = user 消息 + assistant 回复 + tool 结果
 */
function groupMessagesByTurn(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

/**
 * 折叠单个工具结果消息
 */
function collapseToolResult(msg: Message, maxChars: number): Message {
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.length <= maxChars) return msg;

  const preview = content.slice(0, maxChars);
  const omittedChars = content.length - maxChars;
  return {
    ...msg,
    content: `${preview}\n[... collapsed ${omittedChars} chars]`,
  };
}

/**
 * 折叠一个轮次为摘要
 */
function collapseTurnToSummary(turn: Message[]): Message {
  const toolNames: string[] = [];
  let assistantPreview = '';

  for (const msg of turn) {
    if (msg.role === 'tool' && (msg as any).name) {
      toolNames.push((msg as any).name);
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      assistantPreview = msg.content.slice(0, 100);
    }
  }

  const summary = toolNames.length > 0
    ? `[Collapsed turn: ${toolNames.join(', ')} → "${assistantPreview}..."]`
    : `[Collapsed turn: "${assistantPreview}..."]`;

  return {
    role: 'user' as const,
    content: summary,
  };
}

// ==================== 语义相关性评分 ====================

/**
 * 从消息中提取关键词（TF 分词，不依赖 LLM）
 * 支持英文 + CJK：英文按空格/标点分词，CJK 按 bigram
 */
function extractKeywords(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  if (!text) return tf;

  // 转小写，去除标点
  const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');

  // 英文分词
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  for (const w of words) {
    tf.set(w, (tf.get(w) || 0) + 1);
  }

  // CJK bigram
  const cjkChars = text.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const bigram = cjkChars.slice(i, i + 2);
    tf.set(bigram, (tf.get(bigram) || 0) + 1);
  }

  return tf;
}

/** 英文停用词（精简版，避免过度过滤） */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
  'nor', 'not', 'so', 'if', 'this', 'that', 'these', 'those', 'it',
  'its', 'here', 'there', 'when', 'where', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
]);

/**
 * 计算两组关键词的余弦相似度
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [key, valA] of a) {
    normA += valA * valA;
    const valB = b.get(key);
    if (valB !== undefined) {
      dotProduct += valA * valB;
    }
  }
  for (const valB of b.values()) {
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * 提取 turn 的文本内容（user + assistant + tool 名）
 */
function extractTurnText(turn: Message[]): string {
  const parts: string[] = [];
  for (const msg of turn) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    }
    // 包含 tool 调用名和参数关键信息
    if ((msg as any).tool_calls) {
      for (const tc of (msg as any).tool_calls) {
        if (tc.function?.name) parts.push(tc.function.name);
        if (tc.function?.arguments) {
          // 提取参数中的文件路径等关键信息
          const argStr = typeof tc.function.arguments === 'string'
            ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          parts.push(argStr.slice(0, 200));
        }
      }
    }
    if ((msg as any).name) parts.push((msg as any).name);
  }
  return parts.join(' ');
}

/**
 * 计算每个 turn 与当前查询的相关性分数
 * 返回 0-1 的分数数组，索引对应 turns
 */
function scoreTurnRelevance(turns: Message[][], queryText: string): number[] {
  if (!queryText || turns.length === 0) {
    return turns.map(() => 0);
  }

  const queryKw = extractKeywords(queryText);
  if (queryKw.size === 0) return turns.map(() => 0);

  // 计算每个 turn 的 IDF 加权相关性
  const turnKeywords = turns.map(t => extractKeywords(extractTurnText(t)));

  // 文档频率（用于 IDF）
  const df = new Map<string, number>();
  for (const kw of turnKeywords) {
    for (const key of kw.keys()) {
      df.set(key, (df.get(key) || 0) + 1);
    }
  }

  const N = turns.length;
  const scores = turnKeywords.map(kw => {
    // TF-IDF 加权的余弦相似度
    const tfidf = new Map<string, number>();
    for (const [term, tf] of kw) {
      const idf = Math.log((N + 1) / ((df.get(term) || 0) + 1));
      tfidf.set(term, tf * idf);
    }
    const queryTfidf = new Map<string, number>();
    for (const [term, tf] of queryKw) {
      const idf = Math.log((N + 1) / ((df.get(term) || 0) + 1));
      queryTfidf.set(term, tf * idf);
    }
    return cosineSimilarity(tfidf, queryTfidf);
  });

  return scores;
}

/**
 * Context Collapse: 语义感知分层折叠消息历史
 *
 * @param messages 完整消息列表
 * @param targetTokens 目标 token 数（折叠后低于此值即跳过后续压缩）
 * @param config 折叠配置
 * @param queryText 当前用户查询（用于语义相关性评分，可选）
 */
export function contextCollapse(
  messages: Message[],
  targetTokens: number,
  config: Partial<CollapseConfig> = {},
  queryText?: string,
): CollapseResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 系统消息单独处理（永远保留）
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const turns = groupMessagesByTurn(nonSystemMessages);
  if (turns.length <= cfg.recentTurns) {
    // 轮次太少，不需要折叠
    return { messages, collapsedCount: 0, freedTokens: 0, belowTarget: false };
  }

  const totalTurns = turns.length;
  const recentStart = totalTurns - cfg.recentTurns;
  const middleStart = Math.max(0, recentStart - cfg.middleTurns);

  // === 语义相关性评分 ===
  // 提取当前查询文本（如果没有传入，取最后一条 user 消息）
  const effectiveQuery = queryText || extractLastUserQuery(nonSystemMessages);
  let relevanceScores: number[] | null = null;
  let promotedIndices = new Set<number>();

  if (cfg.semanticScoring && effectiveQuery) {
    relevanceScores = scoreTurnRelevance(turns, effectiveQuery);

    // 从 Layer 2 区域（i < middleStart）选出高相关性 turn，提升到 Layer 1
    const layer2Candidates: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < middleStart; i++) {
      if (relevanceScores[i] >= cfg.relevanceThreshold) {
        layer2Candidates.push({ index: i, score: relevanceScores[i] });
      }
    }
    // 按分数降序，取前 maxPromotedTurns 个
    layer2Candidates.sort((a, b) => b.score - a.score);
    for (const c of layer2Candidates.slice(0, cfg.maxPromotedTurns)) {
      promotedIndices.add(c.index);
    }

    if (promotedIndices.size > 0) {
      cliLogger.debug('ContextCollapse',
        `Semantic scoring: promoted ${promotedIndices.size} turns from Layer 2 → Layer 1 ` +
        `(scores: ${layer2Candidates.slice(0, cfg.maxPromotedTurns).map(c => c.score.toFixed(2)).join(', ')})`);
    }
  }

  const result: Message[] = [...systemMessages];
  let collapsedCount = 0;

  for (let i = 0; i < totalTurns; i++) {
    const turn = turns[i];

    if (i >= recentStart) {
      // Layer 0: 最近轮次 — 完整保留
      result.push(...turn);
    } else if (i >= middleStart || promotedIndices.has(i)) {
      // Layer 1: 中间轮次（或语义提升的轮次）— 折叠工具结果，保留 assistant/user 文本
      for (const msg of turn) {
        if (msg.role === 'tool') {
          result.push(collapseToolResult(msg, cfg.toolResultMaxChars));
          collapsedCount++;
        } else {
          result.push(msg);
        }
      }
    } else {
      // Layer 2: 最早轮次 — 折叠为单条摘要
      result.push(collapseTurnToSummary(turn));
      collapsedCount += turn.length - 1;  // 多条变一条
    }
  }

  const originalTokens = estimateTokensFromMessages(messages);
  const collapsedTokens = estimateTokensFromMessages(result);
  const freedTokens = originalTokens - collapsedTokens;
  const belowTarget = collapsedTokens < targetTokens;

  if (collapsedCount > 0) {
    cliLogger.info('ContextCollapse',
      `Collapsed ${collapsedCount} messages across ${totalTurns} turns ` +
      `(${(originalTokens / 1000).toFixed(1)}K → ${(collapsedTokens / 1000).toFixed(1)}K tokens, ` +
      `freed ${(freedTokens / 1000).toFixed(1)}K, promoted ${promotedIndices.size}, ` +
      `belowTarget=${belowTarget})`);
  }

  return { messages: result, collapsedCount, freedTokens, belowTarget };
}

/** 提取最后一条 user 消息文本作为查询 */
/**
 * 取"当前在关心什么"的查询串, 供 TF-IDF 给折叠层的轮次打分(相关的提回 Layer 1)。
 *
 * 原本只取**最后一条** user 消息, 而长任务里最后一条几乎总是
 * "继续" / "ok" / "接着做" 这类零信息量的话 —— 打分近似随机, maxPromotedTurns=3
 * 的提升机制等于没跑。这是"压缩后模型丢重点"的一条隐性来源。
 *
 * 改成: 从后往前收集若干条**有信息量**的 user 消息拼起来。
 *   · 跳过纯续跑指令(继续/ok/go on/…) 与过短的消息
 *   · 跳过我们自己注入的 user 角色消息(PostCompact* / <system-reminder> 之类),
 *     它们是框架噪音, 不代表用户意图
 *   · 最多取 MAX_QUERY_MESSAGES 条, 拼接长度封顶, 防止 query 本身喧宾夺主
 * 全都被过滤掉时退回"最后一条 user 消息", 保持旧行为不至于返回空串。
 */
const MAX_QUERY_MESSAGES = 3;
const MAX_QUERY_CHARS = 600;
/** 纯续跑指令 —— 命中即跳过, 它们不携带"在关心什么"的信息 */
const CONTINUATION_ONLY = /^(继续|接着|接着做|请继续|go on|continue|ok|okay|yes|嗯|好的|next|下一步)[\s.!。！~]*$/i;

export function extractLastUserQuery(messages: Message[]): string {
  const picked: string[] = [];
  let lastUserText = '';

  for (let i = messages.length - 1; i >= 0 && picked.length < MAX_QUERY_MESSAGES; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const text = (m.content as string).trim();
    if (!text) continue;
    if (!lastUserText) lastUserText = text;

    /* 框架自己注入的 user 消息不算用户意图 */
    const name = (m as { name?: string }).name ?? '';
    if (name.startsWith('PostCompact')) continue;
    if (text.startsWith('<system-reminder')) continue;

    if (CONTINUATION_ONLY.test(text)) continue;
    if (text.length < 4) continue;

    picked.push(text);
  }

  if (!picked.length) return lastUserText;
  /* 从旧到新拼 —— 新的排后面, 跟"最近的更重要"直觉一致 */
  return picked.reverse().join('\n').slice(0, MAX_QUERY_CHARS);
}
