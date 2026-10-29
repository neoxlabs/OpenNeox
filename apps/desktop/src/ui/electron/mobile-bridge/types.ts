/**
 * mobile-bridge/types.ts — Mobile <-> Desktop 通信共享类型
 *
 * 严格对齐协议规范 内部设计文档 v1.0.
 * 任何 schema 改动须先改 protocol doc.
 *
 * ── Phone as desktop timeline Projector (data plane) ─────────────────
 * Two first-class channels (not a grab-bag of RPCs):
 *
 *   A. EntryLog  — durable, ordered: session.event with seq>0 + session.history
 *                  (user / agent_text / thinking / tool_* / …). Cursor = latest_seq.
 *   B. ExecutionState — authoritative busy/idle: run_state_changed (live) +
 *                  session.subscribe.run_state snapshot (attach). Backed by
 *                  sessionStore + runStateMirror; agent_turn_done is backup only.
 *
 * session.subscribe = attach(sessionId) → { run_state, latest_seq, pending_actions, ui_state }
 * Then phone: catchUp(history gap) + applyExecution + stay on live fan-out.
 */

/** JSON-RPC 2.0 通用封套 (跟 protocol §3.3) */
export interface RpcMessage {
  jsonrpc: '2.0';
  id?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/** 协议版本 — bump major 不兼容 */
export const PROTOCOL_VERSION = 1;

/** mDNS 服务名 */
export const MDNS_SERVICE_TYPE = 'neox';
export const MDNS_PROTOCOL = 'tcp';

/** 配对 QR 内容 (base64url-encoded JSON) */
export interface PairingQRPayload {
  v: number;                  // PROTOCOL_VERSION
  host: string;               // Desktop 首选 LAN IP (兼容老 client 只看 host)
  hosts?: string[];           // 全部候选 LAN IP, Phone 端逐个 try 直到连通 (新加, v1.1)
  port: number;               // Desktop WS port
  device_id: string;          // Desktop device_id
  device_name: string;        // 显示名 (e.g., "Liu's MacBook")
  pubkey: string;             // base64url X25519 public key (32 bytes)
  pubkey_fingerprint: string; // 短 hash, 用户肉眼对比
  pairing_token: string;      // 一次性 token, base64url, 5min 过期
  expires_at: number;         // unix ms
}

/** Phone 通过 /api/v1/pair 提交的配对请求 */
export interface PairingRequest {
  pairing_token: string;
  phone_pubkey: string;       // base64url X25519 public key
  phone_device_id: string;
  phone_device_name: string;
}

/** Desktop 配对成功响应 */
export interface PairingResponse {
  device_token: string;                  // 长期 token, Phone 后续连 WSS 用
  desktop_pubkey: string;                // base64url (Phone 已经有了, 再确认)
  relay_session_key_fingerprint: string; // Phone 自检派生的 key 是否一致
  /** 自托管中继 (桌面配了才有): 手机出门后经它远程连回这台电脑 */
  relay?: { url: string; token: string };
}

/** Phone 通过备份码配对 (无相机) */
export interface PairingByCodeRequest {
  backup_code: string;        // 6 位 (e.g., ABCD-1234)
  phone_pubkey: string;
  phone_device_id: string;
  phone_device_name: string;
}

/** WS 连接握手 headers */
export interface WsConnHeaders {
  'x-neox-device-id': string;
  'x-neox-device-token': string;
  'x-neox-protocol-version': string;
  'x-neox-signature': string;     // HMAC-SHA256(token, timestamp + nonce)
  'x-neox-timestamp': string;     // unix ms
  'x-neox-nonce': string;
}

/** Mobile 设备记录 (DB 存的) */
export interface PairedMobile {
  id: number;
  device_id: string;
  device_name: string | null;
  phone_pubkey_b64: string;       // base64
  relay_session_key_b64: string;  // base64 (本地存, 永不上云)
  device_token: string;
  paired_at: number;
  last_seen_at: number | null;
  /** 配对发起时 desktop 当前登录的 user.id — 切户后另一户看不到这条配对 (P0 隔离).
   *   未设 (老数据) / null = 通用 (跨用户可见, 向后兼容). */
  owner_user_id?: string | null;
}

/** 配对 token 内存表条目 (5min 过期) */
export interface PendingPairing {
  pairing_token: string;
  backup_code_hash: string;       // sha256(backup_code), 比较时用
  expires_at: number;
}

/** 协议规范 §3.3.1 — Desktop → Phone notification kinds */
export type DesktopToPhoneKind =
  | 'user_message'
  | 'agent_text'
  | 'agent_thinking'
  | 'tool_call'
  | 'tool_result'
  | 'progress'
  | 'session_meta'
  | 'session_done'
  | 'session_error'
  | 'agent_text_delta'
  | 'agent_text_done'
  | 'agent_thinking_delta'
  | 'agent_thinking_done'
  | 'tool_running'
  | 'tool_done'
  | 'tool_progress'
  | 'agent_turn_done'
  | 'session_interrupted'
  | 'run_state_changed'
  | 'context_usage'
  | 'approval_needed'
  | 'approval_cancelled'
  | 'ask_user_needed'
  | 'ask_user_expired'
  | 'session_title_changed'
  | 'plan_update'          // { explanation?, plan: [{step, status}], turn_id }
  | 'subagent_started'     // { agent_id, task, model?, model_inherited, role_name?, is_background, is_agent_tool, turn_id } (Mode A/B only)
                           //   is_agent_tool=true → agent_id 是真子会话 id, 可 session.history 看独立时间轴;
  | 'subagent_done'        // { agent_id, success, summary?, duration_ms?, turn_id } (Mode A/B only)
  | 'subagent_progress'    // { agent_id, tool_name?, status?, turn_id } — nested explore tools, not main timeline
  | 'context_compaction'   // A/B: { original_tokens, final_tokens }; C: { before_tokens, after_tokens } — phone 双兼容
  | 'checkpoint'           // { checkpoint_id | id, auto, turn_id }
  | 'stream_retry'         // { attempt, max_retries, delay_ms, error, is_rate_limit, is_stream_timeout, is_network_error }
  | 'stream_recovered';    // { attempt, max_retries }

/** 协议规范 §3.3.2 — Phone → Desktop input kinds */
export type PhoneToDesktopKind =
  | 'user_message'
  | 'control:pause'
  | 'control:resume'
  | 'control:takeover'
  | 'control:cancel'
  | 'control:retry'
  | 'control:switch_model'
  | 'control:approve'
  | 'control:reject'
  | 'control:ask_user_reply';

/** Session event payload 通用结构 (跟 SessionContext schema 对齐, payload 字段按 kind 各异) */
export interface SessionEventPayload {
  session_id: string;
  seq: number;
  ts: number;
  kind: DesktopToPhoneKind;
  payload: any;
}

/** WS 连接生命周期状态 */
export type WsConnectionState =
  | 'open'
  | 'authenticating'
  | 'authenticated'
  | 'closing'
  | 'closed';
