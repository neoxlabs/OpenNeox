/**
 * autoPairPoller — B 方案 desktop 端: 周期 fetch NeoxCloud 同账号 mobile,
 *   每个 mobile 用 ECDH 派生 relay_session_key, addPairedMobile 落本机 deviceStore.
 *
 *   - 启动时调一次 (登录态下), 之后 5min 一刷
 *   - 失败不抛, 下轮重试
 *   - 幂等: device_id + pubkey 没变就跳
 *
 *   关键: 必须在 mobile 发起 cloud-relay 连接前完成. 不然 desktop 没 paired_mobiles 行,
 *   envelope 解密失败, 连接挂.
 */
import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';
import { getDesktopKeypair, addPairedMobile, getPairedMobileById } from './deviceStore.js';
import { computeSharedSecret, deriveRelaySessionKey, generateDeviceToken } from './crypto.js';
import { ensureFreshDesktopAuthTokens } from '../ipc/authHandlers.js';

const POLL_INTERVAL_MS = 5 * 60_000;          /* 5 min */
const FAST_RETRY_MS = 30_000;                 /* 启动失败时 30s 后重试 */

let timer: NodeJS.Timeout | null = null;

export function startAutoPairPoller(): void {
  if (timer) return;
  /* 立即跑一次 */
  void runOnce();
  timer = setInterval(() => { void runOnce(); }, POLL_INTERVAL_MS);
}

export function stopAutoPairPoller(): void {
  if (timer) { clearInterval(timer); timer = null; }
}


/** 同一个 deviceId 这么久内只按需拉一次 —— 防连不上的手机每次重试都打一发云端 */
const ON_DEMAND_COOLDOWN_MS = 30_000;
/** 全局并发闸: 同一时刻只允许一次按需拉取, 后来的复用同一个 promise */
let onDemandInflight: Promise<boolean> | null = null;
const onDemandLastTry = new Map<string, number>();

/**
 * 握手时发现"不认识这台手机" → 当场拉一次同账号设备并派生密钥。
 * 返回是否**可能**变更了配对表 (调用方据此决定要不要重验一次)。
 */
export async function ensureMobilePairedOnDemand(deviceId: string): Promise<boolean> {
  const id = (deviceId || '').trim();
  if (!id || id.length > 128) return false;

  const now = Date.now();
  const last = onDemandLastTry.get(id) ?? 0;
  if (now - last < ON_DEMAND_COOLDOWN_MS) return false;
  onDemandLastTry.set(id, now);
  /* map 不设上限就是个内存泄漏点 —— 冷却期一过的条目直接清掉 */
  if (onDemandLastTry.size > 64) {
    for (const [k, t] of onDemandLastTry) {
      if (now - t >= ON_DEMAND_COOLDOWN_MS) onDemandLastTry.delete(k);
    }
  }

  if (onDemandInflight) return onDemandInflight;
  onDemandInflight = (async () => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[auto-pair] 握手不认识 ${id.slice(0, 8)}…, 当场拉一次同账号设备`);
      await runOnce();
      return true;
    } catch {
      return false;
    } finally {
      onDemandInflight = null;
    }
  })();
  return onDemandInflight;
}

async function runOnce(): Promise<void> {
  let token: { accessToken: string; user?: { id?: string } } | null = null;
  try {
    token = (await ensureFreshDesktopAuthTokens()) as any;
  } catch {
    /* 没登录 */
    scheduleFastRetry();
    return;
  }
  if (!token?.accessToken) {
    scheduleFastRetry();
    return;
  }
  const ownerUserId = token.user?.id ?? null;
  const ep = resolveCloudEndpoints();
  const url = `${ep.api}/api/v1/devices/my?kinds=mobile`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[auto-pair] /devices/my ${resp.status}`);
      return;
    }
    const data = await resp.json() as { devices?: Array<{
      device_id: string; device_kind: string; device_name?: string;
      pubkey_b64: string; last_announce_at?: number;
    }> };
    const list = data.devices ?? [];
    const kp = getDesktopKeypair();
    let pairedCount = 0;
    for (const d of list) {
      if (!d.device_id || !d.pubkey_b64) continue;
      const mobilePub = decodeB64Loose(d.pubkey_b64);
      if (mobilePub.length !== 32) {
        // eslint-disable-next-line no-console
        console.warn(`[auto-pair] skip ${d.device_id}: bad pubkey len ${mobilePub.length}`);
        continue;
      }
      const existing = getPairedMobileById(d.device_id, { currentUserId: ownerUserId });
      if (existing
        && existing.phone_pubkey_b64 === Buffer.from(mobilePub).toString('base64')
        && existing.device_token === `account:${d.device_id}`) {
        continue;
      }
      /* ECDH + HKDF — 跟扫码同款派生 */
      let sharedSecret: Buffer;
      try {
        sharedSecret = computeSharedSecret(kp.privateKey, mobilePub);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn(`[auto-pair] ECDH failed for ${d.device_id}: ${e?.message}`);
        continue;
      }
      const relayKey = deriveRelaySessionKey(sharedSecret);
      addPairedMobile({
        device_id: d.device_id,
        device_name: d.device_name ?? null,
        phone_pubkey_b64: Buffer.from(mobilePub).toString('base64'),
        relay_session_key_b64: relayKey.toString('base64'),
        device_token: `account:${d.device_id}`,
        paired_at: Date.now(),
        last_seen_at: d.last_announce_at ?? Date.now(),
        owner_user_id: ownerUserId,
      }, { dedupeByName: false });
      pairedCount++;
    }
    if (pairedCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`[auto-pair] paired ${pairedCount} mobiles (account-trusted)`);
      try {
        const { ensureCloudRelayClientRunning } = await import('./index.js');
        const r = await ensureCloudRelayClientRunning();
        // eslint-disable-next-line no-console
        console.log(`[auto-pair] cloud relay: ${r}`);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[auto-pair] ensure cloud relay failed:', e?.message ?? e);
      }
    }
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[auto-pair] poll failed:', e?.message ?? e);
  }
}

function scheduleFastRetry(): void {
  /* 没登录就 30s 后再试 (用户可能正在登录) */
  setTimeout(() => { void runOnce(); }, FAST_RETRY_MS);
}

function decodeB64Loose(s: string): Buffer {
  /* base64 standard or url-safe 都能吃 */
  const n = s.replaceAll('-', '+').replaceAll('_', '/');
  const padded = n + '='.repeat((4 - n.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}
