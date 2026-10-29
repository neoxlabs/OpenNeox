/**
 * agentStreamForwarder.ts — Stage 1: 真 streaming 协议.
 *
 * 把 AgentBridge 'stream' events 转成 mobile 协议的 session.event 直接 push.
 * 关键决策:
 *   - token delta: 直接 push 'agent_text_delta', 不入 SessionContext (避免每帧
 *     落 drift / spam onAppend; mobile 端按 turn_id 累积 in-memory buffer)
 *   - text_complete: 走 SessionContext.appendMessage('assistant', fullText) —
 *     onAppend → sessionEventBridge 推 'agent_text' 进 drift; mobile 收到 done
 *     时把 buffer commit 给 drift 渲染
 *   - reasoning / tool 同样的 delta + done 双轨
 *
 * Mobile 端协议 kinds (新):
 *   - agent_text_delta   { content, turn_id }       — 流, 不入库, in-memory 累积
 *   - agent_text_done    { turn_id }                — buffer 释放标记
 *   - agent_thinking_delta { content, turn_id }
 *   - agent_thinking_done  { turn_id }
 *   - tool_running       { tool_name, args, tool_call_id, turn_id } — live 状态
 *   - tool_done          { tool_call_id, ok }       — 状态切到完成
 *
 * SessionContext 路径仍管 "最终成型消息" 入 drift:
 *   text_complete → SessionContext.append assistant text → sessionEventBridge
 *   reasoning_complete → SessionContext.append assistant thinking → bridge
 *   tool_call_start → SessionContext.append assistant tool_calls → bridge
 *   tool_output → SessionContext.append tool result → bridge
 */

import type { SessionContext as SessionContextClass } from '@neoxlabs/platform/platform/sessionContext.js';
import { getMobileBridgeServer } from './index.js';
import { makeNotification } from './jsonRpc.js';
import { recordIdleFromTurnDone, recordRunState } from './runStateMirror.js';
import { bridgeLog as flog } from './log.js';
import {
  clearPendingActions,
  getPendingActions,
  recordApprovalNeeded,
  recordAskUserNeeded,
  removeApproval,
  removeAskUser,
} from './pendingActionsRegistry.js';
import {
  clearActiveSubagents,
  recordPlanUpdate,
  recordSubagentDone,
  recordSubagentStart,
} from './sessionUiStateRegistry.js';
import { registerArtifact, looksLikeArtifact } from './artifactRegistry.js';
import { scanArtifactPaths } from './artifactScan.js';

const attached = new WeakSet<object>();

/* ── 每 sessionId+turnId 累积 token text — text_complete 时一起写 drift ──
 *   agent runtime 的 text_complete 事件 keys 只有 sequence, 没 text/content,
 *   全文是通过 token 事件 delta 累积来的. 旧逻辑直接读 evt.text → 0 长度 → SKIP, agent
 *   回复永远不入 drift, mobile 看到的 reply 只是 streaming buffer 没清掉 (那是临时态).
 *   修法: 这里维护本地累积, text_complete 用累积值落 drift. */
const tokenAccum = new Map<string, string>();
function accumKey(sessionId: string, turnId: string): string {
  return `${sessionId}|${turnId}`;
}
function accumAppend(sessionId: string, turnId: string, delta: string): void {
  if (!delta) return;
  const k = accumKey(sessionId, turnId);
  tokenAccum.set(k, (tokenAccum.get(k) ?? '') + delta);
}
function accumTake(sessionId: string, turnId: string): string {
  const k = accumKey(sessionId, turnId);
  const v = tokenAccum.get(k) ?? '';
  tokenAccum.delete(k);
  return v;
}

const currentTurnId = new Map<string, string>();
let syntheticTurnSeq = 0;
/** 真 turn id = 非空且非字面量 'default' (grok 等缺 turnId 时的旧兜底值)。 */
export function isRealTurnId(t: string | undefined | null): t is string {
  return typeof t === 'string' && t.length > 0 && t !== 'default';
}
/** 本 session 当前轮 id (drift/history 归轮兜底用) — 由 run_state_changed 记住。 */
export function getSessionCurrentTurnId(sessionId: string): string | undefined {
  return currentTurnId.get(sessionId);
}
/** 把一条 mobile-facing 消息的 turn_id 归一化: 真 id 直用; 空/`default` 用本 session
 *  当前轮 id 兜底 (根治手机 timeline 跨轮串味 — assistant drift 常带空 turnId)。 */
export function normalizeMobileTurnId(sessionId: string, rawTurnId: string | undefined): string {
  if (isRealTurnId(rawTurnId)) return rawTurnId;
  return currentTurnId.get(sessionId) ?? rawTurnId ?? '';
}
/** 解析一条事件应归属的 turn_id — 真 id 优先并记忆, 缺失时复用本 session 当前轮,
 *  再没有就在"新一轮"起点铸一个合成唯一 id (兼容完全不发 turnId 的模型)。
 *  @param status run_state_changed 携带的运行态 (running/idle/...), 只有开轮态才铸新 id。 */
function resolveTurnId(
  sessionId: string,
  type: string,
  rawTurn: string | undefined,
  status: string | undefined,
  isHeartbeat?: boolean,
): string {
  if (isRealTurnId(rawTurn)) {
    currentTurnId.set(sessionId, rawTurn);
    return rawTurn;
  }
  if (!isHeartbeat && type === 'run_state_changed' && (status === 'running' || status === 'started')) {
    const synth = `turn-${sessionId.slice(0, 8)}-${Date.now().toString(36)}-${++syntheticTurnSeq}`;
    currentTurnId.set(sessionId, synth);
    return synth;
  }
  return currentTurnId.get(sessionId) ?? 'default';
}

const TOOL_ARG_KEYS = new Set<string>([
  'command', 'cmd', 'code', 'script',
  'file_path', 'path', 'paths',
  'pattern', 'query', 'regex', 'keywords',
  'url', 'urls',
  'start_line', 'end_line', 'num_lines', 'ranges', 'anchor_lines',
  'old_string', 'new_string', 'replace_all',
  'step', 'status', 'plan',                  // update_plan
  'tool_name', 'arguments',                  // 嵌套 tool_call 形态
  'content', 'text',                         // write_file/edit
  'symbol', 'symbol_kind',                   // readfile symbol search
]);

function looksLikeToolArgsJson(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.some((k) => TOOL_ARG_KEYS.has(k));
}

