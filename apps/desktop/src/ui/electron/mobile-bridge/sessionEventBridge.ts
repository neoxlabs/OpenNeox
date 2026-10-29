/**
 * sessionEventBridge.ts — SessionContext appendMessage → Mobile Bridge WS 推送
 *
 * 桥接关系:
 *   neox-core SessionContext (LLM 跟工具调用都写它)
 *      ↓ onAppend 事件
 *   sessionEventBridge (本文件)
 *      ↓ 映射 role → protocol kind
 *   MobileBridgeServer.pushToSessionSubscribers
 *      ↓ JSON-RPC notification
 *   Phone (订阅了 session.subscribe 的 Mobile 设备)
 *
 * Phase 1.D — 让 Mobile 真能看到 timeline 内容 (不再 stub 空 sessions).
 */

import { SessionContext, type SessionAppendEvent } from '@neoxlabs/platform/platform/sessionContext.js';
import { getMobileBridgeServer } from './index.js';
import { makeNotification } from './jsonRpc.js';
import { bridgeLog } from './log.js';
import { normalizeMobileTurnId } from './agentStreamForwarder.js';
import {
  scheduleSessionIndexUpload,
  disposeSessionIndexUploader,
} from './sessionIndexUploader.js';
import type { DesktopToPhoneKind } from './types.js';
import { slimPayloadForMobile } from './mobilePayloadSlim.js';
import { withSessionImageBase } from './mobileImageStash.js';

/** 单条 history 消息的协议 shape — session.history response 跟 session.event notification
 *  必须 1:1 一致, 否则 Phone 端按 kind 解析会全部 skip. */
export interface HistoryMessage {
  seq: number;
  ts: number;
  kind: DesktopToPhoneKind;
  payload: any;
}

/** 把 SessionContext 内存里某条消息映射成协议 shape (history 接口用).
 *  跟 handleAppend 走完全一样的 kind + payload 推导. */
export function mapSessionMessageToProtocol(m: {
  seq: number;
  timestamp: number;
  role: SessionAppendEvent['role'];
  content: string;
  turnId?: string;
  raw?: any;
}): HistoryMessage {
  const fakeEvent: SessionAppendEvent = {
    sessionId: '',
    seq: m.seq,
    timestamp: m.timestamp,
    role: m.role,
    content: m.content,
    turnId: m.turnId ?? '',
    raw: m.raw,
  };
  return {
    seq: m.seq,
    ts: m.timestamp,
    kind: mapRoleToProtocolKind(m.role, m.raw),
    payload: slimPayloadForMobile(shapePayload(fakeEvent)),
  };
}


let unsubscribe: (() => void) | null = null;

/**
 * 启动 bridge — 在 startMobileBridge() 之后调.
 * 订阅 SessionContext 全局 append 事件, 推到所有订阅了该 session 的 Mobile 连接.
 */
export function startSessionEventBridge(): void {
  if (unsubscribe) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] sessionEventBridge already started');
    return;
  }
  unsubscribe = SessionContext.onAppend(handleAppend);
  // eslint-disable-next-line no-console
  console.log('[mobile-bridge] sessionEventBridge subscribed to SessionContext');
  /* 启动就传一次: 电脑关了一夜、手机这边什么都没发生, 但列表得是最新的。
   * 只靠 append 事件的话, 一台没人用的电脑永远不会更新自己的云端索引。 */
  scheduleSessionIndexUpload('bridge start');
}

export function stopSessionEventBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  disposeSessionIndexUploader();
}

