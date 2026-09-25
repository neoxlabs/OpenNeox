/**
 * Ensure assistant tool calls and tool results are adjacent before an LLM request.
 *
 * Provider payloads require every assistant tool-call message to be followed by
 * results for each declared call id.
 *
 * Providers require each assistant tool-call message to be followed immediately
 * by a result for every declared call id.
 *
 * The guard handles two cases:
 *
 * 1. **Partial streamed records** can be superseded by a later complete record:
 *      3 assistant tool_calls=[A]        ← 后面没有 tool
 *      4 assistant tool_calls=[B]        ← 后面没有 tool
 *      5 assistant tool_calls=[A, B]     ← 完整版, 后面才跟 tool A / tool B
 *      6 tool A
 *      7 tool B
 *    Such fragments are removed when superseded by the complete record.
 *
 * 2. **Missing results** receive a placeholder so the model can choose whether
 *    to retry or continue.
 *
 * The conservative strategy is:
 *   · 残片且 content 为空 → 整条删 (它只是半成品快照)
 *   · 残片但带正文 → 保留消息、只剥掉 tool_calls (正文是模型真说过的话, 不能丢)
 *   · 真缺结果 → 在该 assistant **紧后面**补占位 tool 消息, 不删 tool_calls
 *   · 孤儿 tool 消息 (全历史没有对应 call) → 删
 *
 * The function is pure and only normalizes the current request payload.
 */

import { cliLogger } from '../platform/cliLogger.js';

/** 补给模型看的占位内容 — 说清楚状况, 让它自己决定重试还是绕开 */
const MISSING_RESULT_PLACEHOLDER = [
  '<TOOL_RESULT_MISSING>',
  '这次工具调用没有结果: 执行被中断 (进程重启/超时/崩溃), 或结果未能持久化。',
  '如果这一步的信息仍然需要, 请重新调用该工具; 如果已不影响推进, 请基于其它上下文继续。',
  '</TOOL_RESULT_MISSING>',
].join('\n');

export interface ToolPairRepairStats {
  /** 补了几条占位 tool 消息 */
  filledMissing: number;
  /** 删了几条孤儿 tool 消息 */
  droppedOrphans: number;
  strippedStale: number;
  displaced: number;
}

function hoistToolRuns<T extends Record<string, any>>(messages: readonly T[]): {
  messages: readonly T[];
  displaced: number;
} {
  let out: T[] | null = null;
  let displaced = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out?.push(m);
      i++;
      continue;
    }
    const ids = new Set<string>();
    for (const tc of m.tool_calls)
      if (typeof tc?.id === 'string' && tc.id)
        ids.add(tc.id);
    let lastToolAt = i;
    let seen = 0;
    for (let j = i + 1; j < messages.length && seen < ids.size; j++) {
      const nxt = messages[j];
      if (nxt?.role === 'assistant')
        break;
      if (nxt?.role === 'tool') {
        if (!ids.has(nxt.tool_call_id))
          break;
        seen++;
        lastToolAt = j;
      }
    }
    const span = messages.slice(i + 1, lastToolAt + 1);
    const tools = span.filter((x) => x?.role === 'tool');
    const wedged = span.filter((x) => x?.role !== 'tool');
    if (wedged.length > 0 && !out)
      out = messages.slice(0, i) as T[];
    if (out) {
      out.push(m, ...tools, ...wedged);
      displaced += wedged.length;
    }
    i = lastToolAt + 1;
  }
  return { messages: out ?? messages, displaced };
}
export interface ToolPairGuardResult<T> {
  messages: T[];
  stats: ToolPairRepairStats;
  /** 有没有真的改动过 (没改时 messages 是原数组引用) */
  repaired: boolean;
}

/**
 * 修补一段消息历史, 返回**协议合法**的新数组.
 * 无需修补时原样返回入参数组 (零拷贝, 热路径友好)。
 */