function stripStandaloneJson(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '{') {
      /* 用 brace 匹配 + 字符串/转义状态机找 { 对应的 } */
      let depth = 0;
      let inStr = false;
      let escape = false;
      let endIdx = -1;
      for (let j = i; j < text.length; j++) {
        const c = text[j]!;
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (c === '\\') escape = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { endIdx = j + 1; break; }
        }
      }
      if (endIdx > 0) {
        const candidate = text.slice(i, endIdx);
        try {
          const parsed = JSON.parse(candidate);
          if (looksLikeToolArgsJson(parsed)) {
            /* 合法 + shape 像 tool args → 跳过, 不进 result */
            i = endIdx;
            continue;
          }
          /* 合法但是不像 tool args (用户内容 / 演示 JSON) → 保留 */
        } catch {
          /* 不是 JSON, 当普通字符保留 */
        }
      }
    }
    result += ch;
    i++;
  }
  /* 清理 strip 之后留下的连续空白 / 多余换行 */
  return result.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* reasoning 同理 — reasoning_complete 也可能空, 累积 reasoning delta */
const reasonAccum = new Map<string, string>();

const streamOrderCounter = new Map<string, number>();
const pendingTextOrder = new Map<string, number>();
const pendingReasonOrder = new Map<string, number>();
function nextStreamOrder(sessionId: string, turnId: string): number {
  const k = accumKey(sessionId, turnId);
  const n = (streamOrderCounter.get(k) ?? 0) + 1;
  streamOrderCounter.set(k, n);
  return n;
}
/** 段首 token 到达时锁定本段序号 (幂等 — 已有就不动). */
function lockSegmentOrder(
  pending: Map<string, number>,
  sessionId: string,
  turnId: string,
): void {
  const k = accumKey(sessionId, turnId);
  if (!pending.has(k)) pending.set(k, nextStreamOrder(sessionId, turnId));
}
/** 段收口时取走锁定的序号; 全程没 token 的段现取现用. */
function takeSegmentOrder(
  pending: Map<string, number>,
  sessionId: string,
  turnId: string,
): number {
  const k = accumKey(sessionId, turnId);
  const v = pending.get(k);
  pending.delete(k);
  return v ?? nextStreamOrder(sessionId, turnId);
}

/* ── 活跃工具登记 — attach 快照用 (tool_running 已推但 tool_done 未到的). ── */
interface LiveTool { tool_call_id: string; tool_name: string; args: unknown }
const liveRunningTools = new Map<string, Map<string, LiveTool>>();
function markToolRunning(sessionId: string, callId: string, name: string, args: unknown): void {
  if (!callId) return;
  let m = liveRunningTools.get(sessionId);
  if (!m) { m = new Map(); liveRunningTools.set(sessionId, m); }
  const prev = m.get(callId);
  m.set(callId, {
    tool_call_id: callId,
    tool_name: name || prev?.tool_name || 'tool',
    args: args && typeof args === 'object' && Object.keys(args as object).length > 0 ? args : prev?.args ?? {},
  });
}
function markToolDone(sessionId: string, callId: string): void {
  liveRunningTools.get(sessionId)?.delete(callId);
}

/** Mid-stream attach 快照 — session.subscribe 时把"本轮已生成但还没落 drift 的
 *  半成品" (流式正文/思考 + 在跑工具) 一并返回, 手机进来即见完整现场而不是
 *  空白等 text_complete。语义: REPLACE (phone 直接用它重置本轮 streaming buffer,
 *  后续 delta 继续 append)。调用方必须先 flushPendingDeltas(sessionId) 再取快照,
 *  否则排队中的 delta 会在快照之后重放造成重复拼接。 */
export interface LiveStreamingSnapshot {
  turn_id: string;
  partial_text: string;
  partial_thinking: string;
  running_tools: LiveTool[];
}
export function getLiveStreamingSnapshot(sessionId: string): LiveStreamingSnapshot | null {
  const turn = currentTurnId.get(sessionId);
  if (!turn) return null;
  const k = accumKey(sessionId, turn);
  const partialText = tokenAccum.get(k) ?? '';
  const partialThinking = reasonAccum.get(k) ?? '';
  const tools = Array.from(liveRunningTools.get(sessionId)?.values() ?? []);
  if (!partialText && !partialThinking && tools.length === 0) return null;
  return {
    turn_id: turn,
    partial_text: partialText,
    partial_thinking: partialThinking,
    running_tools: tools,
  };
}

export function _clearAllForwarderStateForTest(): void {
  tokenAccum.clear();
  reasonAccum.clear();
  toolAccum.clear();
  emittedToolCall.clear();
  liveRunningTools.clear();
  currentTurnId.clear();
  streamOrderCounter.clear();
  pendingTextOrder.clear();
  pendingReasonOrder.clear();
  for (const q of deltaQueues.values()) {
    if (q.timer) clearTimeout(q.timer);
  }
  deltaQueues.clear();
}

/** 一轮收尾 / 中断时清掉该 session 的全部流式暂存 — 修泄漏: abort 掉的轮
 *  text_complete 永不来, tokenAccum/toolAccum 的 key 会永久滞留。 */
function clearSessionStreamState(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const k of tokenAccum.keys()) if (k.startsWith(prefix)) tokenAccum.delete(k);
  for (const k of reasonAccum.keys()) if (k.startsWith(prefix)) reasonAccum.delete(k);
  for (const k of toolAccum.keys()) if (k.startsWith(prefix)) toolAccum.delete(k);
  for (const k of emittedToolCall) if (k.startsWith(prefix)) emittedToolCall.delete(k);
  for (const k of toolStartedAt.keys()) if (k.startsWith(prefix)) toolStartedAt.delete(k);
  for (const k of streamOrderCounter.keys()) if (k.startsWith(prefix)) streamOrderCounter.delete(k);
  for (const k of pendingTextOrder.keys()) if (k.startsWith(prefix)) pendingTextOrder.delete(k);
  for (const k of pendingReasonOrder.keys()) if (k.startsWith(prefix)) pendingReasonOrder.delete(k);
  liveRunningTools.delete(sessionId);
}

/* tool_call_delta 累积: 不同 runtime emit 不一样, 有的只有 delta + end (没 start).
 *   按 (sessionId + callId) 维度积 name / args 字符串 chunk. tool_call_end 时一起 commit. */
interface ToolAccum { name: string; argsStr: string; callId: string }
const toolAccum = new Map<string, ToolAccum>();

const emittedToolCall = new Set<string>();
const toolStartedAt = new Map<string, number>();
function callKey(sessionId: string, callId: string): string {
  return `${sessionId}|${callId}`;
}
function toolKey(sessionId: string, callId: string): string {
  return `${sessionId}|${callId}`;
}
function reasonAppend(sessionId: string, turnId: string, delta: string): void {
  if (!delta) return;
  const k = accumKey(sessionId, turnId);
  reasonAccum.set(k, (reasonAccum.get(k) ?? '') + delta);
}
function reasonTake(sessionId: string, turnId: string): string {
  const k = accumKey(sessionId, turnId);
  const v = reasonAccum.get(k) ?? '';
  reasonAccum.delete(k);
  return v;
}

