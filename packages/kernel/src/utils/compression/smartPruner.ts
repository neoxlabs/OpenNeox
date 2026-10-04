/**
 * Smart Pruning — 按 tool 输出体积剪枝(pre-compaction 层)
 *
 * 对标 OpenCode `session/compaction.ts:49-90`:
 *   · 不调 LLM, 不摘要 —— 纯机械删除
 *   · 只删**最老**、**体积最大**的 tool_result 消息
 *   · 保护最近 N 轮对话和关键状态工具(todo_list / memory / team_board 等)
 *   · 被删的消息用 placeholder 占位, LLM 可以"重新调工具"拿回信息
 *
 * 为什么需要这层?
 * 原有 UnifiedCompressor 在超预算时直接摘要化整段对话, 把 "user: refactor X"
 * "assistant: done via readfile+edit" 这类**决策文字**也摘成模糊文案。
 * Smart Pruning 只去掉**可以重新获取的**(readfile 结果、grep 输出等),
 * 保留**不可恢复的决策链**(用户意图、assistant 推理)。
 *
 * 触发顺序:
 *   compressHistory(msgs, budget)
 *     ↓
 *   if (tokens > budget) → smartPruneToolOutputs(先试删大 tool)
 *     ↓
 *   if 仍超 → messageCompressor.compressMessages(LLM 摘要兜底)
 */

import type { Message } from '../../types/index.js';
import {
  estimateTokensForMessage,
  estimateTokensFromMessages,
} from '../../compat/memoryPressure.js';

// ════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════

export interface SmartPruneOptions {
  /** 要剪的消息列表 */
  messages: Message[];
  /** 目标节省的 token 数, 达到即停 */
  targetSavings: number;
  /** 最近 N 个 assistant turn 不可剪(保留最近决策) */
  protectRecentTurns?: number;
  /**
   * 最早 N 个 user-assistant turn 不可剪(保留任务初心 / 原始 prompt).
   * 默认 1: 长会话被剪后, 第一条 user 通常是任务陈述, 丢了模型会忘"原本要做啥".
   * 设 0 关闭头部保护(回到旧行为).
   */
  protectHeadTurns?: number;
  /** 单条 tool_result 的最小可剪 token 数(小于此值不剪, 剪了节省不多) */
  minPruneTokens?: number;
  /** 不可剪的 tool 名白名单(重要状态工具) */
  protectTools?: ReadonlySet<string>;
}

export interface PrunedToolInfo {
  toolName: string;
  originalTokens: number;
  messageIndex: number;
}

export interface SmartPruneResult {
  /** 剪枝后的消息列表(与输入等长, 被剪的用 placeholder 替换) */
  messages: Message[];
  /** 剪掉的 tool_result 消息数 */
  prunedCount: number;
  /** 实际节省的 token 数 */
  savedTokens: number;
  /** 被剪工具列表(诊断/日志用) */
  prunedTools: PrunedToolInfo[];
}

// ════════════════════════════════════════════════════════════════════════════
// 默认参数
// ════════════════════════════════════════════════════════════════════════════

export const DEFAULT_PROTECT_RECENT_TURNS = 3;
export const DEFAULT_PROTECT_HEAD_TURNS = 1;
export const DEFAULT_MIN_PRUNE_TOKENS = 4000;

/**
 * 这些 tool 的输出承载**关键可持续状态**, 不能用 placeholder 替换
 * (否则 LLM 丢失 task/memory/team 协作上下文):
 *   · todo_list / todo_read / todo_write —— 任务追踪
 *   · recall / memory_* —— 记忆读写
 *   · read_team_board / post_to_team_board —— 团队协作
 *   · neox_config —— 运行时配置
 *   · ask_user / ask_leader —— 交互问答
 * 其余 tool(readfile / search / execute_shell / grep …)都可以剪, LLM
 * 需要时可重新调用。
 */
export const DEFAULT_PROTECT_TOOLS: ReadonlySet<string> = new Set([
  'todo_list',
  'todo_read',
  'todo_write',
  'recall',
  'memory_read',
  'memory_write',
  'read_team_board',
  'post_to_team_board',
  'read_peers_status',
  'neox_config',
  'ask_user',
  'ask_leader',
]);

// ════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════

