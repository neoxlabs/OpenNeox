/**
 * kernel StreamEvent → SDK AgentEvent 翻译.
 *
 * kernel StreamedRunner.run() 是 AsyncGenerator<StreamEvent>, 事件流非常细
 * (含 iteration_start / agent_updated / token_usage / context_compaction
 * 等内部信号). 这一层只挑 SDK 用户关心的:
 *   text_delta / thinking / tool_call / tool_result / tool_error / done / error.
 *
 * 其它内部事件忽略 — SDK 公共 API 保持简单, 避免暴露 kernel 实现细节.
 */

/* kernel 的 StreamEvent 不进公开 .d.ts (kernel 未发 npm) —— 这一层只在实现里用它的形状 */
type StreamEvent = Record<string, any>;
import type { AgentEvent, TokenUsage, StopReason } from '../types.js';

export interface EventTranslatorState {
  /** 累积 tool_call_start 的 args, tool_call_done 里才有 success / output */
  pendingCalls: Map<string, { name: string; args?: Record<string, unknown> }>;
  /** 累积 tool_call_delta 的 arguments_delta；完整参数通过增量事件补齐。 */
  argBuffers: Map<string, string>;
  /** 已经发过 tool_call 的 id —— 防止 start/done 两条路重复发 */
  emittedCalls: Set<string>;
  usage: TokenUsage;
  textBuffer: string;
  stopReason: StopReason;
  errorFromStream: Error | null;
}

export function createTranslatorState(): EventTranslatorState {
  return {
    pendingCalls: new Map(),
    argBuffers: new Map(),
    emittedCalls: new Set(),
    usage: { inputTokens: 0, outputTokens: 0 },
    textBuffer: '',
    stopReason: 'end_turn',
    errorFromStream: null,
  };
}

/**
 * 把一个 kernel 事件翻译成 0..N 个 SDK 事件.
 *   kernel 事件类型见 neox-kernel src/types/index.ts (LegacyStreamEvent + RunItemStreamEvent + ...).
 *   首版只识别 LegacyStreamEvent 那批 (流式 runner 的主输出), 其它 (RunItem / TokenUsageStreamEvent 等)
 *   归到 token_usage / 忽略.
 */
export function translateEvent(
  event: StreamEvent,
  state: EventTranslatorState,
): AgentEvent[] {
  const evt = event as any;
  switch (evt.type) {
    case 'text_delta': {
      const delta = String(evt.delta ?? '');
      state.textBuffer += delta;
      return [{ type: 'text_delta', delta }];
    }
    case 'reasoning_delta': {
      return [{ type: 'thinking', delta: String(evt.delta ?? '') }];
    }
    case 'tool_call_delta': {
      const id = String(evt.id ?? evt.name ?? '');
      const chunk = typeof evt.arguments_delta === 'string' ? evt.arguments_delta : '';
      if (id && chunk) state.argBuffers.set(id, (state.argBuffers.get(id) ?? '') + chunk);
      return [];
    }
    case 'tool_call_start': {
      const id = String(evt.id ?? `${evt.name}:${state.pendingCalls.size}`);
      const args = parseArgs(evt.arguments, state.argBuffers.get(id));
      state.pendingCalls.set(id, { name: String(evt.name ?? ''), args });
      /* 参数还没到齐就先不发 —— 等 tool_call_done 拿到完整 arguments 再发,
       * 保证 tool_call 事件的 input 一定是真参数, 而不是空对象。 */
      if (!hasKeys(args)) return [];
      state.emittedCalls.add(id);
      return [{ type: 'tool_call', tool: String(evt.name ?? ''), input: args, id }];
    }
    case 'tool_call_done':
    case 'tool_output': {
      const id = String(evt.id ?? `${evt.name}:end`);
      const tool = String(evt.name ?? '');
      const out: AgentEvent[] = [];
      /* start 时参数没到齐的话, 这里补发 tool_call, 保证消费方总能拿到 input */
      if (!state.emittedCalls.has(id)) {
        const args = parseArgs(evt.arguments, state.argBuffers.get(id));
        if (hasKeys(args)) {
          state.emittedCalls.add(id);
          out.push({ type: 'tool_call', tool, input: args, id });
        }
      }
      state.pendingCalls.delete(id);
      state.argBuffers.delete(id);
      const success = evt.success !== false;
      out.push(
        success
          ? { type: 'tool_result', tool, output: evt.output ?? '', id }
          : { type: 'tool_error', tool, error: String(evt.error ?? evt.output ?? 'tool failed'), id },
      );
      return out;
    }
    case 'token_usage': {
      /* kernel 的 TokenUsage 是 snake_case (prompt_tokens / completion_tokens),
       * 这里原本只读 camelCase, 一个都对不上 —— 所以 AgentResult.usage 一直是 0。
       * 另外 kernel 每个请求发一条 is_final:true, 多步 run 会有多条:
       * 要累加成整轮总量, 不是覆盖。 */
      const u = evt.usage ?? evt;
      if (evt.is_final === false) return [];   // 增量快照, 不计入
      const inTok = num(u.prompt_tokens, u.promptTokens, u.inputTokens);
      const outTok = num(u.completion_tokens, u.completionTokens, u.outputTokens);
      const cacheRead = num(u.prompt_cache_hit_tokens, u.cached_tokens, u.cacheReadTokens, u.prompt_tokens_details?.cached_tokens);
      const cacheWrite = num(u.prompt_cache_miss_tokens, u.cacheWriteTokens);
      if (inTok !== null) state.usage.inputTokens += inTok;
      if (outTok !== null) state.usage.outputTokens += outTok;
      if (cacheRead !== null) state.usage.cacheReadTokens = (state.usage.cacheReadTokens ?? 0) + cacheRead;
      if (cacheWrite !== null) state.usage.cacheWriteTokens = (state.usage.cacheWriteTokens ?? 0) + cacheWrite;
      return [];
    }
    case 'run_done': {
      const stopReason: StopReason = evt.interrupted
        ? 'aborted'
        : evt.failed || state.errorFromStream
          ? 'tool_error'
          : 'end_turn';
      state.stopReason = stopReason;
      return [{ type: 'done', usage: { ...state.usage }, stopReason }];
    }
    case 'error': {
      const err = evt.error instanceof Error
        ? evt.error
        : new Error(String(evt.error ?? evt.message ?? 'runtime error'));
      state.errorFromStream = err;
      return [{ type: 'error', error: err }];
    }
    default:
      /* 其它 kernel 内部事件 (agent_updated_stream_event / iteration_start /
       * context_compaction / stream_retry / plan 等) SDK 不暴露, 忽略. */
      return [];
  }
}


/* ---------------------------------------------------------------- helpers */

/** 工具参数可能来自 evt.arguments(字符串/对象) 或流式累积的 delta 缓冲 */
function parseArgs(raw: unknown, buffered?: string): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  for (const candidate of [typeof raw === 'string' ? raw : '', buffered ?? '']) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* 参数还没流完, 不是错误 */ }
  }
  return {};
}

function hasKeys(o: Record<string, unknown>): boolean {
  return Object.keys(o).length > 0;
}

/** 取第一个是数字的候选字段 (兼容 snake_case / camelCase 两套命名) */
function num(...candidates: unknown[]): number | null {
  for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c)) return c;
  return null;
}
