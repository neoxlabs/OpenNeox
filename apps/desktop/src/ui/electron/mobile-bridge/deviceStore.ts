
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import {
  generateX25519Keypair,
  pubkeyFingerprint,
} from './crypto.js';
import { getStableMachineId } from '../services/localSecretCipher.js';
import type { PairedMobile } from './types.js';
import { writePeerFile } from '@neoxlabs/core/phone-endpoint/peerFile.js';
import { deriveCliEndpointKey } from '@neoxlabs/core/relay-transport/index.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';
import { stableHostLabel } from '@neoxlabs/kernel/platform/stableHostLabel.js';
import {
  deviceIdFromMachineId,
  machineFingerprintFromMachineId,
} from '@neoxlabs/kernel/platform/machineIdentity.js';

interface DeviceStoreData {
  version: number;
  device_id: string;
  device_name: string;
  desktop_privkey_b64: string;   // X25519 raw 32 bytes, base64 — **永不上云**
  desktop_pubkey_b64: string;    // X25519 raw 32 bytes, base64
  paired_mobiles: PairedMobile[];
  created_at: number;
  last_ws_port?: number;
  superseded_device_ids?: string[];
}

const STORE_VERSION = 1;
const LEGACY_STORE_FILE = 'mobile-bridge.json';
const DB_KEY = 'mobile-bridge';
const MAX_DEVICE_ID_LEN = 128;
const MAX_DEVICE_NAME_LEN = 64;
const MAX_DEVICE_TOKEN_LEN = 256;
const MAX_KEY_B64_LEN = 128;

function legacyStorePath(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, LEGACY_STORE_FILE);
}

function getDb(): any {
  try { return getDatabase(); } catch { return null; }
}

let cache: DeviceStoreData | null = null;

function cleanBoundedString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
}

function cleanDeviceId(value: unknown): string {
  return cleanBoundedString(value, MAX_DEVICE_ID_LEN);
}

function cleanDeviceName(value: unknown): string | null {
  const name = cleanBoundedString(value, MAX_DEVICE_NAME_LEN);
  return name.length > 0 ? name : null;
}

function cleanDeviceToken(value: unknown): string {
  return cleanBoundedString(value, MAX_DEVICE_TOKEN_LEN);
}

function cleanB64(value: unknown): string {
  return cleanBoundedString(value, MAX_KEY_B64_LEN);
}

function normalizeOwnerUserId(value: unknown): string | null {
  const owner = cleanBoundedString(value, 128);
  return owner.length > 0 ? owner : null;
}

export function isPairedMobileVisibleToUser(m: PairedMobile, currentUserId: string | null | undefined): boolean {
  const owner = m.owner_user_id ?? null;
  if (owner === null) return true;
  return owner === (currentUserId ?? null);
}

function shouldIncludeForOwner(
  m: PairedMobile,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): boolean {
  return opts.filter === 'all' || isPairedMobileVisibleToUser(m, opts.currentUserId ?? null);
}

function healIdentity(stored: DeviceStoreData): DeviceStoreData {
  let next = stored;
  let changed = false;

  const derived = derivedDeviceIdOrNull();
  if (derived && stored.device_id && stored.device_id !== derived) {
    const superseded = Array.from(
      new Set([...(stored.superseded_device_ids ?? []), stored.device_id]),
    ).slice(-8);
    next = { ...next, device_id: derived, superseded_device_ids: superseded };
    changed = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[mobile-bridge] device_id 收敛: ${stored.device_id} → ${derived} ` +
      '(旧值是 machine-id 派生之前留下的, 会上报给服务端合并)',
    );
  }

  /* mac 的 DHCP 漂移名: `<name>-<数字>` 或 `<name>-<数字>.local`.
   * 只在名字确实长这样时才改 —— 用户在设置里自己起过名的不能被覆盖。 */
  const isDriftingHostName =
    process.platform === 'darwin' && /-\d{3,}(\.local)?$/i.test(stored.device_name ?? '');
  if (isDriftingHostName) {
    const stable = deriveDeviceName();
    if (stable && stable !== stored.device_name) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mobile-bridge] device_name 收敛: ${stored.device_name} → ${stable} ` +
        '(前者是 DHCP 分配的 LocalHostName, 换网就变)',
      );
      next = { ...next, device_name: stable };
      changed = true;
    }
  }

  if (changed) {
    cache = next;      // save() 会读 cache, 先摆好再存
    save(next);
  }
  return next;
}

