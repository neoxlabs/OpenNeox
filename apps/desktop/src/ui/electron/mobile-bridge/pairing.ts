/**
 * mobile-bridge/pairing.ts — 配对流程协议
 *
 * 严格对齐 内部设计文档 §2.3 (扫码配对) + §2.4 (反向防钓鱼).
 *
 * 流程:
 *   1. createPairingSession() — Desktop 生成一次性 token + 6 位备份码 + 5min TTL
 *   2. getQRPayload(token) — 给 renderer 拿 QR 内容编 base64url
 *   3. consumePairingByQR(req) — Phone 扫码后 POST, 校验 + X25519 派生 + 颁发 device_token
 *   4. consumePairingByCode(req) — 同上但用 6 位备份码
 *
 * 内存表 pendingPairings 5min 过期, 不持久化 (重启后失效, 用户重扫即可).
 *
 * code:REMOTE-04 — 码之外还要校验手机属于电脑当前登录的账号 (见 pairingAccount.ts),
 * 否则拿到码的别人可以用自己的账号配对。
 */

import {
  generatePairingToken,
  generateDeviceToken,
  generateBackupCode,
  hashBackupCode,
  computeSharedSecret,
  deriveRelaySessionKey,
  pubkeyFingerprint,
} from './crypto.js';
import {
  getDeviceId,
  getDeviceName,
  getDesktopKeypair,
  getDesktopPubkeyFingerprint,
  addPairedMobile,
} from './deviceStore.js';
import { PROTOCOL_VERSION } from './types.js';
import { bridgeLog } from './log.js';
import { verifyPhoneAccount } from './pairingAccount.js';
import type {
  PairingQRPayload,
  PairingRequest,
  PairingResponse,
  PairingByCodeRequest,
  PendingPairing,
} from './types.js';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 16;
const MAX_PAIRING_TOKEN_LEN = 128;
const MAX_BACKUP_CODE_LEN = 32;
const MAX_PUBKEY_B64_LEN = 128;
const MAX_PHONE_DEVICE_ID_LEN = 128;
const MAX_PHONE_DEVICE_NAME_LEN = 64;

interface PendingPairingInternal extends PendingPairing {
  backup_code_display: string; // 显示给用户的明文 (调试 + UI 显示)
}

const pendingPairings = new Map<string, PendingPairingInternal>();

/** GC 过期 token — 每次操作顺便扫一遍 */
function gcExpired(): void {
  const now = Date.now();
  for (const [k, v] of pendingPairings) {
    if (v.expires_at <= now) pendingPairings.delete(k);
  }
}

function trimBoundedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > maxLen) return null;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePhoneDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_PHONE_DEVICE_NAME_LEN);
  return trimmed.length > 0 ? trimmed : null;
}

function capPendingPairings(): void {
  while (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
    const oldest = pendingPairings.keys().next().value;
    if (!oldest) break;
    pendingPairings.delete(oldest);
  }
}

/**
 * 启动一次配对会话 — 生成 token + backup_code, 返给 renderer 渲染 QR.
 * 同时也可以走 backup_code 手输 fallback.
 */
export function createPairingSession(): {
  pairing_token: string;
  backup_code: string;
  expires_at: number;
} {
  gcExpired();
  capPendingPairings();
  const pairing_token = generatePairingToken();
  const backup_code = generateBackupCode();
  const expires_at = Date.now() + PAIRING_TTL_MS;
  pendingPairings.set(pairing_token, {
    pairing_token,
    backup_code_hash: hashBackupCode(backup_code),
    backup_code_display: backup_code,
    expires_at,
  });
  return { pairing_token, backup_code, expires_at };
}

/** 拿 QR payload 内容 — renderer 调来编 base64url 生成 QR.
 *  hosts 是全部候选 LAN IP (Phone 端逐个 try, 防多网卡选错); host 是首选 (兼容). */