export function attachAgentBridgeForwarder(bridge: any): void {
  if (!bridge || typeof bridge.on !== 'function') return;
  if (attached.has(bridge)) return;
  attached.add(bridge);
  bridge.on('stream', (event: any) => {
    void handleStreamEvent(event).catch((err: any) => {
      flog('fwd:ERR', 'handle stream failed: ' + (err?.message ?? err));
    });
  });
  flog('fwd:init', 'attached stream forwarder to AgentBridge');
}

/** 立即推 streaming event 给所有订阅了这个 session 的 mobile conn — 不入 drift.
 *  只允许 flushPendingDeltas / pushStreamEvent 调; 业务 case 一律走带合帧屏障的
 *  pushStreamEvent, delta 类走 queueDeltaEvent. */
function pushStreamEventNow(sessionId: string, kind: string, payload: any, seq = 0): void {
  const server = getMobileBridgeServer();
  if (!server) return;
  /* 看是否有 mobile 订阅了, 没有就跳 */
  let has = false;
  for (const conn of server.listConns()) {
    if (conn.subscribedSessionIds.has(sessionId)) { has = true; break; }
  }
  if (!has) {
    flog('fwd:OUT-stream', `SKIP no-sub kind=${kind} session=${sessionId.slice(0,16)}`);
    return;
  }
  const notif = makeNotification('session.event', {
    session_id: sessionId,
    /* 默认 0 = streaming delta, 手机端不写库 (drift 不写)。
     * 但 user_message 是要入库的实体消息 —— 它必须带**真实 seq**, 否则手机端把它
     * 当 delta 丢掉, 表现就是"agent 回复在, 用户自己那条永远不出现"。 */
    seq,
    ts: Date.now(),
    kind,
    payload,
  });
  try {
    const summary = {
      kind,
      turn_id: payload?.turn_id,
      contentLen: typeof payload?.content === 'string' ? payload.content.length : undefined,
      chunkLen: typeof payload?.chunk === 'string' ? payload.chunk.length : undefined,
      tool_call_id: payload?.tool_call_id,
      ok: payload?.ok,
      tool_name: payload?.tool_name,
    };
    flog('fwd:OUT-stream', '→mobile ' + JSON.stringify(summary));
  } catch { /* ignore */ }
  server.pushToSessionSubscribers(sessionId, notif);
}

const DELTA_FLUSH_MS = 40;
interface PendingDelta { kind: string; mergeKey: string; field: 'content' | 'chunk'; payload: any }
const deltaQueues = new Map<string, { items: PendingDelta[]; timer: ReturnType<typeof setTimeout> | null }>();

function queueDeltaEvent(
  sessionId: string,
  kind: string,
  mergeKey: string,
  field: 'content' | 'chunk',
  payload: any,
): void {
  let q = deltaQueues.get(sessionId);
  if (!q) {
    q = { items: [], timer: null };
    deltaQueues.set(sessionId, q);
  }
  const existing = q.items.find((it) => it.kind === kind && it.mergeKey === mergeKey);
  if (existing) {
    existing.payload[field] = (existing.payload[field] ?? '') + (payload[field] ?? '');
  } else {
    q.items.push({ kind, mergeKey, field, payload });
  }
  if (!q.timer) {
    q.timer = setTimeout(() => {
      q!.timer = null;
      flushPendingDeltas(sessionId);
    }, DELTA_FLUSH_MS);
    (q.timer as any).unref?.();
  }
}

/** 把 session 排队中的 delta 立即按序推出去。session.subscribe 构建 attach 快照前
 *  必须调它 — 否则快照(含累积全文)之后又重放排队 delta, 手机端重复拼接。 */
export function flushPendingDeltas(sessionId: string): void {
  const q = deltaQueues.get(sessionId);
  if (!q) return;
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  if (q.items.length === 0) return;
  const items = q.items;
  q.items = [];
  for (const it of items) pushStreamEventNow(sessionId, it.kind, it.payload);
}

/** 非 delta 事件统一走这里: 先 flush 排队 delta (保序屏障) 再推. */
export function pushStreamEvent(sessionId: string, kind: string, payload: any, seq = 0): void {
  flushPendingDeltas(sessionId);
  pushStreamEventNow(sessionId, kind, payload, seq);
}

/** sessionId → workspacePath, 避免每条 tool_result 都去 loadSession 一次 */
const workspacePathCache = new Map<string, string | undefined>();

async function workspacePathOf(sessionId: string): Promise<string | undefined> {
  if (workspacePathCache.has(sessionId)) return workspacePathCache.get(sessionId);
  let wp: string | undefined;
  try {
    const storeMod: any = await import('@neoxlabs/core/platform/sessionStore.js');
    const s = await storeMod.sessionStore.loadSession(sessionId);
    wp = s?.workspacePath ?? undefined;
  } catch { /* 拿不到就登记不了产物, registerArtifact 会拦下 */ }
  workspacePathCache.set(sessionId, wp);
  return wp;
}

/**
 * 把这条 tool_result 报出来的产物登记掉, 返回挂到 tool_result 消息 meta 上的公开形状.
 *
 * 为什么挂在 tool_result 上而不是单独推一条 `artifact` 事件:
 *   pushStreamEvent 发的是 `seq: 0` 的流式事件, 手机端不写 drift —— 那样卡片
 *   一重启就没了, 而"我昨天让它做的那个 PPT"正是用户回头要找的东西。
 *   tool_result 本来就会持久化且带正确 seq, 挂上去自动获得持久性、顺序、
 *   以及"这个文件是哪个工具做的"这层归属。
 *
 * 全程 best-effort: 扫不出/越界/太大 都只是没有下载卡, 绝不影响这一轮 agent。
 */
async function collectToolArtifacts(
  sessionId: string,
  output: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  try {
    const paths = scanArtifactPaths(output).filter(looksLikeArtifact);
    if (paths.length === 0) return undefined;
    const workspacePath = await workspacePathOf(sessionId);
    if (!workspacePath) return undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const path of paths) {
      const pub = registerArtifact(sessionId, path, workspacePath);
      if (pub) out.push({ ...pub });
    }
    return out.length > 0 ? out : undefined;
  } catch (e: any) {
    flog('artifact:scan-failed', e?.message ?? String(e));
    return undefined;
  }
}