function load(): DeviceStoreData {
  if (cache) return cache;
  const db = getDb();

  /* 1. 优先读 DB */
  if (db) {
    const stored = db.getAppState(DB_KEY) as DeviceStoreData | undefined;
    if (stored && stored.version === STORE_VERSION) {
      cache = healIdentity(stored);
      /* 升级上来的老配对: 启动时补写一次, 不用等下次配对变动 */
      exportCliPeers(cache);
      return cache;
    }
  }

  /* 2. 迁移旧 JSON → DB (一次性), 然后删 JSON */
  const fp = legacyStorePath();
  if (fs.existsSync(fp)) {
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const data = JSON.parse(raw) as DeviceStoreData;
      if (data.version === STORE_VERSION) {
        if (db) {
          db.setAppState(DB_KEY, data);
          try { fs.unlinkSync(fp); } catch { /* file not there */ }
          // eslint-disable-next-line no-console
          console.log('[mobile-bridge] migrated legacy JSON → DB, removed', fp);
        }
        cache = healIdentity(data);
        return cache;
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[mobile-bridge] legacy store corrupt:', e?.message);
      try { fs.renameSync(fp, fp + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    }
  }

  /* 3. 首次初始化 — 生成 desktop X25519 keypair + device_id */
  const kp = generateX25519Keypair();
  const data: DeviceStoreData = {
    version: STORE_VERSION,
    device_id: newDeviceId(),
    device_name: deriveDeviceName(),
    desktop_privkey_b64: kp.privateKey.toString('base64'),
    desktop_pubkey_b64: kp.publicKey.toString('base64'),
    paired_mobiles: [],
    created_at: Date.now(),
  };
  save(data);
  cache = data;
  return data;
}

/* CLI 入口用的配对清单 (只放派生子密钥, 见 packages/core phone-endpoint/peerFile.ts)。
 * 写失败不影响配对本身, 只是 CLI 暂时连不上手机。 */
function exportCliPeers(data: DeviceStoreData): void {
  try {
    writePeerFile({
      device_id: data.device_id,
      device_name: data.device_name,
      peers: data.paired_mobiles
        .filter((m) => !!m.relay_session_key_b64)
        .map((m) => ({
          device_id: m.device_id,
          owner_user_id: m.owner_user_id ?? null,
          name: m.device_name ?? undefined,
          key_b64: deriveCliEndpointKey(Buffer.from(m.relay_session_key_b64, 'base64')).toString('base64'),
        })),
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] export cli peers failed:', e?.message);
  }
}

function save(data: DeviceStoreData): void {
  exportCliPeers(data);
  const db = getDb();
  if (db) {
    db.setAppState(DB_KEY, data);
    cache = data;
    return;
  }
  /* DB 不可用时回落到旧 JSON 路径 (理论不该发生, 极端兜底) */
  const fp = legacyStorePath();
  const tmp = fp + '.tmp';
  try { fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fp);
  cache = data;
}

export function derivedDeviceIdOrNull(): string | null {
  try {
    /* 别的发行版 (开源版) 同机共存时是另一台"设备": machine-id 是硬件派生、两边一样,
     * scope 不分开的话 mDNS 主机名撞车、同一个中继上互相顶号。商业版保持 'desktop' 不变。 */
    const scope = DISTRIBUTION.id === 'neox' ? 'desktop' : `${DISTRIBUTION.id}-desktop`;
    return deviceIdFromMachineId(getStableMachineId(), scope);
  } catch { return null; }
}

/** 本机的 machine 指纹 — 上报给服务端做"同一台机器"的合并依据, 详见 machineIdentity.ts. */
export function machineFingerprintOrNull(): string | null {
  try {
    return machineFingerprintFromMachineId(getStableMachineId());
  } catch { return null; }
}

function newDeviceId(): string {
  const derived = derivedDeviceIdOrNull();
  if (!derived) {
    throw new Error(
      '[mobile-bridge] 无法派生 device_id: 取不到稳定 machine-id。' +
      '这通常意味着 Neox 数据目录不可写, 请检查权限后重启。',
    );
  }
  return derived;
}

function deriveDeviceName(): string {
  const base = stableHostLabel() || 'Neox Desktop';
  /* 极简版加后缀 —— 两个版本可能在同一台机器上同时开着, 而 mDNS 广播的就是这个名字。
   * 同名的话手机端会看到两个一模一样的设备, 分不清连的是哪个 (端口是动态的, 更看不出来)。
   * 配对密钥/设备 id 本来就各存各的目录 (标准版 Application Support/Neox, 极简版 ~/.neox-lite),
   * 所以它们本来就是两台独立设备, 名字也该能区分。 */
  if (String(process.env.NEOX_EDITION || '').trim().toLowerCase() === 'lite') return `${base} (Lite)`;
  /* 同理: 开源版跟商业版同机时, 手机上要分得清是哪一个 */
  return DISTRIBUTION.id === 'neox' ? base : `${base} (${DISTRIBUTION.appName})`;
}

/* ────────────── 公开 API ────────────── */

export function getDeviceId(): string {
  return load().device_id;
}

export function getDeviceName(): string {
  return load().device_name;
}

/** 本机被取代过的旧 device_id —— presence.register 带上, 服务端据此合并重复设备行. */
export function getSupersededDeviceIds(): string[] {
  return [...(load().superseded_device_ids ?? [])];
}

export function setDeviceName(name: string): void {
  const data = load();
  data.device_name = cleanDeviceName(name) ?? data.device_name;
  save(data);
}

export function getDesktopKeypair(): { privateKey: Buffer; publicKey: Buffer } {
  const data = load();
  return {
    privateKey: Buffer.from(data.desktop_privkey_b64, 'base64'),
    publicKey: Buffer.from(data.desktop_pubkey_b64, 'base64'),
  };
}

export function getDesktopPubkeyFingerprint(): string {
  const pub = Buffer.from(load().desktop_pubkey_b64, 'base64');
  return pubkeyFingerprint(pub);
}

/** 列已配对手机. 默认按当前 desktop 登录用户过滤 — 跨用户隔离 (P0).
 *   传 currentUserId=null 表示当前未登录, 这种状态下不返 owner_user_id 非 null 的条目
 *   (这些条目是某个具体登录用户配对的, 未登录态不该看).
 *   filter='all' 仅 admin 路径用 (清理 / dedup), 跳过隔离. */
export function listPairedMobiles(
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): PairedMobile[] {
  const all = load().paired_mobiles;
  if (opts.filter === 'all') return [...all];
  const userId = opts.currentUserId ?? null;
  return all.filter((m) => isPairedMobileVisibleToUser(m, userId));
}

export function getPairedMobileById(
  deviceId: string,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): PairedMobile | null {
  const id = cleanDeviceId(deviceId);
  if (!id) return null;
  return load().paired_mobiles.find((m) => m.device_id === id && shouldIncludeForOwner(m, opts)) ?? null;
}

export function getPairedMobileByToken(
  token: string,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): PairedMobile | null {
  const deviceToken = cleanDeviceToken(token);
  if (!deviceToken || deviceToken.startsWith('account:')) return null;
  return load().paired_mobiles.find((m) => m.device_token === deviceToken && shouldIncludeForOwner(m, opts)) ?? null;
}

/** 撤销某 userId 名下所有配对 — 登出时调, 防 B 登录看到 A 的配对手机. */
export function removePairedMobilesForUser(userId: string): number {
  if (!userId) return 0;
  const data = load();
  const before = data.paired_mobiles.length;
  data.paired_mobiles = data.paired_mobiles.filter((m) => (m.owner_user_id ?? null) !== userId);
  const removed = before - data.paired_mobiles.length;
  if (removed > 0) save(data);
  return removed;
}

export function addPairedMobile(
  m: Omit<PairedMobile, 'id'>,
  opts: { dedupeByName?: boolean } = {},
): PairedMobile {
  const data = load();
  const owner = normalizeOwnerUserId(m.owner_user_id);
  const clean: Omit<PairedMobile, 'id'> = {
    device_id: cleanDeviceId(m.device_id),
    device_name: cleanDeviceName(m.device_name),
    phone_pubkey_b64: cleanB64(m.phone_pubkey_b64),
    relay_session_key_b64: cleanB64(m.relay_session_key_b64),
    device_token: cleanDeviceToken(m.device_token),
    paired_at: Number.isFinite(m.paired_at) ? m.paired_at : Date.now(),
    last_seen_at: Number.isFinite(m.last_seen_at) ? m.last_seen_at : null,
    owner_user_id: owner,
  };
  if (!clean.device_id || !clean.phone_pubkey_b64 || !clean.relay_session_key_b64 || !clean.device_token) {
    throw new Error('paired mobile payload invalid');
  }
  const dedupeByName = opts.dedupeByName ?? true;
  const isGenericName = (n?: string | null) => {
    const s = (n ?? '').toLowerCase().trim();
    return !s || s === 'android phone' || s === 'mobile' || s === 'phone' || s === 'unknown';
  };
  data.paired_mobiles = data.paired_mobiles.filter((x) => {
    const sameOwner = (x.owner_user_id ?? null) === owner;
    if (!sameOwner) return true;
    if (x.device_id === clean.device_id) return false;
    if (dedupeByName && !isGenericName(clean.device_name) && x.device_name === clean.device_name) return false;
    return true;
  });
  const id = (data.paired_mobiles.reduce((acc, x) => Math.max(acc, x.id), 0) || 0) + 1;
  const full: PairedMobile = { id, ...clean };
  data.paired_mobiles.push(full);
  save(data);
  return full;
}

/** 同名旧记录多久没连过才算真不用了 */
const STALE_SAME_NAME_MS = 14 * 24 * 3600_000;

export function dedupePairedMobiles(): { before: number; after: number } {
  const data = load();
  const before = data.paired_mobiles.length;
  const now = Date.now();
  /* 1. 同一 device_id 重复: 留 id 最大 */
  const byDevice = new Map<string, PairedMobile>();
  for (const m of data.paired_mobiles) {
    const key = `${m.owner_user_id ?? '<legacy>'}\u0000${m.device_id}`;
    const prev = byDevice.get(key);
    if (!prev || m.id > prev.id) byDevice.set(key, m);
  }
  const unique = [...byDevice.values()];
  /* 2. 同名: 扫码配对 + 久没连 + 有更新的同名 → 才清 */
  const newestByName = new Map<string, number>();
  for (const m of unique) {
    if (!m.device_name) continue;
    const key = `${m.owner_user_id ?? '<legacy>'}\u0000${m.device_name}`;
    newestByName.set(key, Math.max(newestByName.get(key) ?? 0, m.id));
  }
  data.paired_mobiles = unique.filter((m) => {
    if (!m.device_name || m.device_token.startsWith('account:')) return true;
    const newest = newestByName.get(`${m.owner_user_id ?? '<legacy>'}\u0000${m.device_name}`) ?? m.id;
    if (newest === m.id) return true;
    const lastUsed = m.last_seen_at ?? m.paired_at;
    return now - lastUsed < STALE_SAME_NAME_MS;
  }).sort((a, b) => a.id - b.id);
  if (data.paired_mobiles.length !== before) save(data);
  return { before, after: data.paired_mobiles.length };
}

export function removePairedMobile(
  deviceId: string,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): boolean {
  const id = cleanDeviceId(deviceId);
  if (!id) return false;
  const data = load();
  const before = data.paired_mobiles.length;
  data.paired_mobiles = data.paired_mobiles.filter((x) => {
    if (x.device_id !== id) return true;
    return !shouldIncludeForOwner(x, opts);
  });
  if (data.paired_mobiles.length === before) return false;
  save(data);
  return true;
}

/** 改已配对 Mobile 的显示名 — UI 编辑入口. trim + 长度限制 + null 表示清空回默认. */
export function setPairedMobileName(
  deviceId: string,
  name: string | null,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): boolean {
  const id = cleanDeviceId(deviceId);
  if (!id) return false;
  const data = load();
  const m = data.paired_mobiles.find((x) => x.device_id === id && shouldIncludeForOwner(x, opts));
  if (!m) return false;
  m.device_name = cleanDeviceName(name);
  save(data);
  return true;
}

export function touchPairedMobile(
  deviceId: string,
  opts: { currentUserId?: string | null; filter?: 'owned' | 'all' } = {},
): void {
  const id = cleanDeviceId(deviceId);
  if (!id) return;
  const data = load();
  const m = data.paired_mobiles.find((x) => x.device_id === id && shouldIncludeForOwner(x, opts));
  if (!m) return;
  m.last_seen_at = Date.now();
  save(data);
}

export function getLastWsPort(): number | null {
  return load().last_ws_port ?? null;
}

export function saveLastWsPort(port: number): void {
  const data = load();
  if (data.last_ws_port === port) return;
  data.last_ws_port = port;
  save(data);
}

/** 测试用 — 清空 store (危险, 仅 dev/test 调) */
export function _resetDeviceStore(): void {
  const db = getDb();
  try { db?.deleteAppState(DB_KEY); } catch { /* ignore */ }
  try { fs.unlinkSync(legacyStorePath()); } catch { /* ignore */ }
  cache = null;
}
