/**
 * pairingAccount.ts — 局域网配对时的账号归属校验 (code:REMOTE-04).
 *
 * 为什么要这个文件:
 *   扫码 / 备份码配对原来只校验"码"。码是显示在电脑屏幕上的, 截屏转发出去之后,
 *   别人的手机 (登录的是另一个账号) 一样能配对成功, 之后就能看这台电脑上的代码。
 *   中转那条路本来就按账号隔离 (`/devices/my` 只返回本账号设备), 局域网这条没有。
 *
 * 做法 (不把任何凭据送到局域网上):
 *   手机登录后本来就会 POST /devices/announce, 把自己的 X25519 公钥登记在**自己账号**
 *   名下 (apps/mobile .../auto_pair_service.dart)。电脑已登录时, 用**电脑自己的**
 *   token 拉 /devices/my?kinds=mobile —— 这个列表天然只有电脑账号的设备。配对请求里的
 *   phone_device_id + phone_pubkey 必须出现在列表里, 否则拒绝。
 *
 * 三种边界:
 *   · 电脑没登录 (公开版 / 没账号) → 没有账号可绑, 保持旧行为 (码本身即凭据)。
 *   · 电脑登录了但拉不到列表 (断网 / 5xx) → **拒绝**。放行等于这道校验可以被人为
 *     绕开: 攻击者只要让请求失败就行, 那还不如不做。
 *   · 手机没 announce 过 (列表里没有) → 拒绝, 提示用同一账号登录手机后重试。
 */

import * as crypto from 'node:crypto';

import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';

const MAX_DEVICE_ID_LEN = 128;
const MAX_PUBKEY_B64_LEN = 128;
const MAX_ACCOUNT_DEVICES = 500;
const DEVICE_LIST_TIMEOUT_MS = 5_000;

export type PhoneAccountVerdict =
  | { ok: true; desktopUserId: string | null }
  | { ok: false; code: 'invalid_input' | 'account_mismatch' | 'account_unverifiable'; message: string };

export interface PhoneAccountDeps {
  /** 电脑当前登录态; 返 null = 未登录。测试注入用, 缺省走 authHandlers。 */
  getDesktopAuth?: () => Promise<{ accessToken: string; userId: string | null } | null>;
  /** 云端 API 基址; 缺省 resolveCloudEndpoints().api。 */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

interface AccountDevice {
  device_id?: unknown;
  pubkey_b64?: unknown;
}

async function defaultGetDesktopAuth(): Promise<{ accessToken: string; userId: string | null } | null> {
  const { ensureFreshDesktopAuthTokens } = await import('../ipc/authHandlers.js');
  const tok = await ensureFreshDesktopAuthTokens();
  if (!tok?.accessToken) return null;
  return { accessToken: tok.accessToken, userId: tok.user?.id ?? null };
}

function decodeB64Loose(s: string): Buffer {
  /* base64 standard / url-safe 都吃, 跟 autoPairPoller 同款 */
  const n = s.replaceAll('-', '+').replaceAll('_', '/');
  const padded = n + '='.repeat((4 - (n.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sameKey(a: string, phonePub: Buffer): boolean {
  const peer = decodeB64Loose(a);
  return peer.length === phonePub.length && crypto.timingSafeEqual(peer, phonePub);
}

/**
 * 校验配对请求里的手机是否属于电脑当前登录的账号。
 * 返回 `desktopUserId` 供落库时记 owner_user_id (未登录时为 null)。
 */
export async function verifyPhoneAccount(
  input: { phoneDeviceId: string; phonePubkeyB64: string },
  deps: PhoneAccountDeps = {},
): Promise<PhoneAccountVerdict> {
  const deviceId = typeof input?.phoneDeviceId === 'string' ? input.phoneDeviceId.trim() : '';
  const pubB64 = typeof input?.phonePubkeyB64 === 'string' ? input.phonePubkeyB64.trim() : '';
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_LEN || !pubB64 || pubB64.length > MAX_PUBKEY_B64_LEN) {
    return { ok: false, code: 'invalid_input', message: 'phone_device_id / phone_pubkey 无效' };
  }
  const phonePub = decodeB64Loose(pubB64);
  if (phonePub.length !== 32) {
    return { ok: false, code: 'invalid_input', message: 'phone_pubkey 无效 (必须是 32 字节 X25519 raw key)' };
  }

  let auth: { accessToken: string; userId: string | null } | null;
  try {
    auth = await (deps.getDesktopAuth ?? defaultGetDesktopAuth)();
  } catch {
    return {
      ok: false,
      code: 'account_unverifiable',
      message: '无法读取电脑登录状态，请重启电脑端后重试',
    };
  }
  /* 电脑没登录 = 没有账号可绑 (公开版 / 没账号的部署), 保持旧行为 */
  if (!auth?.accessToken) return { ok: true, desktopUserId: null };

  const apiBase = (deps.apiBase ?? resolveCloudEndpoints().api).replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEVICE_LIST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetchImpl(`${apiBase}/api/v1/devices/my?kinds=mobile`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      signal: controller.signal,
    });
  } catch {
    return {
      ok: false,
      code: 'account_unverifiable',
      message: '无法校验手机账号，请检查电脑网络后重试',
    };
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    return {
      ok: false,
      code: 'account_unverifiable',
      message: '无法校验手机账号，请检查电脑网络后重试',
    };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return {
      ok: false,
      code: 'account_unverifiable',
      message: '无法校验手机账号，请检查电脑网络后重试',
    };
  }
  const devices = (data as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) {
    return {
      ok: false,
      code: 'account_unverifiable',
      message: '无法校验手机账号，请检查电脑网络后重试',
    };
  }

  const matched = devices.slice(0, MAX_ACCOUNT_DEVICES).some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const d = raw as AccountDevice;
    if (d.device_id !== deviceId) return false;
    if (typeof d.pubkey_b64 !== 'string') return false;
    return sameKey(d.pubkey_b64, phonePub);
  });
  if (!matched) {
    return {
      ok: false,
      code: 'account_mismatch',
      message: '这台手机登录的账号与电脑不一致，请用同一账号登录手机后重试',
    };
  }

  return { ok: true, desktopUserId: auth.userId };
}