export async function handleStreamEvent(evt: any): Promise<void> {
  if (!evt || typeof evt !== 'object') return;
  const sessionId: string | undefined = evt.sessionId;
  if (!sessionId) return;
  const ts = evt.timestamp ?? Date.now();
  const type = evt.type;
  /* turn_id 归轮: 缺失时复用本 session 当前轮而非撞库到字面量 'default'
   *  (根治手机 timeline 跨轮串味 — 见 resolveTurnId 注释). */
  const turnId = resolveTurnId(
    sessionId,
    type,
    (evt.turnId ?? evt.messageId) as string | undefined,
    (evt.status ?? evt.state) as string | undefined,
    evt.heartbeat === true,
  );

  /* ── 全量诊断 — 每个 stream event in / 不管 skip 还是 dispatch 都打到文件.
   *   token / reasoning delta 除外: 每 token 一行是日志洪水,
   *   它们的净内容长度在合帧 flush 的 OUT-stream 行里已有. ─ */
  if (type !== 'token' && type !== 'reasoning') try {
    const peek = {
      type, turnId,
      session: sessionId.slice(0, 16),
      keys: Object.keys(evt).filter(k => !['sessionId', 'type', 'turnId', 'messageId', 'timestamp'].includes(k)),
      contentLen: typeof evt.content === 'string' ? evt.content.length : undefined,
      deltaLen: typeof evt.delta === 'string' ? evt.delta.length : undefined,
      textLen: typeof evt.text === 'string' ? evt.text.length : undefined,
      toolName: evt.toolName ?? evt.name ?? undefined,
      toolCallId: evt.toolCallId ?? evt.callId ?? evt.id ?? undefined,
    };
    flog('fwd:IN', JSON.stringify(peek));
  } catch { /* ignore */ }

  /* 真噪音事件 skip — 不会影响 mobile UI 的纯诊断/统计/快照类.
   *   approval / turn_complete / tool stream / session_interrupted 已移出 skip:
   *   它们承载 mobile 端可见的真状态, 之前误 skip 导致手机端永远卡 streaming buffer
   *   / 审批工具完全失声 / 长命令实时输出丢光. */
  /* metrics / token_usage — desktop adapter 实际推的是 'metrics' (带 contextUsed),
   *   runtime 原始定义是 'token_usage' (带 contextTokens). 两种 key 都接, 拿到 used context
   *   推给 mobile 显示百分比. 其他纯诊断字段不要. */
  if (type === 'metrics' || type === 'token_usage') {
    const used = (evt.contextUsed ?? evt.contextTokens ?? evt.context_tokens ?? 0) as number;
    if (used > 0) {
      pushStreamEvent(sessionId, 'context_usage', {
        context_tokens: used,
        input_tokens: (evt.inputTokens ?? evt.promptTokens ?? 0) as number,
        output_tokens: (evt.outputTokens ?? evt.completionTokens ?? 0) as number,
        cached_tokens: (evt.cacheReadTokens ?? evt.cachedTokens ?? 0) as number,
        turn_id: turnId,
      });
      flog('fwd:OUT-stream', `metrics → context_usage used=${used} turn=${turnId}`);
    }
    return;
  }

  /* 真噪音 skip 名单 — v1.1 起 plan_update / checkpoint / context_compaction /
   *   stream_retry / stream_recovered / worker_* 移出 (它们是 mobile timeline
   *   对齐桌面的可见信息, 下面各有 case 处理). */
  if (type === 'status' || type === 'log' || type === 'compacting' ||
      type === 'session_status' || type === 'worker_activity' ||
      type === 'memory_snapshot' ||
      type === 'assistant_state_snapshot' || type === 'assistant_projection' ||
      type === 'queued_message_added' ||
      type === 'queued_messages_processed' ||
      type === 'raw_response_event' ||
      type === 'worker_event' || type === 'worker_result' ||
      type === 'background_task') {
    return;
  }
  /* run_result 是 runtime 真"整轮跑完"信号 (turn_complete 实际不发, 我们一直缺这条信号
   *   导致 mobile "思考中..." 永远不消失). 这里转成 agent_turn_done streaming 推给 phone. */
  if (type === 'run_result') {
    /* contextUsed 是该轮结束时的总占用, 推一次 context_usage 兜底 (有些 runtime 不发 metrics) */
    const usedAtEnd = (evt.contextUsed ?? evt.data?.contextUsed ?? 0) as number;
    if (usedAtEnd > 0) {
      pushStreamEvent(sessionId, 'context_usage', {
        context_tokens: usedAtEnd,
        turn_id: turnId,
      });
    }
    clearActiveSubagents(sessionId); /* turn 收尾不可能还有活 worker */
    /* ExecutionState mirror BEFORE push — subscribe attach survives SKIP no-sub */
    recordIdleFromTurnDone(sessionId, turnId);
    pushStreamEvent(sessionId, 'agent_turn_done', { turn_id: turnId });
    /* 修泄漏: abort/异常轮的 accum key 永不被 text_complete 消费, 收尾统一清. */
    clearSessionStreamState(sessionId);
    flog('fwd:OUT-stream', `run_result → agent_turn_done turn=${turnId} usedCtx=${usedAtEnd}`);
    return;
  }

  /* ── v1.1 timeline 对齐桌面 — plan / subagent / 压缩 / checkpoint / 重试 ── */
  if (type === 'plan_update') {
    const rawPlan = Array.isArray(evt.plan) ? evt.plan : [];
    const plan = rawPlan
      .filter((s: any) => s && (typeof s.step === 'string' || typeof s.content === 'string'))
      .map((s: any) => ({
        step: (s.step ?? s.content ?? '') as string,
        status: (s.status ?? 'pending') as string,
      }));
    const explanation = (evt.explanation ?? null) as string | null;
    recordPlanUpdate(sessionId, { explanation, plan });
    pushStreamEvent(sessionId, 'plan_update', {
      explanation,
      plan,
      turn_id: turnId,
    });
    flog('fwd:OUT-stream', `plan_update steps=${plan.length} turn=${turnId}`);
    return;
  }
  if (type === 'worker_start') {
    const agentId = (evt.agentId ?? '') as string;
    if (!agentId) return;
    const info = {
      agent_id: agentId,
      task: (evt.task ?? '') as string,
      model: (evt.model ?? null) as string | null,
      model_inherited: evt.modelInherited === true,
      role_name: (evt.roleName ?? evt.role ?? evt.workerRole ?? null) as string | null,
      is_background: evt.isBackground === true,
      is_agent_tool: evt.isAgentTool === true,
    };
    recordSubagentStart(sessionId, info);
    flog('fwd:OUT-stream', `subagent_started agent=${agentId} isAgentTool=${String(evt.isAgentTool)} role=${info.role_name}`);
    pushStreamEvent(sessionId, 'subagent_started', { ...info, turn_id: turnId });
    return;
  }
  if (type === 'worker_complete') {
    const agentId = (evt.agentId ?? '') as string;
    if (!agentId) return;
    recordSubagentDone(sessionId, agentId);
    pushStreamEvent(sessionId, 'subagent_done', {
      agent_id: agentId,
      success: evt.success !== false,
      summary: (evt.summary ?? evt.error ?? '') as string,
      duration_ms: (evt.duration ?? 0) as number,
      turn_id: turnId,
    });
    return;
  }
  if (type === 'compacting') {
    pushStreamEvent(sessionId, 'context_compaction', {
      status: 'running',
      message: (evt.message ?? '') as string,
      detail: (evt.detail ?? '') as string,
      turn_id: turnId,
    });
    return;
  }
  if (
    type === 'context_compaction'
    || (type === 'raw_response_event' && evt.event_type === 'context_compaction')
  ) {
    const status = (evt.status ?? evt.data?.status ?? 'completed') as string;
    if (status === 'started' || status === 'compressing' || status === 'running') {
      pushStreamEvent(sessionId, 'context_compaction', {
        status: 'running',
        turn_id: turnId,
      });
      flog('fwd:OUT-stream', `context_compaction running turn=${turnId}`);
      return;
    }
    /* runtime 每次压缩 (含 no-op 校准) 都发 completed; 只转真省了 tokens 的. */
    const orig = (evt.originalTokens ?? evt.data?.originalTokens ?? 0) as number;
    const fin = (evt.finalTokens ?? evt.data?.finalTokens ?? 0) as number;
    if (status !== 'completed' || !(orig > 0) || !(fin > 0) || fin >= orig) return;
    pushStreamEvent(sessionId, 'context_compaction', {
      status,
      original_tokens: orig,
      final_tokens: fin,
      turn_id: turnId,
    });
    flog('fwd:OUT-stream', `context_compaction ${orig}→${fin} turn=${turnId}`);
    return;
  }
  if (type === 'checkpoint') {
    /* kind/payload 对齐 cloud-runtime runtimeBridge 的 'checkpoint' — phone 单套解析. */
    const checkpointId = (evt.checkpointId ?? evt.checkpoint_id ?? evt.id ?? '') as string;
    if (!checkpointId) return;
    pushStreamEvent(sessionId, 'checkpoint', {
      checkpoint_id: checkpointId,
      auto: evt.auto === true,
      turn_id: turnId,
    });
    return;
  }
  if (type === 'stream_retry') {
    pushStreamEvent(sessionId, 'stream_retry', {
      attempt: (evt.attempt ?? 1) as number,
      max_retries: (evt.maxRetries ?? 0) as number,
      delay_ms: (evt.delayMs ?? 0) as number,
      error: (evt.error ?? '') as string,
      error_code: (evt.errorCode ?? '') as string,
      is_rate_limit: evt.isRateLimit === true,
      is_stream_timeout: evt.isStreamTimeout === true,
      is_network_error: evt.isNetworkError === true,
      turn_id: turnId,
    });
    return;
  }
  if (type === 'stream_recovered') {
    pushStreamEvent(sessionId, 'stream_recovered', {
      attempt: (evt.attempt ?? 1) as number,
      max_retries: (evt.maxRetries ?? 0) as number,
      turn_id: turnId,
    });
    return;
  }
  /* P5 fix — side-agent 自动生成的 session title. server/main.ts persistSessionTitle
   * 已落 sessionStore + bus.publish, 这里转给 mobile, timeline 顶部"新会话" 即时变标题. */
  if (type === 'session_title_changed') {
    const title = (evt.title ?? evt.data?.title ?? '') as string;
    if (title) {
      pushStreamEvent(sessionId, 'session_title_changed', { title });
      flog('fwd:OUT-stream', `session_title_changed → "${title.slice(0, 30)}"`);
    }
    return;
  }
  /* side-agent 直接 emit 的 (没经过 sessionStore 持久化) — 这条来自 agentRuntimeHost
   * 的 emit callback, 兼容 server bus 还没 publish 时也能推. 重复推没问题 (mobile 端
   * idempotent 设置同名标题). */
  if (type === 'session_title_generated') {
    const title = (evt.title ?? evt.data?.title ?? '') as string;
    if (title) {
      pushStreamEvent(sessionId, 'session_title_changed', { title });
      flog('fwd:OUT-stream', `session_title_generated → "${title.slice(0, 30)}"`);
    }
    return;
  }
  /* M2 接力 — run_state_changed event. 把 status / pendingToolCalls 等推给 mobile,
   * mobile 上 timeline 顶部显示状态条 (暂停中 / 等待审批 / running).
   * ExecutionState mirror first — phone projector attach/subscribe must not depend
   * on a single best-effort WS frame. */
  if (type === 'run_state_changed') {
    const data = evt.data ?? evt;
    const payload = {
      status: data.status,
      turn_id: data.turnId,
      last_committed_seq: data.lastCommittedSeq,
      pending_tool_calls: data.pendingToolCalls,
      initiated_by: data.initiatedBy,
      paused_at: data.pausedAt,
      updated_at: data.updatedAt ?? Date.now(),
    };
    recordRunState(sessionId, payload as Record<string, unknown>);
    pushStreamEvent(sessionId, 'run_state_changed', payload);
    flog('fwd:OUT-stream', `run_state_changed → ${data.status} initBy=${data.initiatedBy ?? '?'}`);
    return;
  }

  if (type === 'user_message') {
    const text = (evt.text ?? evt.data?.text ?? '') as string;
    const seq = typeof evt.seq === 'number'
      ? evt.seq
      : typeof evt.data?.seq === 'number'
        ? evt.data.seq
        : undefined;
    flog('fwd:user_message', `PUSH seq=${seq ?? '?'} text="${text.slice(0, 40)}"`);
    /* seq 必须传到**外层** notif 上, 不能只放 payload 里: 手机端按外层 seq 判断
     * "这是要入库的实体消息还是不落盘的 streaming delta", seq=0 一律当 delta 丢掉。
     * 拿不到 seq 就不推 —— 推一条注定被丢的消息只会让日志好看, 用户屏幕上还是空的。 */
    if (typeof seq === 'number') {
      pushStreamEvent(
        sessionId,
        'user_message',
        {
          /* payload 形状必须跟 sessionEventBridge.shapePayload 一致 —— 手机端是同一套
           * 解析代码, 少个 role 就归不了类。 */
          role: 'user',
          content: text,
          turn_id: (evt.turnId ?? evt.data?.turnId) as string | undefined,
        },
        seq,
      );
    } else {
      flog('fwd:user_message', 'bus event 没有 seq, 跳过 (等 history 补拉)');
    }
    return;
  }

  const ctxMod = await import('@neoxlabs/platform/platform/sessionContext.js');
  const ctx = ctxMod.SessionContext.get(sessionId) as SessionContextClass;

  switch (type) {
    case 'token': {
      /* 关键拦截: runtime 对 tool args 流式时也 emit type:'token', 但带 toolName/toolId/source.
       *   把这些当 agent_text 累积 → text_complete 时 strip 大半 (366→22 这种), 还污染
       *   StreamingTurn 的 textBuffer → 显空 "AGENT" header. 见 log fwd:IN 里那批
       *   {"type":"token","toolName":"readfile",...}. 这条路应走 tool_call_delta 协议,
       *   不属于 agent 正文. */
      if (evt.toolName || evt.source === 'tool_call' || evt.toolId) {
        return;
      }
      /* Explore 子代理正文不进主 timeline */
      if (evt.taskAgentId) return;
      const content = (evt.content ?? evt.delta ?? '') as string;
      if (content) {
        /* 同时累积本地 buffer + 推 mobile 实时 delta (40ms 合帧). text_complete 时用
         *   累积值落 drift, 因为 text_complete 事件本身不带 text 字段, 只是个 sequence 标志. */
        lockSegmentOrder(pendingTextOrder, sessionId, turnId);
        accumAppend(sessionId, turnId, content);
        queueDeltaEvent(sessionId, 'agent_text_delta', turnId, 'content', {
          content, turn_id: turnId,
        });
      }
      return;
    }
    case 'text':
    case 'text_complete': {
      /* 优先从累积 buffer 拿全文 (token deltas 累出来), 兜底 evt.text / evt.content. */
      const accumulated = accumTake(sessionId, turnId);
      const explicitText =
        (typeof evt.text === 'string' && evt.text) ||
        (typeof evt.content === 'string' && evt.content) ||
        '';
      const rawText = accumulated.length > 0 ? accumulated : explicitText;
      /* 模型 (Claude/GPT) 在 text token stream 里有时会把 tool_use args JSON 也吐成 text,
       *   开头/中间都可能. tool_call_start 是另一条结构化路径, 这里 strip 全部独立 JSON. */
      const finalText = stripStandaloneJson(rawText);
      flog('fwd:OUT-drift',
        `case=${type} turn=${turnId} accumLen=${accumulated.length} ` +
        `evtTextLen=${explicitText.length} stripped=${rawText.length - finalText.length} ` +
        `→ finalLen=${finalText.length}` +
        (finalText.trim().length > 0 ? ' → appendMessage(assistant, text)' : ' → SKIP empty'));
      const textOrder = takeSegmentOrder(pendingTextOrder, sessionId, turnId);
      if (finalText.trim().length > 0) {
        await ctx.appendMessage('assistant', finalText, turnId, ts, {
          role: 'assistant', content: finalText, turnId, stream_order: textOrder,
        });
      }
      pushStreamEvent(sessionId, 'agent_text_done', { turn_id: turnId });
      return;
    }
    case 'reasoning': {
      if (evt.taskAgentId) return;
      const content = (evt.content ?? evt.delta ?? evt.text ?? '') as string;
      if (content) {
        lockSegmentOrder(pendingReasonOrder, sessionId, turnId);
        reasonAppend(sessionId, turnId, content);
        queueDeltaEvent(sessionId, 'agent_thinking_delta', turnId, 'content', {
          content, turn_id: turnId,
        });
      }
      return;
    }
    case 'reasoning_complete':
    case 'thinking': {
      if (evt.taskAgentId) return;
      const accumulated = reasonTake(sessionId, turnId);
      const explicitText =
        (typeof evt.text === 'string' && evt.text) ||
        (typeof evt.content === 'string' && evt.content) ||
        '';
      const finalText = accumulated.length > 0 ? accumulated : explicitText;
      flog('fwd:OUT-drift',
        `case=${type} turn=${turnId} accumLen=${accumulated.length} ` +
        `evtTextLen=${explicitText.length} → finalLen=${finalText.length}` +
        (finalText.trim().length > 0 ? ' → appendMessage(assistant, thinking)' : ' → SKIP empty'));
      const thinkOrder = takeSegmentOrder(pendingReasonOrder, sessionId, turnId);
      if (finalText.trim().length > 0) {
        await ctx.appendMessage('assistant', '', turnId, ts, {
          role: 'assistant', content: '', turnId, thinking: finalText,
          stream_order: thinkOrder,
        });
      }
      pushStreamEvent(sessionId, 'agent_thinking_done', { turn_id: turnId });
      return;
    }
    case 'tool_call':
    case 'tool_call_start': {
      /* runtimeEventForwarder 把 'tool_call_start' 重命名为 'tool_call' 再 emit, 这里两兼容. */
      const name = evt.toolName ?? evt.name ?? 'tool';
      const args = evt.args ?? evt.arguments ?? evt.input ?? {};
      const callId = (evt.toolCallId ?? evt.callId ?? evt.id ?? evt.toolId ?? `tc-${Date.now()}`) as string;
      const taskAgentId = (evt.taskAgentId ?? '') as string;
      if (taskAgentId) {
        pushStreamEvent(sessionId, 'subagent_progress', {
          agent_id: taskAgentId,
          tool_name: name,
          status: 'running',
          turn_id: turnId,
        });
        return;
      }
      markToolRunning(sessionId, callId, name, args);
      toolStartedAt.set(callKey(sessionId, callId), ts);
      pushStreamEvent(sessionId, 'tool_running', {
        tool_name: name,
        args,
        tool_call_id: callId,
        turn_id: turnId,
      });
      flog('fwd:OUT-drift', `case=${type} call=${callId.slice(0,8)} name=${name} → appendMessage(tool_call)`);
      await ctx.appendMessage('assistant', `[tool: ${name}]`, turnId, ts, {
        role: 'assistant',
        content: '',
        turnId,
        stream_order: nextStreamOrder(sessionId, turnId),
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
        }],
      });
      emittedToolCall.add(callKey(sessionId, callId));
      return;
    }
    case 'tool_call_delta': {
      /* runtime 的 OpenAI-style chunked tool call: 名+参数分多片到达, 用 callId 聚合.
       *   某些 runtime (本仓用的就是) 只 emit delta + end, 不 emit start. */
      if (evt.taskAgentId) {
        const deltaName = (evt.toolName ?? evt.name ?? evt.delta?.name ?? '') as string;
        if (deltaName) {
          pushStreamEvent(sessionId, 'subagent_progress', {
            agent_id: evt.taskAgentId,
            tool_name: deltaName,
            status: 'running',
            turn_id: turnId,
          });
        }
        return;
      }
      const callId = (evt.toolCallId ?? evt.callId ?? evt.id ?? '') as string;
      if (!callId) return;
      const k = toolKey(sessionId, callId);
      const entry = toolAccum.get(k) ?? { name: '', argsStr: '', callId };
      const deltaName = (evt.toolName ?? evt.name ?? evt.delta?.name ?? '') as string;
      if (deltaName) entry.name = deltaName;
      const argChunk = (evt.argsDelta ?? evt.argumentsDelta ?? evt.delta?.arguments ?? evt.delta?.input ?? '') as string;
      if (typeof argChunk === 'string' && argChunk) entry.argsStr += argChunk;
      toolAccum.set(k, entry);
      flog('fwd:tool_delta', `call=${callId.slice(0,8)} name=${entry.name} argsLen=${entry.argsStr.length}`);
      /* 第一次拿到 name 就 push 一个 running 给 mobile, 让 UI 立刻显行 */
      if (deltaName) {
        markToolRunning(sessionId, callId, entry.name, {});
        pushStreamEvent(sessionId, 'tool_running', {
          tool_name: entry.name,
          args: {},
          tool_call_id: callId,
          turn_id: turnId,
        });
      }
      return;
    }
    case 'tool_call_end': {
      /* tool 调用 args 凑齐, 写 drift entry — 让 mobile 后续 ToolBlock 渲染. */
      if (evt.taskAgentId) {
        const name = (evt.toolName ?? evt.name ?? 'tool') as string;
        pushStreamEvent(sessionId, 'subagent_progress', {
          agent_id: evt.taskAgentId,
          tool_name: name,
          status: 'running',
          turn_id: turnId,
        });
        return;
      }
      const callId = (evt.toolCallId ?? evt.callId ?? evt.id ?? '') as string;
      const evtName = (evt.toolName ?? evt.name ?? '') as string;
      const evtArgs = evt.args ?? evt.arguments ?? evt.input ?? null;
      const accum = callId ? toolAccum.get(toolKey(sessionId, callId)) : undefined;
      const name = evtName || accum?.name || 'tool';
      let argsObj: any = {};
      if (evtArgs != null && typeof evtArgs === 'object') {
        argsObj = evtArgs;
      } else if (accum && accum.argsStr) {
        try { argsObj = JSON.parse(accum.argsStr); } catch { argsObj = accum.argsStr; }
      } else if (typeof evtArgs === 'string') {
        try { argsObj = JSON.parse(evtArgs); } catch { argsObj = evtArgs; }
      }
      const argsStr = typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj);
      flog('fwd:tool_end', `call=${callId.slice(0,8)} name=${name} argsLen=${argsStr.length}`);
      if (callId) toolAccum.delete(toolKey(sessionId, callId));
      markToolRunning(sessionId, callId, name, argsObj);
      pushStreamEvent(sessionId, 'tool_running', {
        tool_name: name,
        args: argsObj,
        tool_call_id: callId,
        turn_id: turnId,
      });
      /* tool_call_start 已写过就不重复 — coalesce 配对会拿那条; 重复写第二条变孤儿. */
      if (!emittedToolCall.has(callKey(sessionId, callId))) {
        await ctx.appendMessage('assistant', `[tool: ${name}]`, turnId, ts, {
          role: 'assistant',
          content: '',
          turnId,
          stream_order: nextStreamOrder(sessionId, turnId),
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name, arguments: argsStr },
          }],
        });
        emittedToolCall.add(callKey(sessionId, callId));
      }
      return;
    }
    case 'tool_result':
    case 'tool_output': {
      /* runtimeEventForwarder 重命名 tool_call_end → tool_result, 这里两兼容.
       *   tool_result 事件本身就带完整: name + args + output + success + summary. */
      const name = (evt.toolName ?? evt.name ?? 'tool') as string;
      const callId = (evt.toolCallId ?? evt.callId ?? evt.id ?? evt.toolId ?? `tc-${Date.now()}`) as string;
      if (evt.taskAgentId) {
        pushStreamEvent(sessionId, 'subagent_progress', {
          agent_id: evt.taskAgentId,
          tool_name: name,
          status: evt.success === false ? 'error' : 'done',
          turn_id: turnId,
        });
        return;
      }
      const output = (evt.output ?? evt.content ?? evt.result ?? evt.summary ?? '').toString();
      const ok = evt.success !== false;
      const args = evt.args ?? {};
      flog('fwd:OUT-drift', `case=${type} call=${callId.slice(0,8)} name=${name} outLen=${output.length} ok=${ok}`);
      if (!emittedToolCall.has(callKey(sessionId, callId))) {
        pushStreamEvent(sessionId, 'tool_running', {
          tool_name: name,
          args,
          tool_call_id: callId,
          turn_id: turnId,
        });
      }
      /* ask_user 有结果 = 问题已经答了 (在手机 / 电脑 / 超时都算)。手机那张卡只在 ask_user_expired
       *   时撤, 而电脑上作答从来不发这个 —— 于是手机上的卡片一直挂着, 重连后还会按快照画回来。
       *   这里统一撤: 删快照 + 通知手机。 */
      if (name === 'ask_user') {
        for (const ask of getPendingActions(sessionId).ask_user) {
          removeAskUser(sessionId, ask.request_id);
          pushStreamEvent(sessionId, 'ask_user_expired', {
            request_id: ask.request_id,
            reason: 'answered',
            turn_id: turnId,
          });
        }
      }
      /* tool_call entry (含 args) — 只在 tool_call_start/_end 还没写过时兜底.
       *   多数 runtime 会先 emit tool_call_start, 这里 set 已记, skip. */
      if (!emittedToolCall.has(callKey(sessionId, callId))) {
        await ctx.appendMessage('assistant', `[tool: ${name}]`, turnId, ts, {
          role: 'assistant',
          content: '',
          turnId,
          stream_order: nextStreamOrder(sessionId, turnId),
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
          }],
        });
        emittedToolCall.add(callKey(sessionId, callId));
      }
      /* tool_result entry (含 output + args) — mobile 端 ToolBlock 配对时:
       *   tool_call 漂入那一刻 args 可能还空 (runtime tool_call_start 早于 args 流完),
       *   mobile 显不出文件名 / 命令等关键信息. 这里把完整 args 也带上去,
       *   ToolBlock 在 callArgs 为空时从 resultArgs fallback。 */
      const artifacts = await collectToolArtifacts(sessionId, output);
      await ctx.appendMessage('tool', output, turnId, ts, {
        role: 'tool',
        content: output,
        turnId,
        stream_order: nextStreamOrder(sessionId, turnId),
        tool_call_id: callId,
        name,
        args,
        ...(artifacts ? { artifacts } : {}),
      });
      /* 通知 mobile streaming buffer 关掉 tool_running 状态 */
      markToolDone(sessionId, callId);
      const startedAt = toolStartedAt.get(callKey(sessionId, callId));
      const durationMs = typeof startedAt === 'number' && ts > startedAt
        ? ts - startedAt
        : undefined;
      toolStartedAt.delete(callKey(sessionId, callId));
      pushStreamEvent(sessionId, 'tool_done', {
        tool_call_id: callId,
        ok,
        /* 缺起跑时刻 (重连后半途接上) 就不带 —— 手机据此不显示, 不编数 */
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      });
      /* tool 收尾, set 清理掉这条; 同 callId 不会再来, 留着浪费内存. */
      emittedToolCall.delete(callKey(sessionId, callId));
      return;
    }
    case 'turn_complete': {
      clearActiveSubagents(sessionId);
      recordIdleFromTurnDone(sessionId, turnId);
      pushStreamEvent(sessionId, 'agent_turn_done', { turn_id: turnId });
      clearSessionStreamState(sessionId);
      return;
    }
    case 'approval_needed': {
      /* 审批拦截 — agent 想跑 write/exec 类工具, server 在 PermissionManager 卡住等 UI 回应.
       *   桥层之前只 forward 给 electron renderer, mobile 完全失声 → 在手机端审批工具死锁.
       *   把 requestId + toolName + args + reason 推给 phone, phone 渲 ApprovalCard,
       *   按钮点 → session.input { kind: 'control:approve'|'control:reject', payload: { request_id } }. */
      const requestId = (evt.requestId ?? evt.request_id ?? '') as string;
      if (!requestId) return;
      const payload = {
        request_id: requestId,
        tool_name: evt.toolName ?? evt.tool_name ?? 'tool',
        args: evt.args ?? {},
        reason: evt.reason ?? '',
        allow_remember: evt.allowRemember === true || evt.allow_remember === true,
        scope_key: evt.scopeKey ?? evt.scope_key ?? null,
        risk: evt.risk ?? null,
        /* 来源闸 (kernel/core/trust): 手机端把 message 显示在卡上就够 */
        provenance: evt.provenance ?? null,
        turn_id: turnId,
      };
      recordApprovalNeeded(sessionId, payload);
      pushStreamEvent(sessionId, 'approval_needed', payload);
      return;
    }
    case 'approval_cancelled': {
      const requestId = (evt.requestId ?? evt.request_id ?? '') as string;
      if (!requestId) return;
      removeApproval(sessionId, requestId);
      pushStreamEvent(sessionId, 'approval_cancelled', {
        request_id: requestId,
        reason: evt.reason ?? 'resolved',
        approved: evt.approved === true,
      });
      return;
    }
    case 'ask_user_needed': {
      /* agent 中途主动追问用户 (开放式问题). Phone 端渲 question card, 用户答 →
       *   session.input { kind: 'control:ask_user_reply', payload: { request_id, answers } }. */
      const requestId = (evt.requestId ?? evt.request_id ?? '') as string;
      if (!requestId) return;
      const payload = {
        request_id: requestId,
        questions: evt.questions ?? [],
        turn_id: turnId,
      };
      recordAskUserNeeded(sessionId, payload);
      pushStreamEvent(sessionId, 'ask_user_needed', payload);
      return;
    }
    case 'ask_user_expired': {
      const requestId = (evt.requestId ?? evt.request_id ?? '') as string;
      if (!requestId) return;
      removeAskUser(sessionId, requestId);
      pushStreamEvent(sessionId, 'ask_user_expired', {
        request_id: requestId,
        timeout_sec: (evt as any).timeoutSec ?? (evt as any).timeout_sec ?? 0,
        reason: (evt as any).reason ?? 'timeout',
        turn_id: turnId,
      });
      return;
    }
    case 'session_interrupted': {
      /* server 重启 / 用户在 desktop 端 stop / 异常 abort — 通知 phone 把当前 streaming 全清,
       *   显个 banner "会话被中断". 不入 drift (这是临时状态, 不是消息). */
      clearPendingActions(sessionId);
      clearActiveSubagents(sessionId);
      pushStreamEvent(sessionId, 'session_interrupted', {
        reason: evt.reason ?? 'unknown',
        turn_id: turnId,
      });
      /* 中断 = 本轮不会再有 text_complete, 清 accum/工具登记防泄漏+防陈旧快照 */
      clearSessionStreamState(sessionId);
      return;
    }
    case 'file_stream':
    case 'edit_file_stream':
    case 'edit_file_stream_preview':
    case 'write_file_stream':
    case 'shell_output_stream': {
      const callId = (evt.toolCallId ?? evt.callId ?? evt.id ?? evt.toolId ?? '') as string;
      if (!callId) return;
      const chunk = (evt.chunk ?? evt.content ?? evt.delta ?? evt.text ?? evt.output ?? '').toString();
      if (!chunk) return;
      queueDeltaEvent(sessionId, 'tool_progress', `${callId}|${type}`, 'chunk', {
        tool_call_id: callId,
        chunk,
        stream_kind: type,                          // 让 phone 区分 shell vs file
        turn_id: turnId,
      });
      return;
    }
    case 'error':
    case 'error_classified': {
      const msg = (evt.message ?? evt.error ?? evt.text ?? '').toString();
      /* ── 诊断 dump: 把 gateway/agent 返的整个 error envelope 打到 console.
       *   定位 "为啥模型存在但报 unavailable" 这类链路 bug. */
      try {
        const dump = {
          type: evt.type,
          code: evt.code,
          errorCode: evt.errorCode,
          category: evt.category,
          httpStatus: evt.httpStatus,
          requestId: evt.requestId,
          provider: evt.provider,
          modelName: evt.modelName,
          providerId: evt.providerId,
          retryable: evt.retryable,
          message: msg,
          original: evt.original ?? evt.originalError,
        };
        flog('fwd:ERR-envelope', JSON.stringify(dump));
      } catch { /* swallow */ }
      if (msg) {
        const retryable = evt.retryable === true
          || /HTTP_?5\d\d|upstream|do request failed|执行器/i.test(msg);
        const suggestion = retryable
          ? '\n\n💡 Suggestion: 可点「重试」；持续失败请切换 provider'
          : (typeof evt.suggestion === 'string' && evt.suggestion
            ? `\n\n💡 Suggestion: ${evt.suggestion}`
            : '');
        const body = `❌ ${msg}${suggestion}`;
        await ctx.appendMessage('assistant', body, turnId, ts, {
          role: 'assistant', content: body, turnId,
          stream_order: nextStreamOrder(sessionId, turnId),
          retryable,
          error_code: evt.code ?? evt.errorCode,
        });
      }
      return;
    }
    default:
      flog('fwd:UNKNOWN-type', `type=${type} session=${sessionId.slice(0,16)} keys=` +
        Object.keys(evt).filter(k => !['sessionId', 'type', 'turnId', 'messageId', 'timestamp'].includes(k)).join(','));
      return;
  }
}
