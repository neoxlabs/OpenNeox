/**
 * repairMessageHistory — server crash 后修补 messages 历史让 LLM 看到合法上下文.
 *
 * 设计依据: 内部设计文档 §4.4 + §3.3
 *
 * 三类不合法状态需要修补:
 *   1. assistant message 有 tool_calls 但后面缺一个或多个 tool_result row
 *      → 补 fake `<INTERRUPTED>` tool_result, LLM 看到后自行决定是否重试该工具
 *   2. tool_call 是 explore/agent 类的并行 sub-agent → 同样 fake INTERRUPTED
 *      sub-agent 自己的 SessionContext 不 resume (N3)
 *   3. 极端情况下末尾出现 partial assistant text (debounce 边界丢失或 host 异常下半截入库)
 *      → 不主动删除 (R4 简化版), 由 LLM 自然延续
 *
 * 修补操作直接对 messages 表 INSERT 新的 tool role row, 不动现有数据.
 * tool_use_id ↔ tool_result 配对完整后, LLM 收到的 messages 序列就是合法的.
 */

import { SessionContext } from '@neoxlabs/platform/platform/sessionContext.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getPendingAskUserStore } from '../store/PendingAskUserStore.js';

export interface RepairResult {
  repairedToolCalls: number;          // 补了几个 fake INTERRUPTED tool_result
  droppedPartialMessages: number;     // R4 简化版下永远 0, 留接口以备未来扩展
  totalMessagesAfter: number;
  ok: boolean;
  reason?: string;                    // ok=false 时的失败原因
}

/** raw tool_call 内嵌结构 — Anthropic SDK / OpenAI 兼容形态 */
interface ToolCallRef {
  id: string;
  name?: string;
}

const INTERRUPTED_TOOL_RESULT_BODY = [
  '<INTERRUPTED reason="server_restart">',
  '工具调用未执行 / 结果未持久化, 因服务进程在执行期间被重启.',
  '若仍需此信息, 请重新调用该工具; 若已不必要, 请基于其它上下文继续推进.',
  '</INTERRUPTED>',
].join('\n');

/**
 * 给一个被打断的 session 修补 messages 历史.
 *
 * @param sessionId 要修补的 session
 * @returns 修补统计 — caller (resume engine) 用 repairedToolCalls 数量决定是否继续 resume
 */
export function repairMessageHistory(sessionId: string): RepairResult {
  const ctx = SessionContext.get(sessionId);
  const messages = ctx.getAll();

  if (messages.length === 0) {
    return {
      repairedToolCalls: 0,
      droppedPartialMessages: 0,
      totalMessagesAfter: 0,
      ok: false,
      reason: 'session has no persisted messages',
    };
  }

  /* 1. 收集所有 assistant tool_calls (raw.tool_calls 数组的 id) */
  const expectedToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const raw: any = msg.raw;
    const toolCalls: ToolCallRef[] | undefined =
      Array.isArray(raw?.tool_calls) ? raw.tool_calls : undefined;
    if (!toolCalls?.length) continue;
    for (const tc of toolCalls) {
      if (typeof tc?.id === 'string' && tc.id) {
        expectedToolCallIds.add(tc.id);
      }
    }
  }

  /* 2. 收集已经存在的 tool role tool_call_id */
  const seenToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const raw: any = msg.raw;
    const tcId = typeof raw?.tool_call_id === 'string'
      ? raw.tool_call_id
      : (typeof raw?.tool_use_id === 'string' ? raw.tool_use_id : null);
    if (tcId) seenToolCallIds.add(tcId);
  }

  /* 3. 找出孤儿 tool_call_id — 有 tool_use 但没 tool_result 的.
   *    例外: pending_ask_user 表里仍挂着的 toolCallId 不算孤儿. 用户的 submit 会
   *    走 replyAskUser resume 路径塞真实答案进来, 这里抢先 fake INTERRUPTED 会
   *    污染 LLM 上下文, 还会因为后到的真 tool_result 造成同 tool_call_id 两条
   *    tool message 的诡异历史. */
  const pendingAskUserIds = getPendingAskUserStore()?.listToolCallIdsBySession(sessionId)
    ?? new Set<string>();
  const orphanIds: string[] = [];
  const skippedAskUserIds: string[] = [];
  for (const tcId of expectedToolCallIds) {
    if (seenToolCallIds.has(tcId)) continue;
    if (pendingAskUserIds.has(tcId)) {
      skippedAskUserIds.push(tcId);
      continue;
    }
    orphanIds.push(tcId);
  }
  if (skippedAskUserIds.length > 0) {
    cliLogger.info('RESUME_REPAIR',
      `session=${sessionId} preserving ${skippedAskUserIds.length} pending ask_user tool_call(s), no INTERRUPTED fake added`);
  }

  if (orphanIds.length === 0) {
    return {
      repairedToolCalls: 0,
      droppedPartialMessages: 0,
      totalMessagesAfter: messages.length,
      ok: true,
    };
  }

  /* 4. 给每个孤儿补一条 fake tool_result. 顺序无关紧要 — 只要 LLM 看到所有
   *    tool_call_id 都有匹配 tool 即可 (Anthropic / OpenAI 协议都允许 tool result
   *    在多条 assistant message 之后再统一出现). */
  const now = Date.now();
  let persisted = 0;
  for (const tcId of orphanIds) {
    const raw = {
      role: 'tool',
      tool_call_id: tcId,
      content: INTERRUPTED_TOOL_RESULT_BODY,
    };
    const seq = ctx.appendMessage('tool', INTERRUPTED_TOOL_RESULT_BODY, '', now, raw);
    if (seq >= 0) persisted++;
  }

  cliLogger.info('RESUME_REPAIR',
    `repaired session=${sessionId} orphans=${orphanIds.length} persisted=${persisted}`,
  );

  return {
    repairedToolCalls: persisted,
    droppedPartialMessages: 0,
    totalMessagesAfter: ctx.getAll().length,
    ok: true,
  };
}
