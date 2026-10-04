/**
 * context_status — agent 自查预算 / 上下文占用
 *
 * 用法:
 *   - 每 10 轮左右,或在接手"新大任务"前 agent 主动调一次,据 suggestion 决策:
 *     · ok                    → 继续干
 *     · save_memory_soon      → 下一两轮内调用 save_memory 把关键进度(user prefs /
 *                               project facts / feedback / references)落盘,同时建议
 *                               用户把大任务拆成子任务或分阶段
 *     · save_memory_and_restart → 立刻调 save_memory;回复用户"这个任务需要干净的
 *                               context,建议你 /clear 或新开一个 session 继续 —
 *                               我已经把关键信息写入记忆,新 session 会自动读到"
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import {
  getAgentBudgetAccessor,
  suggestFromSnapshot,
  computeWorstPct,
  type ContextSuggestion,
} from '../runtime/agentBudgetAccessor.js';

interface ContextStatusArgs {
  /** 留作未来扩展,目前全部 readonly,无参数 */
  _?: never;
}

function pctStr(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function pick(s: ContextSuggestion): string {
  switch (s) {
    case 'ok':
      return 'Context is healthy. Continue your work.';
    case 'save_memory_soon':
      return 'Getting close to a soft limit. Consider calling save_memory to preserve key project facts / user preferences / decisions — and suggest splitting the current large task into smaller pieces if applicable.';
    case 'save_memory_and_restart':
      return 'Near hard limit. Call save_memory now with the essentials (what was decided / what\'s left / who the user is) and ask the user to /clear or start a new session — new session will auto-read MEMORY.md.';
  }
}

export const contextStatusTool: Tool = {
  name: 'context_status',
  aliases: ['ContextStatus', 'session_status', 'token_status', 'budget_status'],
  description: `Check your own remaining context/token budget. Call this proactively when:
- You've been working for ~10+ turns without checking
- User just gave you a big new task (refactor X / implement whole Y / migrate Z)
- You noticed the conversation has grown long

Returns suggestion:
- "ok": keep working
- "save_memory_soon": call save_memory with key facts (user prefs / project decisions / lessons learned) in next 1-2 turns; consider splitting the task
- "save_memory_and_restart": call save_memory NOW, then tell the user to /clear or open a new session; new session will auto-load MEMORY.md

Returns full snapshot (tokens, pct, turns used) so you can reason about what to do.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  async function(_args: ContextStatusArgs): Promise<string> {
    const snapshot = getAgentBudgetAccessor().getSnapshot();
    if (!snapshot) {
      /* 没 snapshot 不是错误 — 这个工具按设计就只在 agentLoop 内才有数据,
         在外面调(独立 CLI / 自检 / 测试)直接告诉模型"无数据可报"即可。*/
      return JSON.stringify({
        status: 'success',
        suggestion: 'ok',
        advice: 'context_status: no agent budget snapshot available in current runtime. The tool only reports data when invoked from within an active agentLoop. If you are inside one and still see this, the budget tracker is not wired up — continue your work; this is informational only.',
        snapshot_available: false,
      });
    }

    const suggestion = suggestFromSnapshot(snapshot);
    const worstPct = computeWorstPct(snapshot);

    const inputPct = snapshot.inputTokenBudget > 0
      ? snapshot.inputTokensEstimate / snapshot.inputTokenBudget
      : 0;
    const outputPct = snapshot.outputTokenBudget > 0
      ? snapshot.outputTokensUsed / snapshot.outputTokenBudget
      : 0;

    return JSON.stringify({
      session_id: snapshot.sessionId,
      suggestion,
      advice: pick(suggestion),
      worst_pct: pctStr(worstPct),
      input: {
        used_tokens: snapshot.inputTokensEstimate,
        budget_tokens: snapshot.inputTokenBudget,
        pct: pctStr(inputPct),
        compression_triggers_at_tokens: snapshot.compressionThresholdTokens,
      },
      output: {
        used_tokens: snapshot.outputTokensUsed,
        budget_tokens: snapshot.outputTokenBudget,
        pct: pctStr(outputPct),
      },
      tool_calls: {
        used: snapshot.toolCallsUsed,
        budget: snapshot.toolCallBudget,
      },
      time: {
        elapsed_ms: snapshot.elapsedMs,
        budget_ms: snapshot.timeBudgetMs,
      },
      turns: {
        llm_calls: snapshot.llmCallCount,
        tool_calls_total: snapshot.totalToolCalls,
      },
    });
  },
};