export function getQRPayload(
  pairing_token: string,
  host: string,
  port: number,
  hosts?: string[],
): PairingQRPayload | null {
  gcExpired();
  const p = pendingPairings.get(pairing_token);
  if (!p) return null;
  const pub = getDesktopKeypair().publicKey;
  return {
    v: PROTOCOL_VERSION,
    host,
    ...(hosts && hosts.length > 1 && { hosts }),
    port,
    device_id: getDeviceId(),
    device_name: getDeviceName(),
    pubkey: pub.toString('base64url'),
    pubkey_fingerprint: pubkeyFingerprint(pub),
    pairing_token,
    expires_at: p.expires_at,
  };
}

/** Phone 通过 QR 扫描后 POST /api/v1/pair 调到此 */
export async function consumePairingByQR(req: PairingRequest): Promise<{ ok: true; response: PairingResponse } | { ok: false; error: string }> {
  gcExpired();
  if (!req || typeof req !== 'object') return { ok: false, error: 'invalid pairing request' };
  const pairingToken = trimBoundedString((req as any).pairing_token, MAX_PAIRING_TOKEN_LEN);
  if (!pairingToken) return { ok: false, error: 'pairing_token invalid or expired' };
  const p = pendingPairings.get(pairingToken);
  if (!p) return { ok: false, error: 'pairing_token invalid or expired' };
  return finalizePairing(
    (req as any).phone_pubkey,
    (req as any).phone_device_id,
    (req as any).phone_device_name,
    pairingToken,
  );
}

/** Phone 手输 6 位备份码 fallback 路径 */
export async function consumePairingByCode(req: PairingByCodeRequest): Promise<{ ok: true; response: PairingResponse } | { ok: false; error: string }> {
  gcExpired();
  if (!req || typeof req !== 'object') return { ok: false, error: 'invalid pairing request' };
  const backupCode = trimBoundedString((req as any).backup_code, MAX_BACKUP_CODE_LEN);
  if (!backupCode) return { ok: false, error: 'backup_code invalid or expired' };
  const codeHash = hashBackupCode(backupCode);
  /* 找匹配 hash 的 pending */
  let matched: PendingPairingInternal | null = null;
  for (const p of pendingPairings.values()) {
    if (p.backup_code_hash === codeHash) {
      matched = p;
      break;
    }
  }
  if (!matched) return { ok: false, error: 'backup_code invalid or expired' };
  return finalizePairing(
    (req as any).phone_pubkey,
    (req as any).phone_device_id,
    (req as any).phone_device_name,
    matched.pairing_token,
  );
}

/** 电脑上已经有人点了「允许」(pairRequest.ts): 不需要码, 直接走同一套收尾 */
export async function consumeApprovedPairing(
  phonePubkey: string,
  phoneDeviceId: string,
  phoneDeviceName: string,
): Promise<{ ok: true; response: PairingResponse } | { ok: false; error: string }> {
  const { pairing_token } = createPairingSession();
  const r = await finalizePairing(phonePubkey, phoneDeviceId, phoneDeviceName, pairing_token);
  pendingPairings.delete(pairing_token);
  return r;
}