export function enforceToolPairs<T extends Record<string, any>>(
  input: readonly T[],
): ToolPairGuardResult<T> {
  const empty: ToolPairRepairStats = { filledMissing: 0, droppedOrphans: 0, strippedStale: 0, displaced: 0 };

  /* 快速路径: 整段没有 tool_calls 也没有 tool 消息 → 绝大多数普通对话 */
  let messages = input;
  let hasToolCalls = false;
  let hasToolMsgs = false;
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      hasToolCalls = true;
    } else if (m?.role === 'tool') {
      hasToolMsgs = true;
    }
    if (hasToolCalls && hasToolMsgs) break;
  }
  if (!hasToolCalls && !hasToolMsgs) {
    return { messages: messages as T[], stats: empty, repaired: false };
  }

  const hoisted = hoistToolRuns(messages);
  messages = hoisted.messages;
  const displaced = hoisted.displaced;
  const idOf = (tc: any): string | null =>
    typeof tc?.id === 'string' && tc.id ? tc.id : null;

  /* 全局: 哪些 tool_call_id 在历史里**任意位置**有结果 */
  const answeredAnywhere = new Set<string>();
  for (const m of messages) {
    if (m?.role !== 'tool') continue;
    const id = m.tool_call_id;
    if (typeof id === 'string' && id) answeredAnywhere.add(id);
  }
  /* 全局: 哪些 id 被某条 assistant 声明过 (判孤儿 tool 消息用) */
  const declaredAnywhere = new Set<string>();
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!tc) continue;
      const id = idOf(tc);
      if (id) declaredAnywhere.add(id);
    }
  }

  /* 每条 assistant(tool_calls) 紧随其后的连续 tool 消息覆盖了哪些 id */
  const adjacentIds = (assistantIdx: number): Set<string> => {
    const got = new Set<string>();
    for (let j = assistantIdx + 1; j < messages.length; j++) {
      const nxt = messages[j];
      if (nxt?.role !== 'tool') break;
      const id = nxt.tool_call_id;
      if (typeof id === 'string' && id) got.add(id);
    }
    return got;
  };

  const out: T[] = [];
  let filledMissing = 0;
  let droppedOrphans = 0;

  let strippedStale = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    /* 孤儿 tool 消息: 全历史没有任何 assistant 声明过它 */
    if (m?.role === 'tool') {
      const id = m.tool_call_id;
      if (typeof id === 'string' && id && !declaredAnywhere.has(id)) {
        droppedOrphans++;
        continue;
      }
      out.push(m);
      continue;
    }

    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out.push(m);
      continue;
    }

    const adjacent = adjacentIds(i);
    const staleIds: string[] = [];   // 结果在别处 → 本条是流式残片
    const missingIds: string[] = []; // 全历史都没有 → 真缺结果
    for (const tc of m.tool_calls) {
      if (!tc) continue;
      const id = idOf(tc);
      if (!id || adjacent.has(id)) continue;
      if (answeredAnywhere.has(id)) staleIds.push(id);
      else missingIds.push(id);
    }

    if (staleIds.length === 0 && missingIds.length === 0) {
      out.push(m);
      continue;
    }

    /* 残片 id 直接从本条里剥掉 —— 它们的真实调用+结果在后面那条完整消息上 */
    const keptCalls = staleIds.length === 0
      ? m.tool_calls
      : m.tool_calls.filter((tc: any) => {
        const id = idOf(tc);
        return !id || !staleIds.includes(id);
      });

    const textContent = typeof m.content === 'string' ? m.content.trim() : '';
    if (keptCalls.length === 0) {
      /* 整条都是残片: 没正文就直接丢 (半成品快照), 有正文则降级成纯文本保住内容 */
      droppedOrphans++;
      if (textContent) {
        const { tool_calls: _drop, ...rest } = m as any;
        out.push(rest as T);
      }
      continue;
    }

    strippedStale += m.tool_calls.length - keptCalls.length;
    out.push(keptCalls === m.tool_calls ? m : ({ ...(m as any), tool_calls: keptCalls } as T));
    /* 真缺结果的补占位, 紧跟本条 */
    for (const tc of keptCalls) {
      const id = idOf(tc);
      if (!id || !missingIds.includes(id)) continue;
      filledMissing++;
      out.push({
        role: 'tool',
        content: MISSING_RESULT_PLACEHOLDER,
        tool_call_id: id,
        ...(tc?.function?.name ? { name: tc.function.name } : {}),
      } as unknown as T);
    }
  }

  if (filledMissing === 0 && droppedOrphans === 0 && strippedStale === 0 && displaced === 0
    && out.length === input.length) {
    return { messages: input as T[], stats: empty, repaired: false };
  }

  const stats: ToolPairRepairStats = { filledMissing, droppedOrphans, strippedStale, displaced };
  cliLogger.warn(
    'TOOL_PAIR_GUARD',
    `repaired tool pairing before LLM request: filled=${filledMissing} ` +
    `dropped=${droppedOrphans} stripped=${strippedStale} displaced=${displaced} ` +
    `(${input.length} → ${out.length} msgs)`,
  );
  return { messages: out, stats, repaired: true };
}
