/**
 * mobile-bridge/crypto.ts — X25519 keypair + HKDF + AES-GCM
 *
 * **零外部依赖** — 全部用 Node.js stdlib `crypto`. Node 16+ 即支持 X25519, AES-GCM.
 *
 * 跟 Dart cryptography package 互通:
 *   - X25519: raw 32-byte priv + raw 32-byte pub
 *   - HKDF-SHA256: salt=null + info="neox-mobile-relay-v1" + length=32
 *   - AES-256-GCM: 12-byte nonce + 16-byte tag (Node 默认), no AAD
 */

import * as crypto from 'node:crypto';

const HKDF_INFO = Buffer.from('neox-mobile-relay-v1', 'utf-8');
const KEY_LEN = 32; // AES-256

/**
 * X25519 keypair 生成. 返 raw 32-byte buffers (Node 默认是 DER 包装的, 我们 export raw).
 * 跟 Dart cryptography 的 SimpleKeyPair / SimplePublicKey raw bytes 兼容.
 */
export function generateX25519Keypair(): { privateKey: Buffer; publicKey: Buffer } {
  const kp = crypto.generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  /* Node 把 X25519 priv/pub 包在 DER 里, raw bytes 在末尾 32 字节 */
  const priv = Buffer.from(kp.privateKey).subarray(-32);
  const pub = Buffer.from(kp.publicKey).subarray(-32);
  return { privateKey: priv, publicKey: pub };
}

/** raw 32-byte priv → KeyObject (用于 diffieHellman) */
function privFromRaw(privRaw: Buffer): crypto.KeyObject {
  /* PKCS8 v1 wrapper for X25519 priv key — Node 接受这个格式 */
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const der = Buffer.concat([prefix, privRaw]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** raw 32-byte pub → KeyObject */
function pubFromRaw(pubRaw: Buffer): crypto.KeyObject {
  /* SPKI wrapper for X25519 pub key */
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  const der = Buffer.concat([prefix, pubRaw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * X25519 共享密钥. 返 raw 32-byte shared secret.
 * shared_secret 直接用是不安全的 (低熵), 必须走 HKDF 派生.
 */
export function computeSharedSecret(selfPrivRaw: Buffer, peerPubRaw: Buffer): Buffer {
  return crypto.diffieHellman({
    privateKey: privFromRaw(selfPrivRaw),
    publicKey: pubFromRaw(peerPubRaw),
  });
}

/**
 * HKDF-SHA256 → 32-byte AES-256-GCM key.
 * 跟协议规范 §4.2 / §4.4 严格对齐: salt=null, info="neox-mobile-relay-v1", length=32.
 */
export function deriveRelaySessionKey(sharedSecret: Buffer): Buffer {
  const okm = crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, KEY_LEN);
  return Buffer.from(okm);
}

/**
 * AES-256-GCM 加密.
 * 输入: relay_session_key (32 bytes), plaintext (Buffer/string).
 * 输出: { nonce: 12 bytes, ciphertext: payload + 16-byte auth tag appended }.
 * 这个格式跟 Dart `cryptography` 的 `AesGcm.encrypt` 返回的 SecretBox 兼容
 * (Dart 端 ciphertext + mac 拼接, 我们这边 ciphertext + tag 拼接).
 */
export function encryptAesGcm(
  key: Buffer,
  plaintext: Buffer | string,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return { nonce, ciphertext: Buffer.concat([ct, tag]) };
}

/** AES-256-GCM 解密. ciphertext 末尾 16 字节是 tag. */
export function decryptAesGcm(key: Buffer, nonce: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < 16) throw new Error('ciphertext too short, missing tag');
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** HMAC-SHA256(key, timestamp + nonce) — WS 握手防重放签名的底层实现.
 *
 *   key 的来源有两种, 安全性质完全不同:
 *     · 扫码配对 → key = device_token 本身。token 是配对时生成的随机秘密,
 *       但它**同时明文出现在 x-neox-device-token 请求头里**, 所以这个签名只防
 *       重放 (配 timestamp + nonce), 不构成身份证明 —— 能看到请求头的人就能重签。
 *     · 账号自动配对 → key = relay_session_key (X25519 ECDH + HKDF 派生, 两端
 *       各自算出, 从不上网)。此时 device_token 是公开的 `account:<phoneId>`,
 *       身份证明**完全落在这个 HMAC 上**, 强度反而高于扫码那条路。 */
export function signRequestWithKey(key: Buffer | string, timestampMs: number, nonce: string): string {
  const mac = crypto.createHmac('sha256', key);
  mac.update(`${timestampMs}.${nonce}`);
  return mac.digest('base64url');
}

/** HMAC-SHA256(token, timestamp + nonce) — 扫码配对路径 (key 即 token). */
export function signRequest(deviceToken: string, timestampMs: number, nonce: string): string {
  return signRequestWithKey(deviceToken, timestampMs, nonce);
}

export function verifyRequestSignatureWithKey(
  key: Buffer | string,
  timestampMs: number,
  nonce: string,
  signatureB64url: string,
): boolean {
  const expected = signRequestWithKey(key, timestampMs, nonce);
  /* timing-safe compare */
  try {
    const a = Buffer.from(expected, 'base64url');
    const b = Buffer.from(signatureB64url, 'base64url');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 扫码配对路径的验签 (key 即 token) — 保持原签名, 老调用方不用改. */
export function verifyRequestSignature(
  deviceToken: string,
  timestampMs: number,
  nonce: string,
  signatureB64url: string,
): boolean {
  return verifyRequestSignatureWithKey(deviceToken, timestampMs, nonce, signatureB64url);
}

/** pubkey fingerprint — sha256 取前 8 字节 hex (用户肉眼对比用) */
export function pubkeyFingerprint(pubRaw: Buffer): string {
  const h = crypto.createHash('sha256').update(pubRaw).digest('hex');
  return h.match(/.{2}/g)!.slice(0, 8).join(':');
}

/** 生成一次性 pairing_token (16 bytes 随机, base64url) */
export function generatePairingToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** 生成长期 device_token (32 bytes 随机, base64url) */
export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 生成 6 位备份码 (大写字母 + 数字, 不含易混 0/O/1/I/L) */
const BACKUP_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateBackupCode(): string {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    s += BACKUP_CHARS[bytes[i]! % BACKUP_CHARS.length];
  }
  /* 4-4 分组 */
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

export function hashBackupCode(code: string): string {
  /* 去掉横线大写化, 取一致 hash */
  const norm = code.toUpperCase().replace(/-/g, '');
  return crypto.createHash('sha256').update(norm).digest('hex');
}