/** 共用配对收尾 — 校验账号 + 派生 relay_session_key + 颁发 device_token + 落库 + 删 pending */
async function finalizePairing(
  phonePubkeyB64url: unknown,
  phoneDeviceId: unknown,
  phoneDeviceName: unknown,
  pairingToken: string,
): Promise<{ ok: true; response: PairingResponse } | { ok: false; error: string }> {
  const cleanPhonePubkey = trimBoundedString(phonePubkeyB64url, MAX_PUBKEY_B64_LEN);
  const cleanPhoneDeviceId = trimBoundedString(phoneDeviceId, MAX_PHONE_DEVICE_ID_LEN);
  const cleanPhoneDeviceName = normalizePhoneDeviceName(phoneDeviceName);
  if (!cleanPhonePubkey || !cleanPhoneDeviceId || !cleanPhoneDeviceName) {
    return { ok: false, error: 'phone_device_id / phone_device_name / phone_pubkey invalid' };
  }
  /* base64url 容错: Phone 可能传 base64url 或标准 base64, 我们正规化 */
  const phonePub = normalizeBase64ToBuffer(cleanPhonePubkey);
  if (!phonePub || phonePub.length !== 32) {
    return { ok: false, error: 'phone_pubkey 无效 (必须是 32 字节 X25519 raw key, base64url 编码)' };
  }

  /* code:REMOTE-04 — 只允许本人账号: 手机必须出现在电脑当前登录账号的设备列表里。
   * 校验失败不消耗 pending 码 (用户换对账号后还能用同一个码重试)。 */
  const account = await verifyPhoneAccount({
    phoneDeviceId: cleanPhoneDeviceId,
    phonePubkeyB64: cleanPhonePubkey,
  });
  if (!account.ok) {
    bridgeLog('pairing', `账号校验拒绝 ${cleanPhoneDeviceId.slice(0, 16)}…: ${account.code}`);
    return { ok: false, error: account.message };
  }

  const { privateKey: desktopPriv, publicKey: desktopPub } = getDesktopKeypair();
  let sharedSecret: Buffer;
  try {
    sharedSecret = computeSharedSecret(desktopPriv, phonePub);
  } catch (e: any) {
    return { ok: false, error: `X25519 共享密钥派生失败: ${e?.message ?? String(e)}` };
  }
  const relaySessionKey = deriveRelaySessionKey(sharedSecret);
  const deviceToken = generateDeviceToken();
  const now = Date.now();

  /* P0 — 把配对绑定到当前 desktop 登录的 user.id, 防 B 登录后看到 A 配对的手机.
   *   code:REMOTE-04: 直接用账号校验拿到的 user.id —— 跟校验用的 token 同源,
   *   不会再出现 require 拿不到而落成 null 的情况。未登录时 null = 老行为。 */
  const ownerUserId = account.desktopUserId;

  addPairedMobile({
    device_id: cleanPhoneDeviceId,
    device_name: cleanPhoneDeviceName,
    phone_pubkey_b64: phonePub.toString('base64'),
    relay_session_key_b64: relaySessionKey.toString('base64'),
    device_token: deviceToken,
    paired_at: now,
    last_seen_at: null,
    owner_user_id: ownerUserId,
  });

  /* 删 pending token (一次性) — 只有配对成功才删; 账号校验失败时保留给用户重试 */
  pendingPairings.delete(pairingToken);

  void (async () => {
    try {
      const { ensureCloudRelayClientRunning } = await import('./index.js');
      const r = await ensureCloudRelayClientRunning();
      bridgeLog('pairing', `配对完成, 云中继: ${r}`);
    } catch (e: any) {
      bridgeLog('pairing', `配对后启动云中继失败: ${e?.message ?? e}`);
    }
  })();

  /* 配了自托管中继: 配对回包里一并给手机 (只给刚配上的这台, 不放进二维码图里) */
  const { loadSelfHostedRelay } = await import('./selfHostedRelay.js');
  const selfHosted = loadSelfHostedRelay();

  return {
    ok: true,
    response: {
      device_token: deviceToken,
      desktop_pubkey: desktopPub.toString('base64url'),
      relay_session_key_fingerprint: pubkeyFingerprint(relaySessionKey),
      ...(selfHosted && { relay: { url: selfHosted.url, token: selfHosted.token } }),
    },
  };
}

/** base64url / base64 → Buffer (容错两种) */
function normalizeBase64ToBuffer(s: string): Buffer | null {
  if (s.length > MAX_PUBKEY_B64_LEN) return null;
  try {
    return Buffer.from(s, 'base64url');
  } catch {
    try {
      return Buffer.from(s, 'base64');
    } catch {
      return null;
    }
  }
}

/** 列出当前 pending 配对 (调试 / 给 UI 显示倒计时) */
export function listPendingPairings(): Array<{
  pairing_token: string;
  backup_code: string;
  expires_at: number;
  expires_in_ms: number;
}> {
  gcExpired();
  const now = Date.now();
  return Array.from(pendingPairings.values()).map((p) => ({
    pairing_token: p.pairing_token,
    backup_code: p.backup_code_display,
    expires_at: p.expires_at,
    expires_in_ms: Math.max(0, p.expires_at - now),
  }));
}

/** 取消一个 pending 配对 (用户关 QR 弹窗时) */
export function cancelPairing(pairing_token: string): boolean {
  return pendingPairings.delete(pairing_token);
}

/** 测试用 */
export function _clearPendingPairings(): void {
  pendingPairings.clear();
}
