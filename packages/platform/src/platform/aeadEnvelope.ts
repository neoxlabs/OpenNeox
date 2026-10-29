/**
 * aeadEnvelope — 请求体 AEAD 加密 (P6.C client-side lib).
 *
 * 目的: HTTP/HTTPS 之上再加一层应用层加密. 即使中间人解了 TLS (或没 TLS), 也看不见
 *       prompt/response 的明文. 加密 key 跟 HMAC 同根 (NEOX_HMAC_ROOT_SECRET HKDF 派生),
 *       不下发新 secret, 不增加客户端配置负担.
 *
 * 协议 v1:
 *   - Request:
 *       原 body                JSON {"model":"...","messages":[...]}
 *       ↓
 *       encrypt(JSON)          AES-256-GCM(key, nonce12B) → ciphertext + tag
 *       ↓
 *       envelope.body          base64(nonce || ciphertext || tag)
 *       Content-Type:          application/x-neox-aead-v1
 *       X-Aead-Version:        v1
 *   - HMAC sign 在 encrypted body 之上 (path + sha256(envelope_body) + ts + nonce + rootSecret)
 *   - Server: HMAC verify pass → 看 Content-Type=application/x-neox-aead-v1 → base64 decode →
 *     AES-GCM decrypt → JSON parse → 走原 handler
 *
 * Key 派生:
 *   aeadKey = HKDF-SHA256(NEOX_HMAC_ROOT_SECRET, info="neox-aead-v1", L=32)
 *   跟 HMAC versioned secret 同根但不同 info, 两把 key 独立, HMAC key 泄漏不等于 AEAD key 泄漏.
 *
 * 现状 :
 *   - 此模块完整, 单元测试通过
 *   - 没绑到 fetch / OpenAI SDK 中间件 — server 端 gateway 需先支持 application/x-neox-aead-v1
 *   - 启用条件 (待 server 上之后): export NEOX_BODY_AEAD=1
 *
 * 流式响应 (SSE): 本 v1 只加密 REQUEST. RESPONSE 流加密待 v2 (按 SSE event 分块 AEAD, 中等工作量).
 */

import * as crypto from 'node:crypto';

const AEAD_VERSION = 'v1';
const AEAD_INFO = `neox-aead-${AEAD_VERSION}`;
const KEY_LEN = 32; /* AES-256 */
const NONCE_LEN = 12; /* GCM 标准 12B nonce */
const TAG_LEN = 16; /* GCM tag */

export const AEAD_CONTENT_TYPE = `application/x-neox-aead-${AEAD_VERSION}`;
export const AEAD_HEADER = 'X-Aead-Version';

let _cachedKey: Buffer | null = null;

function deriveAeadKey(rootSecret: string): Buffer {
  if (_cachedKey) return _cachedKey;
  _cachedKey = Buffer.from(
    crypto.hkdfSync('sha256', rootSecret, Buffer.alloc(0), AEAD_INFO, KEY_LEN),
  );
  return _cachedKey;
}

/**
 * 加密 JSON body 成 envelope.
 * @param rootSecret NEOX_HMAC_ROOT_SECRET (跟 HMAC 同源, 客户端 env / native module 提供)
 * @param plaintext JSON 字符串或可序列化对象
 * @returns base64(nonce || ciphertext || tag) — 直接作为 HTTP body 发
 */
export function encryptBody(rootSecret: string, plaintext: string | object): string {
  const json = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const key = deriveAeadKey(rootSecret);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, enc, tag]).toString('base64');
}

/**
 * 解密 envelope 回 JSON 字符串. 失败 (key 不对 / 被改 / 短) 抛 Error.
 * 服务端用; 客户端通常不需要 (除非 v2 反向加密响应).
 */
export function decryptBody(rootSecret: string, envelopeB64: string): string {
  const buf = Buffer.from(envelopeB64, 'base64');
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error('aead envelope too short');
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const key = deriveAeadKey(rootSecret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/** 是否启用 — 等服务端支持后 export NEOX_BODY_AEAD=1 打开. */
export function isAeadEnabled(): boolean {
  return process.env.NEOX_BODY_AEAD === '1';
}

/** 测试用 — 清掉 key cache, 让 rootSecret 变更后重新派生. */
export function _resetAeadKeyCache(): void {
  _cachedKey = null;
}
