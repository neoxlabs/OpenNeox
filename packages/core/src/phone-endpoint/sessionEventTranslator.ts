import type { AgentRuntimeEvent } from '../runtime/runtimeTypes.js';
import type { RpcMessage } from '../relay-transport/index.js';
import type { PhoneHistoryStore } from './historyStore.js';

export interface HistoryEvent {
  seq: number;
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** 手机开着时间线时该看到、且 session.subscribe 要能补的待答问题 */
export interface PendingAskUserSnapshot {
  request_id: string;
  questions: unknown[];
  turn_id?: string | null;
  created_at: number;
}

const MAX_HISTORY = 2000;
const MAX_PENDING_ASKS = 20;
const TOOL_OUTPUT_CAP = 4096;

export class SessionEventTranslator {
  private history: HistoryEvent[] = [];
  private seq = 0;
  private textBuf = new Map<string, string>();
  private thinkingBuf = new Map<string, string>();
  private toolNameById = new Map<string, string>();
  private fallbackCounters = new Map<string, number>();
  private announcedToolDeltas = new Set<string>();
  private runMeta: { iterations: number; toolCalls: number; durationMs: number; totalTokens: number; failed: boolean } | null = null;
  private running = false;
  private currentTurn: string | null = null;
  private step: string | null = null;
  /** 手机来晚了 (ask 已经发出去了才打开会话 / 重连): subscribe 快照要能补出卡片 */
  private pendingAsks = new Map<string, PendingAskUserSnapshot>();

  constructor(
    private sessionId: string,
    private push: (msg: RpcMessage) => void,
    private store?: PhoneHistoryStore,
  ) {
    const restored = store?.load() ?? [];
    if (restored.length > 0) {
      this.history = restored.slice(-MAX_HISTORY);
      this.seq = this.history.reduce((max, e) => Math.max(max, e.seq), 0);
    }
  }

  latestSeq(): number { return this.seq; }
  isRunning(): boolean { return this.running; }
  status(): { busy: boolean; step: string | null; turn_id: string | null } {
    return { busy: this.running, step: this.running ? this.step : null, turn_id: this.currentTurn };
  }

  /** 待答的 ask_user —— session.subscribe 的 pending_actions 用 */
  pendingAskUsers(): PendingAskUserSnapshot[] { return [...this.pendingAsks.values()]; }

  /** 手机 / 终端答完了 (或问题作废): 快照里不能再留着 */
  resolveAskUser(requestId: string): void {
    if (requestId) this.pendingAsks.delete(requestId);
  }

  askUserAnswered(requestId: string, answers: Record<string, string>): void {
    if (!requestId) return;
    this.pendingAsks.delete(requestId);
    this.stream('ask_user_answered', { request_id: requestId, answers: answers ?? {} });
  }

  getHistory(beforeSeq = Number.MAX_SAFE_INTEGER, limit = 200): HistoryEvent[] {
    const cap = Math.max(1, Math.min(500, Math.floor(limit || 200)));
    const upper = Number.isFinite(beforeSeq) && beforeSeq > 0 ? Math.floor(beforeSeq) : Number.MAX_SAFE_INTEGER;
    return this.history.filter((e) => e.seq < upper).slice(-cap);
  }

  /** 开远程之前的对话: 只灌历史 (不推流), 手机打开时不是一页空白 */
  seed(kind: 'user_message' | 'agent_text', content: string, ts?: number): void {
    if (!content.trim()) return;
    this.record(kind, kind === 'user_message' ? { text: content, turn_id: 'seed' } : { content, turn_id: 'seed' }, ts);
  }