export function smartPruneToolOutputs(opts: SmartPruneOptions): SmartPruneResult {
  const {
    messages,
    targetSavings,
    protectRecentTurns = DEFAULT_PROTECT_RECENT_TURNS,
    protectHeadTurns = DEFAULT_PROTECT_HEAD_TURNS,
    minPruneTokens = DEFAULT_MIN_PRUNE_TOKENS,
    protectTools = DEFAULT_PROTECT_TOOLS,
  } = opts;

  if (messages.length === 0 || targetSavings <= 0) {
    return emptyResult(messages);
  }

  // 1. 找保护区: 头 [0, headEndIdx), 中间可剪 [headEndIdx, tailStartIdx), 尾 [tailStartIdx, end]
  const tailStartIdx = findProtectedRegionStart(messages, protectRecentTurns);
  const headEndIdx = findHeadProtectedRegionEnd(messages, protectHeadTurns);

  if (tailStartIdx === 0 || headEndIdx >= tailStartIdx) {
    // 全部被保护(对话短, 或头尾覆盖了所有消息) → 不剪
    return emptyResult(messages);
  }

  // 2. 从最老可剪位置开始扫, 找可剪的大 tool_result
  const newMessages: Message[] = messages.slice();
  const pruned: PrunedToolInfo[] = [];
  let savedTokens = 0;

  for (let i = headEndIdx; i < tailStartIdx; i++) {
    if (savedTokens >= targetSavings) break;

    const msg = newMessages[i];
    if (msg.role !== 'tool') continue;

    // tool 消息必须有 name 字段; 无法识别就不剪(保守)
    const toolName = (msg as any).name as string | undefined;
    if (!toolName) continue;
    if (protectTools.has(toolName)) continue;

    const originalTokens = estimateTokensForMessage(msg);
    if (originalTokens < minPruneTokens) continue;

    // 剪!构造 placeholder
    const placeholder = buildPlaceholder(toolName, originalTokens);
    const replacement: Message = {
      ...msg,
      content: placeholder,
    };
    const replacementTokens = estimateTokensForMessage(replacement);

    newMessages[i] = replacement;
    const delta = originalTokens - replacementTokens;
    savedTokens += delta;
    pruned.push({ toolName, originalTokens, messageIndex: i });
  }

  return {
    messages: newMessages,
    prunedCount: pruned.length,
    savedTokens,
    prunedTools: pruned,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════

/**
 * 找到保护区的起始 index。
 * 返回最老不可剪消息的 index(即 [0, returnValue) 是可剪区)。
 *
 * 算法:从最新往前扫, 数到 N 个 assistant turn 时:
 *   · 保留该 assistant 及其后所有消息
 *   · 同时把该 assistant 紧邻的 tool_call / tool 消息链一起保留(不能半切)
 */
/**
 * 找到头部保护区的结束 index (exclusive).
 * 返回最早可剪消息的 index, 即 [0, returnValue) 全保护.
 *
 * 算法: "一个 turn" = 一段 user message + 它的 assistant reply chain (含 tool_call/tool).
 *   从前往后扫, 数到第 protectHeadTurns+1 个 user 出现时, 它本身已在可剪区, 返回它的 idx.
 *   不足 N+1 个 user → 全部保护(return messages.length, 实际上会触发上层 "全保护 不剪" 分支).
 *
 * protectHeadTurns=0 关闭头部保护, 返回 0.
 * messages 不以 user 开头(resume 场景)时退化到从首条算 turn, 行为合理.
 */
function findHeadProtectedRegionEnd(messages: Message[], protectHeadTurns: number): number {
  if (protectHeadTurns <= 0) return 0;
  let userSeen = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') {
      userSeen += 1;
      if (userSeen > protectHeadTurns) {
        return i;
      }
    }
  }
  return messages.length;
}

function findProtectedRegionStart(messages: Message[], protectRecentTurns: number): number {
  let assistantSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      assistantSeen += 1;
      if (assistantSeen >= protectRecentTurns) {
        // 保护从 i 开始的所有消息;但 i 之前紧邻的 user 消息也要保护(这轮对话的起点)
        // 向前找到最近的 user 消息
        let startIdx = i;
        for (let j = i - 1; j >= 0; j -= 1) {
          if (messages[j].role === 'user') {
            startIdx = j;
            break;
          }
          // 一直往前找, 直到遇到另一个 user(这轮的起点)
        }
        return startIdx;
      }
    }
  }
  // 少于 protectRecentTurns 个 assistant turn → 全部保护
  return 0;
}

function buildPlaceholder(toolName: string, originalTokens: number): string {
  return (
    `[TOOL_OUTPUT_PRUNED] Tool "${toolName}" result (~${originalTokens} tokens) was removed to save context. ` +
    `If you need this information again, re-invoke "${toolName}" with the same arguments, ` +
    `or use readfile(start_line=N, num_lines=M) / search(pattern=...) to look up specific parts.`
  );
}

function emptyResult(messages: Message[]): SmartPruneResult {
  return {
    messages,
    prunedCount: 0,
    savedTokens: 0,
    prunedTools: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 便捷入口:基于预算自动计算 targetSavings
// ════════════════════════════════════════════════════════════════════════════

export interface AutoSmartPruneOptions {
  messages: Message[];
  /** token 预算上限 */
  tokenBudget: number;
  /** 缓冲倍率:实际 targetSavings = (overage) × buffer (默认 1.2 多剪 20%) */
  buffer?: number;
  /** 其他参数透传 */
  protectRecentTurns?: number;
  protectHeadTurns?: number;
  minPruneTokens?: number;
  protectTools?: ReadonlySet<string>;
}

/**
 * 自动计算目标节省量的 Smart Pruning。
 * 若 currentTokens <= tokenBudget, 直接返回空结果(无需剪枝)。
 */
export function autoSmartPruneIfOverBudget(opts: AutoSmartPruneOptions): SmartPruneResult {
  const { messages, tokenBudget, buffer = 1.2, ...rest } = opts;
  const currentTokens = estimateTokensFromMessages(messages);
  if (currentTokens <= tokenBudget) return emptyResult(messages);

  const overage = currentTokens - tokenBudget;
  return smartPruneToolOutputs({
    messages,
    targetSavings: Math.ceil(overage * buffer),
    ...rest,
  });
}