/** SessionContext 触发的回调 — cheap + 异常安全. */
function handleAppend(event: SessionAppendEvent): void {
  /* role=system 是 system prompt / 内部 meta, mobile 不需要看, 直接 skip
   *  (否则整个长 prompt 会全文铺到手机屏上). */
  if (event.role === 'system') return;

  if (event.role === 'user') return;

  /* 会话动了 → 排一次云端索引上传 (8s 合并窗口, 内部只传真变了的条目)。
   * 这条跟下面推送给"已订阅的手机"是两回事: 那个要求手机此刻连着, 这个是给
   * **没连着**的手机准备的 —— 让它登录后立刻看得到列表。 */
  try {
    scheduleSessionIndexUpload('session append');
  } catch { /* 上传是尽力而为, 绝不能影响本地会话流 */ }
  const server = getMobileBridgeServer();
  if (!server) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge:bridge] handleAppend: no server, drop');
    return;
  }
  /* 无订阅的 session 就不组装 notification (省 CPU) */
  const conns = server.listConns();
  let hasSubscriber = false;
  for (const conn of conns) {
    if (conn.subscribedSessionIds.has(event.sessionId)) { hasSubscriber = true; break; }
  }
  if (!hasSubscriber) {
    bridgeLog(
      'bridge:no-sub',
      `session=${event.sessionId.slice(0, 16)} role=${event.role} seq=${event.seq} ` +
        `(${conns.length} conns, subs: ` +
        conns.map((c) => `[${[...c.subscribedSessionIds].map((s) => s.slice(0, 8)).join(',')}]`).join(' ') +
        ')',
    );
    return;
  }
  const kind = mapRoleToProtocolKind(event.role, event.raw);
  const payload = withSessionImageBase(event.sessionId, () => slimPayloadForMobile(shapePayload(event)));
  /* 全量打 — kind + turn_id + content 摘要 + tool_calls 数, 不打 content 全文防 spam */
  try {
    const contentStr = typeof payload?.content === 'string'
      ? payload.content
      : (Array.isArray(payload?.content) ? '[array len=' + payload.content.length + ']' : '?');
    const summary = {
      seq: event.seq,
      role: event.role,
      kind,
      turn_id: payload?.turn_id,
      contentLen: typeof contentStr === 'string' ? contentStr.length : undefined,
      contentHead: typeof contentStr === 'string' ? contentStr.slice(0, 60) : undefined,
      tool_calls: Array.isArray(payload?.tool_calls) ? payload.tool_calls.length : undefined,
      tool_call_id: payload?.tool_call_id,
      thinkingLen: typeof payload?.thinking === 'string' ? payload.thinking.length : undefined,
    };
    bridgeLog('bridge:OUT-drift→mobile', JSON.stringify(summary));
  } catch { /* ignore */ }
  const notif = makeNotification('session.event', {
    session_id: event.sessionId,
    seq: event.seq,
    ts: event.timestamp,
    kind,
    payload,
  });
  server.pushToSessionSubscribers(event.sessionId, notif);
}

/**
 * SessionContext role → Mobile 协议 kind 映射.
 *   user → user_message
 *   assistant + 含 tool_calls → tool_call (优先, 让 Mobile 知道是工具调用)
 *   assistant 纯文本 → agent_text
 *   tool → tool_result
 *   system → session_meta
 */
function mapRoleToProtocolKind(role: SessionAppendEvent['role'], raw?: any): DesktopToPhoneKind {
  switch (role) {
    case 'user':
      return 'user_message';
    case 'assistant': {
      if (raw && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
        return 'tool_call';
      }
      /* thinking content 可以从 raw.thinking 或 raw.content[type=thinking] 判 */
      if (raw && typeof raw === 'object') {
        const c = raw.content;
        if (Array.isArray(c) && c.some((x: any) => x?.type === 'thinking')) {
          return 'agent_thinking';
        }
        if (raw.thinking || raw.reasoning) return 'agent_thinking';
      }
      return 'agent_text';
    }
    case 'tool':
      return 'tool_result';
    case 'system':
      return 'session_meta';
    default:
      return 'agent_text';
  }
}

/** payload shape — 把原始 message 整体打包给 Mobile (Mobile 端按 kind 渲染卡片). */
function shapePayload(event: SessionAppendEvent): any {
  /* turn_id 归轮兜底: 运行时给 assistant drift 塞的 turnId 常是空串 (跟旧 'default'
   * 一样跨轮恒定), 手机按 turn_id 归轮就会把上一轮答案覆盖/串味。用本 session 当前轮
   * id 兜底; history 走 fake event (sessionId='') 已由 getSessionHistory 归一化, 这里
   * 拿不到 currentTurnId 会原样返回, 不重复处理。 */
  const turnId = normalizeMobileTurnId(event.sessionId, event.turnId);
  /* 优先 raw (含 tool_calls / 多模态等完整结构), 缺失 fallback {role, content}. */
  if (event.raw && typeof event.raw === 'object') {
    return {
      role: event.role,
      content: event.raw.content ?? event.content,
      turn_id: turnId,
      /* tool_call 专属字段 */
      ...(event.raw.tool_calls && { tool_calls: event.raw.tool_calls }),
      ...(event.raw.tool_call_id && { tool_call_id: event.raw.tool_call_id }),
      ...(event.raw.name && { tool_name: event.raw.name }),
      /* tool_result 时 forwarder 把完整 args 带上来 — 给 mobile 端 fallback 用 */
      ...(event.raw.args && { args: event.raw.args }),
      /* thinking */
      ...(event.raw.thinking && { thinking: event.raw.thinking }),
      /* v1.3 — 真实流序戳 (forwarder 写入), phone hydrate 按它排序回放 */
      ...(typeof event.raw.stream_order === 'number' && { stream_order: event.raw.stream_order }),
    };
  }
  return {
    role: event.role,
    content: event.content,
    turn_id: turnId,
  };
}
