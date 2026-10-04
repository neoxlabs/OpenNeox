/**
 * envelopeSchema — relay envelope + JSON-RPC 消息类型 + 序列化.
 *
 *   Envelope (顶层 JSON, 不加密):
 *     {
 *       to_device_id:    string,   // 接收方 device id (relay 据此转发)
 *       from_device_id:  string,   // 发送方
 *       nonce:           string,   // base64(12B random IV)
 *       ciphertext:      string,   // base64(encrypted_data || 16B tag)
 *       ts:              number,   // 毫秒时间戳
 *       bytes:           number,   // ciphertext buffer 长度
 *     }
 *
 *   RpcMessage (envelope 内部, 解密后):
 *     JSON-RPC 2.0 — { jsonrpc:'2.0', id?, method?, params?, result?, error? }
 *
 *   详见 内部设计文档 §3.2
 */

export interface Envelope {
  to_device_id: string;
  from_device_id: string;
  /** base64(12B nonce) */
  nonce: string;
  /** base64(encrypted_data || 16B tag) */
  ciphertext: string;
  /** 毫秒时间戳 */
  ts: number;
  /** ciphertext buffer 长度 (bytes) */
  bytes: number;
}

/** Relay control frame — 不加密, 顶层 `type` 字段. relay 服务器主动推. */
export interface RelayControlFrame {
  type: string;
  message?: string;
  device_id?: string;
}

export interface RpcMessage {
  jsonrpc: '2.0';
  /** request 必填; notification 无; response 跟原 request id 同 */
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** WebSocket 收到的 raw 数据可能是 string / Buffer / Buffer[] / ArrayBuffer.
 *  parseEnvelope 接受这些再 normalize 成 text. */
export type RawWsData = string | Buffer | Buffer[] | ArrayBuffer | Uint8Array;

/** 解析 envelope JSON, 返 typed; 不合法返 null. */
export function parseEnvelope(raw: RawWsData): Envelope | RelayControlFrame | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
  else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf8');
  else return null;
  let outer: any;
  try { outer = JSON.parse(text); } catch { return null; }
  if (!outer || typeof outer !== 'object') return null;
  /* relay control frame (relay_error / device_offline 等) — 顶层 type 字段 */
  if (typeof outer.type === 'string') {
    return outer as RelayControlFrame;
  }
  /* 真 envelope */
  if (typeof outer.from_device_id !== 'string'
      || typeof outer.to_device_id !== 'string'
      || typeof outer.nonce !== 'string'
      || typeof outer.ciphertext !== 'string') {
    return null;
  }
  return outer as Envelope;
}

export function makeEnvelope(input: {
  toDeviceId: string;
  fromDeviceId: string;
  nonce: Buffer;
  ciphertext: Buffer;
}): Envelope {
  return {
    to_device_id: input.toDeviceId,
    from_device_id: input.fromDeviceId,
    nonce: input.nonce.toString('base64'),
    ciphertext: input.ciphertext.toString('base64'),
    ts: Date.now(),
    bytes: input.ciphertext.length,
  };
}

export function serializeRpcMessage(msg: RpcMessage): string {
  return JSON.stringify(msg);
}

export function parseRpcMessage(raw: string): RpcMessage | null {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.jsonrpc !== '2.0') return null;
  return obj as RpcMessage;
}

/** Relay control frame 是否表示对端离线 (host 应该翻 failed). */
export function isPeerOfflineFrame(frame: RelayControlFrame): boolean {
  return frame.type === 'device_offline' || frame.type === 'relay_error';
}
