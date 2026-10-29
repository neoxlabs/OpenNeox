/**
 * AgentBudgetAccessor — 让 tools 透明拿到当前 agentLoop 的 budget 状态
 *
 * 场景:`context_status` 工具需要读 BudgetTracker + 消息 token 估算,但这些
 * 都在 agentLoop 函数作用域里。和 BackgroundTaskNotifier 同样的模式:
 * 用 AsyncLocalStorage 绑 session-scoped snapshot getter,工具 call 时
 * 透明拿到当前上下文。
 *
 * 为什么是 **getter** 而不是快照?因为 BudgetTracker / messages 是可变的,
 * accessor 在 enter 时拿到的 snapshot 会立刻过时。让 tool 每次调用读 getter
 * 就能拿到"调用那一刻"的最新值。
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface AgentBudgetSnapshot {
  /** session / processId(与 BackgroundTaskNotifier 同一 id 源) */
  sessionId: string;
  /** 累计 output tokens */
  outputTokensUsed: number;
  /** 预算上限 */
  outputTokenBudget: number;
  /** 已用工具调用数 */
  toolCallsUsed: number;
  /** 工具调用预算 */
  toolCallBudget: number;
  /** 已跑时长 (ms) */
  elapsedMs: number;
  /** 时长预算 */
  timeBudgetMs: number;
  /** 估算当前 messages 占用的 input tokens */
  inputTokensEstimate: number;
  /** 模型 context window 大小(0 表示未知 / 无限制) */
  inputTokenBudget: number;
  /** 压缩阈值(tokens, 0 表示禁用压缩) */
  compressionThresholdTokens: number;
  /** 轮次 */
  llmCallCount: number;
  /** 累计 tool 调用 */
  totalToolCalls: number;
}

type SnapshotGetter = () => AgentBudgetSnapshot;

class AgentBudgetAccessor {
  private als = new AsyncLocalStorage<SnapshotGetter>();
  /**
   * "最近活跃"的 getter ─ 给 ALS 外部(例如 Ink UI main loop)一个兜底读入口。
   * 每次 enterSession 会把最新 getter 覆盖到这里;Electron/Ink 的底部 budget 徽章
   * 通过 getLatestSnapshot() 读这个快照,不依赖 ALS 上下文继承。
   */
  private lastGetter: SnapshotGetter | null = null;

  /**
   * 把 snapshot getter 绑到当前 async 子树。agentLoop 入口调一次即可,
   * 后续所有工具在此 context 执行时能拿到。
   * 同时更新全局 "最近活跃" getter 用于 ALS 外的 UI 兜底读。
   */
  enterSession(getter: SnapshotGetter): void {
    this.als.enterWith(getter);
    this.lastGetter = getter;
  }

  /** 拿当前 session 的最新 snapshot,不在 session 里返回 undefined */
  getSnapshot(): AgentBudgetSnapshot | undefined {
    const g = this.als.getStore();
    if (!g) return undefined;
    try {
      return g();
    } catch {
      return undefined;
    }
  }

  /**
   * ALS 外(UI 主循环)的兜底读入口。返回最近一次 enterSession 注册的 getter
   * 的实时值;没有任何 session 活跃过 → undefined。
   */
  getLatestSnapshot(): AgentBudgetSnapshot | undefined {
    if (!this.lastGetter) return undefined;
    try {
      return this.lastGetter();
    } catch {
      return undefined;
    }
  }
}

let globalAccessor: AgentBudgetAccessor | null = null;

export function getAgentBudgetAccessor(): AgentBudgetAccessor {
  if (!globalAccessor) globalAccessor = new AgentBudgetAccessor();
  return globalAccessor;
}

export function __resetAgentBudgetAccessorForTest(): void {
  globalAccessor = null;
}

// ────────────────────────────────────────────────────────────
// Suggestion policy — 共享给 context_status tool 和 agentLoop 的 pre-LLM nudge
// ────────────────────────────────────────────────────────────

export type ContextSuggestion =
  | 'ok'
  | 'save_memory_soon'
  | 'save_memory_and_restart';

/** 基于 snapshot 给出建议行为。纯函数,便于测试。 */
export function suggestFromSnapshot(s: AgentBudgetSnapshot): ContextSuggestion {
  const inputPct = s.inputTokenBudget > 0
    ? s.inputTokensEstimate / s.inputTokenBudget
    : 0;
  const outputPct = s.outputTokenBudget > 0
    ? s.outputTokensUsed / s.outputTokenBudget
    : 0;
  const toolPct = s.toolCallBudget > 0
    ? s.toolCallsUsed / s.toolCallBudget
    : 0;
  const timePct = s.timeBudgetMs > 0
    ? s.elapsedMs / s.timeBudgetMs
    : 0;

  const worstPct = Math.max(inputPct, outputPct, toolPct, timePct);
  if (worstPct >= 0.85) return 'save_memory_and_restart';
  if (worstPct >= 0.65) return 'save_memory_soon';
  return 'ok';
}

/** 对外可视化的综合百分比(取各维度最大值) */
export function computeWorstPct(s: AgentBudgetSnapshot): number {
  const input = s.inputTokenBudget > 0 ? s.inputTokensEstimate / s.inputTokenBudget : 0;
  const output = s.outputTokenBudget > 0 ? s.outputTokensUsed / s.outputTokenBudget : 0;
  const tool = s.toolCallBudget > 0 ? s.toolCallsUsed / s.toolCallBudget : 0;
  const time = s.timeBudgetMs > 0 ? s.elapsedMs / s.timeBudgetMs : 0;
  return Math.max(input, output, tool, time);
}