  /**
   * 批量回灌 (会话库里最近的用户 / 助手文字), 跳过已经落盘的尾部。
   *
   * 落盘之后每次 /rc 都会把会话库最近 60 条再灌一遍 —— 不去重就是每开关一次多一份。
   * 做法: 找「已落盘的最后一条文字」在列表里的位置, 只补它后面的; 找不到说明这 60 条
   * 都比落盘的更新, 整批补上。
   */
  seedBatch(items: Array<{ role: 'user' | 'assistant'; text: string; ts?: number }>): void {
    if (items.length === 0) return;
    const lastText = [...this.history]
      .reverse()
      .map((e) => (e.kind === 'user_message' ? e.payload.text : e.kind === 'agent_text' ? e.payload.content : null))
      .find((t): t is string => typeof t === 'string' && t.trim().length > 0);
    let start = 0;
    if (lastText) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].text.trim() === lastText.trim()) { start = i + 1; break; }
      }
    }
    for (const m of items.slice(start)) {
      this.seed(m.role === 'user' ? 'user_message' : 'agent_text', m.text, m.ts);
    }
  }

  /** 一轮开始 (CLI 里打字或手机发来都走这) */
  turnStart(turnId: string, userText: string, source?: 'phone' | 'cli'): void {
    this.running = true;
    this.currentTurn = turnId;
    if (userText.trim()) this.commit('user_message', { text: userText, turn_id: turnId, ...(source ? { source } : {}) });
    this.stream('run_state_changed', { status: 'running', turn_id: turnId, pending_tool_calls: [] });
  }

  /** 一轮结束 (正常 / 出错 / 被中断) */
  turnEnd(turnId: string, error?: string): void {
    this.flushText(turnId);
    this.flushThinking(turnId);
    /* 这一轮收口了, 没答的 ask 不再有效 —— 不然手机还会画出点不动的卡 */
    this.pendingAsks.clear();
    if (error) {
      this.stream('agent_text_delta', { content: `❌ ${error}`, turn_id: turnId });
      this.stream('agent_text_done', { turn_id: turnId });
      this.commit('agent_text', { content: `❌ ${error}`, turn_id: turnId });
    }
    const m = this.runMeta;
    this.stream('agent_turn_done', {
      turn_id: turnId,
      iterations: m?.iterations ?? 0,
      tool_calls: m?.toolCalls ?? 0,
      duration_ms: m?.durationMs ?? 0,
      total_tokens: m?.totalTokens ?? 0,
      failed: !!error || !!m?.failed,
    });
    this.runMeta = null;
    this.running = false;
    this.currentTurn = null;
    this.step = null;
    this.stream('run_state_changed', { status: 'idle', turn_id: turnId, pending_tool_calls: [], ...(error ? { error } : {}) });
  }

  handle(event: AgentRuntimeEvent, turnId: string): void {
    const ev = event as any;
    switch (event.type) {
      case 'text':
        if (ev.delta) {
          this.flushThinking(turnId);
          this.textBuf.set(turnId, `${this.textBuf.get(turnId) ?? ''}${ev.delta}`);
          this.stream('agent_text_delta', { content: ev.delta, turn_id: turnId });
        }
        return;
      case 'text_complete':
        this.stream('agent_text_done', { turn_id: turnId });
        this.flushText(turnId);
        return;
      case 'reasoning':
        if (ev.delta) {
          this.thinkingBuf.set(turnId, `${this.thinkingBuf.get(turnId) ?? ''}${ev.delta}`);
          this.stream('agent_thinking_delta', { content: ev.delta, turn_id: turnId });
        }
        return;
      case 'tool_call_start': {
        this.flushThinking(turnId);
        this.flushText(turnId);
        const toolId = ev.toolId || this.fallbackId(turnId, ev.name);
        this.toolNameById.set(toolId, ev.name);
        this.step = ev.name;
        this.commit('tool_call', { tool_call_id: toolId, tool_name: ev.name, args: ev.args ?? {}, turn_id: turnId });
        this.stream('tool_running', { tool_name: ev.name, args: ev.args ?? {}, tool_call_id: toolId, turn_id: turnId });
        return;
      }
      case 'tool_output':
      case 'tool_call_end': {
        const toolId = ev.toolId || this.fallbackId(turnId, ev.name);
        const toolName = ev.name || this.toolNameById.get(toolId) || '';
        const output = typeof ev.output === 'string' ? ev.output.slice(0, TOOL_OUTPUT_CAP) : undefined;
        const base = {
          tool_call_id: toolId, tool_name: toolName, ok: ev.success, output,
          summary: ev.summary, duration: ev.duration, target_path: ev.targetPath,
        };
        if (event.type === 'tool_output') {
          this.stream('tool_done', base);
          return;
        }
        /* ask_user 工具出结果 = 问题已经答了 (不管在哪答的) */
        if (toolName === 'ask_user') this.pendingAsks.clear();
        const full = { ...base, tool_status: ev.toolStatus, tool_error: ev.toolError };
        this.stream('tool_done', full);
        this.commit('tool_result', { ...full, turn_id: turnId });
        this.toolNameById.delete(toolId);
        return;
      }
      case 'token_usage':
        this.stream('metrics', {
          tokens: ev.totalTokens ?? 0, context_used: ev.contextTokens ?? 0,
          input_tokens: ev.promptTokens ?? 0, output_tokens: ev.completionTokens ?? 0,
          cache_read_tokens: ev.cacheReadTokens ?? 0, cache_write_tokens: ev.cacheWriteTokens ?? 0,
          turn_id: turnId,
        });
        return;
      case 'run_result':
        this.runMeta = {
          iterations: ev.iterations ?? 0, toolCalls: ev.toolCalls ?? 0, durationMs: ev.durationMs ?? 0,
          totalTokens: ev.totalTokens ?? 0, failed: !!ev.failed,
        };
        return;
      case 'error': {
        const msg = ev.message ?? ev.error ?? 'agent encountered error';
        this.stream('agent_text_delta', { content: `❌ ${msg}`, turn_id: turnId });
        this.stream('agent_text_done', { turn_id: turnId });
        this.commit('agent_text', { content: `❌ ${msg}`, turn_id: turnId });
        return;
      }
      case 'shell_output_stream':
        this.stream('shell_output_stream', {
          tool_id: ev.toolId, command: ev.command, output_delta: ev.outputDelta,
          elapsed: ev.elapsed, is_complete: ev.isComplete, exit_code: ev.exitCode, turn_id: turnId,
        });
        return;
      case 'plan_update':
        this.stream('plan_update', { explanation: ev.explanation, plan: ev.plan, turn_id: turnId });
        return;
      case 'tool_call_delta': {
        const key = String(ev.toolId ?? `${turnId}:${ev.name ?? ''}`);
        if (this.announcedToolDeltas.has(key)) return;
        this.announcedToolDeltas.add(key);
        if (this.announcedToolDeltas.size > 500) this.announcedToolDeltas.clear();
        this.stream('tool_call_delta', { name: ev.name, tool_name: ev.toolName ?? ev.name, tool_id: ev.toolId, turn_id: turnId });
        return;
      }
      case 'thinking':
        this.stream('thinking', { iteration: ev.iteration, turn_id: turnId });
        return;
      case 'status':
        this.stream('status', { level: 'info', message: ev.message, status: ev.status, turn_id: turnId });
        return;
      case 'compacting':
        this.stream('compacting', { message: ev.message, detail: ev.detail, turn_id: turnId });
        return;
      case 'stream_retry':
        this.stream('stream_retry', {
          error: ev.error, error_code: ev.errorCode, attempt: ev.attempt, max_retries: ev.maxRetries,
          delay_ms: ev.delayMs, is_rate_limit: ev.isRateLimit, turn_id: turnId,
        });
        return;
      case 'stream_recovered':
        this.stream('stream_recovered', { attempt: ev.attempt, max_retries: ev.maxRetries, turn_id: turnId });
        return;
      case 'error_classified':
        this.stream('error_classified', {
          category: ev.category, code: ev.code, message: ev.message, suggestion: ev.suggestion,
          retryable: ev.retryable, turn_id: turnId,
        });
        return;
      case 'ask_user_needed': {
        const requestId = String(ev.requestId ?? '');
        if (requestId) {
          this.pendingAsks.set(requestId, {
            request_id: requestId,
            questions: Array.isArray(ev.questions) ? ev.questions : [],
            turn_id: turnId,
            created_at: Date.now(),
          });
          if (this.pendingAsks.size > MAX_PENDING_ASKS) {
            const oldest = this.pendingAsks.keys().next().value;
            if (oldest) this.pendingAsks.delete(oldest);
          }
        }
        this.stream('ask_user_needed', { request_id: requestId, questions: ev.questions, turn_id: turnId });
        return;
      }
      case 'ask_user_expired': {
        const requestId = String(ev.requestId ?? ev.request_id ?? '');
        if (requestId) this.pendingAsks.delete(requestId);
        this.stream('ask_user_expired', { request_id: requestId, turn_id: turnId });
        return;
      }
      case 'session_title_generated':
        this.stream('session_title_generated', { title: ev.title });
        return;
      case 'user_message_injected':
        /* 跑着的时候插的话: 也进历史, 手机重开时看得到 */
        if (typeof ev.text === 'string' && ev.text.trim()) this.commit('user_message', { text: ev.text, turn_id: turnId });
        this.stream('user_message_injected', { ...ev, turn_id: turnId });
        return;
      default:
        return;
    }
  }

  private fallbackId(turnId: string, name?: string): string {
    const key = `${turnId}:${name ?? '?'}`;
    const n = (this.fallbackCounters.get(key) ?? 0) + 1;
    this.fallbackCounters.set(key, n);
    return `tc-${turnId}-${name ?? '?'}-${n}`;
  }

  private flushText(turnId: string): void {
    const content = this.textBuf.get(turnId);
    if (!content) return;
    this.textBuf.delete(turnId);
    this.commit('agent_text', { content, turn_id: turnId });
  }

  private flushThinking(turnId: string): void {
    const content = this.thinkingBuf.get(turnId);
    if (!content) return;
    this.thinkingBuf.delete(turnId);
    this.commit('agent_thinking', { content, turn_id: turnId });
  }

  private record(kind: string, payload: Record<string, unknown>, ts = Date.now()): HistoryEvent {
    const e: HistoryEvent = { seq: ++this.seq, ts, kind, payload };
    this.history.push(e);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.store?.append(e);
    return e;
  }

  private commit(kind: string, payload: Record<string, unknown>): void {
    this.flushDelta();
    const e = this.record(kind, payload);
    this.push({ jsonrpc: '2.0', method: 'session.event', params: { session_id: this.sessionId, seq: e.seq, ts: e.ts, kind, payload } });
  }

  /* 逐字增量合并: 模型一秒能吐几十个 delta, 每个都加密过中转再让手机重排一次版, 手机发烫、中转白跑。
   * 同一轮同一种 delta 攒 DELTA_FLUSH_MS 一起发; 任何别的事件先把攒着的发掉, 顺序不乱。 */
  private pendingDelta: { kind: string; turnId: string; content: string } | null = null;
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  private flushDelta(): void {
    if (this.deltaTimer) { clearTimeout(this.deltaTimer); this.deltaTimer = null; }
    const d = this.pendingDelta;
    if (!d) return;
    this.pendingDelta = null;
    this.send(d.kind, { content: d.content, turn_id: d.turnId });
  }

  private stream(kind: string, payload: Record<string, unknown>): void {
    if (kind === 'agent_text_delta' || kind === 'agent_thinking_delta') {
      const turnId = String(payload.turn_id ?? '');
      const content = String(payload.content ?? '');
      if (this.pendingDelta && (this.pendingDelta.kind !== kind || this.pendingDelta.turnId !== turnId)) this.flushDelta();
      if (this.pendingDelta) this.pendingDelta.content += content;
      else this.pendingDelta = { kind, turnId, content };
      if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
      return;
    }
    this.flushDelta();
    this.send(kind, payload);
  }

  private send(kind: string, payload: Record<string, unknown>): void {
    /* 流式不入历史, seq=0 (跟客户端 / pod 一致) */
    this.push({ jsonrpc: '2.0', method: 'session.event', params: { session_id: this.sessionId, seq: 0, ts: Date.now(), kind, payload } });
  }
}

const DELTA_FLUSH_MS = 60;
