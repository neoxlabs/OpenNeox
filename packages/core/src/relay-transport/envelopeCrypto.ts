/**
 * envelopeCrypto — AES-256-GCM 共享加解密.
 *
 *   消费方:
 *     · apps/desktop/src/ui/electron/mobile-bridge/cloudRelayClient.ts (host)
 *     · apps/desktop/src/ui/electron/cloud-session/consumerClient.ts   (consumer)
 *     · packages/core/src/cloud-runtime/relayClient.ts                     (pod)
 *
 *   格式 (跟 mobile aes_gcm.dart 1:1):
 *     ciphertext_with_tag = encrypted_data || tag(16B)
 *     nonce = 12 bytes random
 *     key   = 32 bytes (AES-256)
 *     AAD   = none
 *
 *   详见 内部设计文档 §3.2
 */
import * as crypto from 'node:crypto';

export const NONCE_LEN = 12;
export const KEY_LEN = 32;
export const TAG_LEN = 16;

export function randomNonce(): Buffer {
  return crypto.randomBytes(NONCE_LEN);
}

/**
 * AES-256-GCM 加密. 返 (encrypted || tag) buffer.
 *   key:   32 bytes
 *   nonce: 12 bytes (caller 提供 — 通常 randomNonce() 或 randomBytes(12))
 */
export function encryptAesGcm(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error(`AES-256-GCM key must be ${KEY_LEN} bytes, got ${key.length}`);
  if (nonce.length !== NONCE_LEN) throw new Error(`AES-GCM nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]);
}

/**
 * AES-256-GCM 解密.
 *   ciphertextWithTag: (encrypted || 16B tag) 拼接
 *   throws 当 tag mismatch (篡改) 或 key/nonce 不对.
 */
export function decryptAesGcm(key: Buffer, nonce: Buffer, ciphertextWithTag: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error(`AES-256-GCM key must be ${KEY_LEN} bytes, got ${key.length}`);
  if (nonce.length !== NONCE_LEN) throw new Error(`AES-GCM nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  if (ciphertextWithTag.length < TAG_LEN) throw new Error(`ciphertext too short (< ${TAG_LEN}B tag)`);
  const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_LEN);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_LEN);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}
