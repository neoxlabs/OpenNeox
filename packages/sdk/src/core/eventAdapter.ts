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
import type { AgentEvent, TokenUsage, StopReason, Step } from '../types.js';

/** kernel 跑满 maxIterations 时发的那条 error 的原文 (core/runner.ts) —— 它是正常停止, 不是故障 */
const MAX_ITERATIONS_RE = /reached max iterations/i;

export interface EventTranslatorState {
  /** 累积 tool_call_start 的 args, tool_call_done 里才有 success / output */
  pendingCalls: Map<string, { name: string; args?: Record<string, unknown> }>;
  /** 累积 tool_call_delta 的 arguments_delta；完整参数通过增量事件补齐。 */
  argBuffers: Map<string, string>;
  /** 已经发过 tool_call 的 id —— 防止 start/done 两条路重复发 */
  emittedCalls: Set<string>;
  usage: TokenUsage;
  /** 整轮所有文字 (每一步模型说的话拼起来) —— 只留给需要完整过程的调用方 */
  textBuffer: string;
  finalText: string;
  /** 每一步 (kernel 的一次 iteration): 这一步说了什么、调了哪些工具、结果、耗时 */
  steps: Step[];
  stepStartedAt: number;
  /** tool id → 它在 steps 里那条记录, tool_output 回来时填 output / error */
  callRefs: Map<string, Step['toolCalls'][number]>;
  /** kernel 报了 Reached max iterations —— stopReason 记 max_steps, 不当成错误 */
  maxStepsHit: boolean;
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
    finalText: '',
    steps: [],
    stepStartedAt: Date.now(),
    callRefs: new Map(),
    maxStepsHit: false,
    stopReason: 'end_turn',
    errorFromStream: null,
  };
}

/** 当前这一步; kernel 没先发 iteration_start (mock / 老路径) 时补开一步 */
function currentStep(state: EventTranslatorState): Step {
  if (state.steps.length === 0) {
    state.stepStartedAt = Date.now();
    state.steps.push({ index: 0, toolCalls: [], durationMs: 0 });
  }
  return state.steps[state.steps.length - 1];
}

function closeStep(state: EventTranslatorState): AgentEvent[] {
  const s = state.steps[state.steps.length - 1];
  if (!s) return [];
  s.durationMs = Date.now() - state.stepStartedAt;
  return [{ type: 'step_end', step: s.index }];
}

/** 记一次工具调用 (tool_call 事件发出的同时) —— 之后的文字才算最终回答 */
function noteCall(state: EventTranslatorState, id: string, tool: string, input: unknown): void {
  state.finalText = '';
  const rec = { tool, input };
  currentStep(state).toolCalls.push(rec);
  state.callRefs.set(id, rec);
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
    case 'iteration_start': {
      const out = state.steps.length ? closeStep(state) : [];
      state.stepStartedAt = Date.now();
      const index = state.steps.length;
      state.steps.push({ index, toolCalls: [], durationMs: 0 });
      out.push({ type: 'step_start', step: index });
      return out;
    }
    case 'text_delta': {
      const delta = String(evt.delta ?? '');
      state.textBuffer += delta;
      state.finalText += delta;
      const s = currentStep(state);
      s.textDelta = (s.textDelta ?? '') + delta;
      return [{ type: 'text_delta', delta }];
    }
    case 'reasoning_delta': {
      const delta = String(evt.delta ?? '');
      const s = currentStep(state);
      s.thinkingDelta = (s.thinkingDelta ?? '') + delta;
      return [{ type: 'thinking', delta }];
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
      noteCall(state, id, String(evt.name ?? ''), args);
      return [{ type: 'tool_call', tool: String(evt.name ?? ''), input: args, id }];
    }
    case 'tool_call_done':
    case 'tool_output': {
      const id = String(evt.id ?? `${evt.name}:end`);
      const tool = String(evt.name ?? '');
      const out: AgentEvent[] = [];
      /* start 时参数没到齐的话, 这里补发 tool_call, 保证消费方总能拿到 input。
       * 到 tool_call_done 参数就是终稿了 —— 空参数 ({}) 的工具也在这里发, 不能拖到 tool_output:
       * 那样 tool_call 跟 tool_result 同时到, 消费方量出来的工具耗时恒为 0 */
      if (!state.emittedCalls.has(id)) {
        const args = parseArgs(evt.arguments, state.argBuffers.get(id));
        {
          state.emittedCalls.add(id);
          noteCall(state, id, tool, args);
          out.push({ type: 'tool_call', tool, input: args, id });
        }
      }
      if (evt.type === 'tool_call_done') return out;
      state.pendingCalls.delete(id);
      state.argBuffers.delete(id);
      const success = evt.success !== false;
      const rec = state.callRefs.get(id);
      if (success) {
        if (rec) rec.output = evt.output ?? '';
        out.push({ type: 'tool_result', tool, output: evt.output ?? '', id });
      } else {
        const error = String(evt.error ?? evt.output ?? 'tool failed');
        if (rec) rec.error = error;
        out.push({ type: 'tool_error', tool, error, id });
      }
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
        : state.maxStepsHit
          ? 'max_steps'
          : evt.failed || state.errorFromStream
            ? 'tool_error'
            : 'end_turn';
      state.stopReason = stopReason;
      return [...closeStep(state), { type: 'done', usage: { ...state.usage }, stopReason }];
    }
    case 'error': {
      const err = evt.error instanceof Error
        ? evt.error
        : new Error(String(evt.error ?? evt.message ?? 'runtime error'));
      if (MAX_ITERATIONS_RE.test(err.message)) {
        state.maxStepsHit = true;
        return [];
      }
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
