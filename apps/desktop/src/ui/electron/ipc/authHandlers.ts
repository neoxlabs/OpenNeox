import { lazyElectron } from '../lazyElectron.js';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';
/* ipcMain 走桥的替身: 这个文件也是极简版要用的 (登录 / BYOK 都在这儿)。 */
import { ipcMain } from './ipcMainBridged.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const app = lazyElectron<typeof import('electron').app>('app');
import { authHost } from './authHostBindings.js';
import { promises as fs } from 'fs';
import { openSync, closeSync, writeFileSync, unlinkSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import * as os from 'node:os';
import { oauthFlow, type OAuthLoginResult } from '../services/oauthFlow.js';
import { getDeviceFingerprint } from '../services/deviceFingerprint.js';
import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';
import {
  getDeviceId,
  getDeviceName,
  getDesktopKeypair,
  getSupersededDeviceIds,
  machineFingerprintOrNull,
} from '../mobile-bridge/deviceStore.js';
import { encryptLocalSecret, decryptLocalSecret, isLocalSecretBlob } from '../services/localSecretCipher.js';
import { runLogout } from '../services/logoutBus.js';
import { setCurrentUserId } from '@neoxlabs/platform/utils/config.js';
import { neoxRoutingState } from '../services/neoxRoutingService.js';
import { markAuthSelfBroadcast } from '../services/authFileWatcher.js';
import { setRoutingState, clearRoutingState } from '@neoxlabs/platform/platform/routingState.js';

function setActiveUserId(userId: string | null): void {
  try { setCurrentUserId(userId); } catch { /* ignore */ }
  try { neoxRoutingState.setUserId(userId); } catch { /* ignore */ }
  if (userId) {
    const ep = resolveCloudEndpoints();
    const cleaned = ep.gateway.replace(/\/+$/, '');
    const gatewayBase = cleaned.endsWith('/n1') ? cleaned : cleaned + '/n1';
    setRoutingState({ gatewayBase });
  } else {
    clearRoutingState();
  }
}

/**
 * B 方案 - announce 当前 desktop 的 X25519 pubkey 到 NeoxCloud, 让同账号的 mobile 自动发现.
 *   - access_token 必填 (用 Bearer auth)
 *   - 每次登录 + 启动时各调一次 (idempotent, server ON CONFLICT DO UPDATE)
 */
export async function announceDeviceToCloud(accessToken: string): Promise<void> {
  const ep = resolveCloudEndpoints();
  const kp = getDesktopKeypair();
  const mobileBridgeCaps = await getMobileBridgeAnnounceCapabilities();
  const body = {
    device_id: getDeviceId(),
    device_kind: 'desktop' as const,
    device_name: getDeviceName(),
    pubkey_b64: kp.publicKey.toString('base64'),
    capabilities: {
      platform: process.platform,
      hostname: os.hostname(),
      app_version: app.getVersion(),
      machine_fp: machineFingerprintOrNull() ?? undefined,
      superseded_device_ids: (() => {
        const ids = getSupersededDeviceIds();
        return ids.length > 0 ? ids : undefined;
      })(),
      ...mobileBridgeCaps,
    },
  };
  const resp = await fetch(`${ep.api}/api/v1/devices/announce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`announce ${resp.status}: ${await resp.text()}`);
  }
}


/** 心跳间隔. 服务端 announce 是 idempotent 的 upsert, 这个频率的写入压力可忽略;
 *  取 4 分钟是为了让"最后上报"始终明显新于任何合理的在线判定窗口。 */
const ANNOUNCE_HEARTBEAT_MS = 4 * 60 * 1000;

let announceTimer: ReturnType<typeof setInterval> | null = null;

/** 发一次 announce; 没登录就返回 false, 不当成错误. */
async function announceOnce(): Promise<boolean> {
  try {
    const tok = await ensureFreshDesktopAuthTokens();
    if (!tok?.accessToken) return false;
    await announceDeviceToCloud(tok.accessToken);
    return true;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[devices/announce] heartbeat failed:', e?.message ?? e);
    return false;
  }
}

/**
 * 启动 announce 心跳. 幂等 —— 重复调只保留一个 timer.
 *
 * **必须在登录判断之外调用**: 这个心跳的意义之一就是"启动时没登录, 登录后自愈"。
 * 放进 `if (token)` 里就把它退化回原来那个一次性调用了。
 */
export function startDeviceAnnounceHeartbeat(): void {
  if (announceTimer) return;
  /* 立刻来一发, 不等第一个间隔 —— 启动后手机可能马上就在找这台机器 */
  void announceOnce();
  announceTimer = setInterval(() => {
    void announceOnce();
  }, ANNOUNCE_HEARTBEAT_MS);
  /* unref: 心跳不该拖住进程退出 */
  (announceTimer as any).unref?.();
}

export function stopDeviceAnnounceHeartbeat(): void {
  if (!announceTimer) return;
  clearInterval(announceTimer);
  announceTimer = null;
}

async function getMobileBridgeAnnounceCapabilities(): Promise<Record<string, unknown>> {
  try {
    const bridge = await import('../mobile-bridge/index.js');
    const lanIps = bridge.getAllLanIps();
    const port = bridge.getMobileBridgePort();
    return {
      lan_ip: lanIps[0],
      lan_ips: lanIps,
      lan_port: port > 0 ? port : undefined,
      mobile_bridge_enabled: bridge.getMobileBridgeServer() !== null,
    };
  } catch {
    return {};
  }
}

/* P1-1: native HMAC signer — main 进程只做 sig 计算 (秒级 IPC), 私钥永远不进 renderer.
 *   renderer 算 body sha256 自己来, 因为 body 大小可达 MB, IPC 来回拷贝费 GC. */
type NativeSigner = {
  computeHmacSigV2: (
    ts: string, nonce: string, path: string, bodySha256Hex: string, nxkId: string, deviceFp: string,
  ) => string;
  /** 响应签校验用 — gateway respsign.go 还是老公式发响应签, 客户端验响应完整性专用.
   * (响应方向不需要绑 nxk/设备 — 请求已经过 v2 校验, 响应给的是这个已认证的 client.) */
  computeHmacSig?: (ts: string, nonce: string, path: string, bodySha256Hex: string) => string;
  getSecretVersion: () => string;
};
let nativeSigner: NativeSigner | null = null;
try {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  nativeSigner = require('@neoxlabs/native') as NativeSigner;
} catch {
  nativeSigner = null;
}


interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** access_token 过期时间戳 (ms since epoch) — 用于客户端预 refresh */
  accessExpiresAt: number;
  /** 缓存的用户信息, 启动时直接出 UI 不等网络 */
  user: {
    id: string;
    email: string;
    phone?: string | null;
    displayName?: string;
    avatarUrl?: string;
    emailVerifiedAt?: string | null;
    phoneVerifiedAt?: string | null;
    suspendedAt?: string | null;
    createdAt?: string;
    lastLoginAt?: string | null;
  };
  scopes?: string[];
}

interface AuthSessionStatus {
  loggedIn: boolean;
  user: AuthTokens['user'] | null;
  accessExpiresAt: number | null;
  scopes?: string[];
}

interface AuthProxyResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyBase64: string;
}

type AuthProxyResult =
  | { ok: true; response: AuthProxyResponse }
  /** retryAfterMs: 调用方最少该等多久再试 —— 没有它, renderer 只能立刻重试, 一旦失败持续存在就是热转 */
  | { ok: false; code: string; message: string; status?: number; retryAfterMs?: number };

type AuthProxyBody =
  | { kind: 'text'; text: string }
  | { kind: 'base64'; dataBase64: string; contentType?: string }
  | {
      kind: 'formData';
      entries: Array<
        | { kind: 'field'; name: string; value: string }
        | { kind: 'file'; name: string; fileName: string; contentType?: string; dataBase64: string }
      >;
    };

type AuthProxyFetchBody = string | Blob | FormData;

interface AuthProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AuthProxyBody;
  timeoutMs?: number;
}

type AuthCompleteLoginResult =
  | { ok: true; session: AuthSessionStatus }
  | { ok: false; response: AuthProxyResponse };

export function tokenDirPath(): string {
  if (String(process.env.NEOX_EDITION || '').trim().toLowerCase() === 'lite') {
    return neoxHome();
  }
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', DISTRIBUTION.appName);
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), DISTRIBUTION.appName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
  return join(xdgConfig, 'neox');
}
export const tokenFilePath = () => join(tokenDirPath(), 'auth.enc');

/* 兼容旧路径 — 历史用户曾经把 auth.enc 写到 app.getPath('userData') 的 Electron/ 目录,
 *  启动时如果新路径没有但旧路径有, 自动迁移过去, 不让用户重新登录. */
async function migrateLegacyAuthEncIfNeeded(): Promise<void> {
  try {
    const newPath = tokenFilePath();
    const newStat = await fs.stat(newPath).catch(() => null);
    if (newStat) return; /* 新路径已有, 不动 */
    /* 旧路径兼容: 历史用户曾把 auth.enc 写在宿主的 userData 下。
     * 非 Electron 宿主没有这个概念 → 跳过这段兼容 (那些宿主根本不存在旧路径)。 */
    const legacyDir = authHost().legacyUserDataDir();
    if (!legacyDir) return;
    const legacyPath = join(legacyDir, 'auth.enc');
    if (legacyPath === newPath) return; /* 两路径相同, 不需要迁移 */
    const legacyStat = await fs.stat(legacyPath).catch(() => null);
    if (!legacyStat) return; /* 旧路径也没有, 用户从未登录 / 已 logout */
    /* 确保目标目录存在 */
    await fs.mkdir(tokenDirPath(), { recursive: true }).catch(() => {});
    const buf = await fs.readFile(legacyPath);
    await fs.writeFile(newPath, buf, { mode: 0o600 });
    /* 迁移成功后删旧路径, 防下次启动重复迁移. */
    await fs.unlink(legacyPath).catch(() => {});
    console.warn('[authHandlers] migrated legacy auth.enc:', legacyPath, '→', newPath);
  } catch (err: any) {
    console.warn('[authHandlers] legacy auth.enc migration failed:', err?.message ?? err);
  }
}

/* 暴露给同 main 进程其它模块 (mobile-bridge 云中转) 复用 — 单一登录 (SSO 风格):
 * 用户登录 Neox 后, 云中转直接拿这套 token, 不再要求二次登录. */
export async function readDesktopAuthTokens(): Promise<AuthTokens | null> {
  return readTokens();
}

const REFRESH_LOCK_FILE = () => join(tokenDirPath(), 'auth.refresh.lock');
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_STALE_THRESHOLD_MS = 30_000;

let heldLockContent: string | null = null;

function acquireRefreshLock(): boolean {
  try {
    const fd = openSync(REFRESH_LOCK_FILE(), 'wx'); /* exclusive create */
    const content = `${process.pid}\n${new Date().toISOString()}\n${Math.random().toString(36).slice(2)}\n`;
    writeFileSync(fd, content);
    closeSync(fd);
    heldLockContent = content;
    return true;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}
function releaseRefreshLock(): void {
  const mine = heldLockContent;
  heldLockContent = null;
  if (!mine) return;
  try {
    if (readFileSync(REFRESH_LOCK_FILE(), 'utf8') === mine) unlinkSync(REFRESH_LOCK_FILE());
  } catch { /* 不存在 / 已被别人接管: 不是我的锁, 不动 */ }
}
async function waitForRefreshLock(): Promise<boolean> {
  const lockPath = REFRESH_LOCK_FILE();
  const start = Date.now();
  while (Date.now() - start < LOCK_WAIT_TIMEOUT_MS) {
    if (!existsSync(lockPath)) return true;
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_THRESHOLD_MS) {
        try { unlinkSync(lockPath); } catch { /* race ok */ }
        return true;
      }
    } catch { return true; /* race: lock 刚被删 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const REFRESH_FAILURE_COUNTER = new Map<string, { count: number; cooldownUntil: number }>();
const REFRESH_COOLDOWN_MS = 60_000;
const REFRESH_MAX_CONSECUTIVE_FAILURES = 3;

export interface RefreshOutcome {
  tokens: AuthTokens | null;
  /** true = 服务端明确拒绝了 refresh token (401/invalid_grant) → 会话真的结束了 */
  fatal: boolean;
  degraded: boolean;
}

/** 最近一次 rotate 成功的时刻 —— 防「轮换风暴自撞」用, 见 fetchWithMainAuth 的 401 分支。 */
let LAST_ROTATE_OK_AT = 0;
/** 风暴窗口: 这么短的时间内刚转过一次, 那 401 几乎必然是"我手上那张是旧的", 不是会话死了。 */
const ROTATE_STORM_WINDOW_MS = 15_000;

const ROTATE_STORM_MAX_CONSECUTIVE = 5;
const ROTATE_STORM_BACKOFF_MS = 30_000;
let ROTATE_STORM_HITS = 0;

export async function ensureFreshDesktopAuthTokens(opts: { force?: boolean } = {}): Promise<AuthTokens | null> {
  return (await ensureFreshDesktopAuthTokensEx(opts)).tokens;
}

let INFLIGHT_REFRESH: { key: string; promise: Promise<RefreshOutcome> } | null = null;

export async function ensureFreshDesktopAuthTokensEx(
  opts: { force?: boolean; staleAccessToken?: string } = {},
): Promise<RefreshOutcome> {
  const pre = await readTokens();
  /* 已经有人在为同一张 refresh token 转了 → 直接搭它的车, 不自己再发一次 */
  if (pre?.refreshToken && INFLIGHT_REFRESH?.key === pre.refreshToken) {
    return INFLIGHT_REFRESH.promise;
  }
  const key = pre?.refreshToken ?? '';
  const promise = ensureFreshDesktopAuthTokensInner(opts).finally(() => {
    if (INFLIGHT_REFRESH?.key === key) INFLIGHT_REFRESH = null;
  });
  if (key) INFLIGHT_REFRESH = { key, promise };
  return promise;
}

async function ensureFreshDesktopAuthTokensInner(
  opts: { force?: boolean; staleAccessToken?: string } = {},
): Promise<RefreshOutcome> {
  const cur = await readTokens();
  if (!cur?.accessToken || !cur?.refreshToken) return { tokens: cur, fatal: false, degraded: false };

  if (opts.force && opts.staleAccessToken && cur.accessToken !== opts.staleAccessToken) {
    return { tokens: cur, fatal: false, degraded: false };
  }

  /* hot-loop cooldown gate — 同一 refreshToken 短期内多次失败直接 short-circuit */
  const counterKey = cur.refreshToken.slice(0, 32);
  const counterState = REFRESH_FAILURE_COUNTER.get(counterKey);
  if (counterState && Date.now() < counterState.cooldownUntil) {
    /* 不打日志 (本来就是为了防刷屏)。degraded —— 调用方不能把随之而来的 401 当成"会话过期"。 */
    return { tokens: cur, fatal: false, degraded: true };
  }

  const remaining = cur.accessExpiresAt - Date.now();
  /* 提前量 (clock skew / 网络往返余量)。业界通行是 5-10 分钟, 不是 60 秒:
   *   · Google / AWS SDK 一类: 用之前先看剩余寿命, 进入 skew 窗口就先换
   *   · MSAL / Azure Identity: 更激进, 到半衰期或到期前 ~10 分钟后台就换
   *   60 秒余量的问题: access TTL 才 15 分钟, 一个在 T-59s 出发、往返稍慢的请求落地时 token
   *   已经过期 → 401 → 强制 refresh。于是每 15 分钟必然制造一次"到期惊群"(线上实证)。
   *   放宽到 5 分钟后, 换 token 发生在没人撞车的安静期, 一次换完大家都用新的。 */
  const REFRESH_SKEW_MS = 5 * 60_000;
  if (!opts.force && remaining > REFRESH_SKEW_MS) return { tokens: cur, fatal: false, degraded: false };
  /* force 但没说"我手上哪张被拒了" (启动期预热那类主动调用): token 还很新就别转 —
   * 每多转一代就多一次让别的在途请求踩空的机会, 见上面轮换风暴的注释。 */
  if (opts.force && !opts.staleAccessToken && remaining > 10 * 60_000) {
    return { tokens: cur, fatal: false, degraded: false };
  }

  if (!acquireRefreshLock()) {
    const got = await waitForRefreshLock();
    if (got) {
      const refreshed = await readTokens();
      return { tokens: refreshed || cur, fatal: false, degraded: !refreshed };
    }
    /* timeout — fall through 自己刷 (强夺锁责任) */
  }

  try {
    const ep = resolveCloudEndpoints();
    const url = `${ep.api}/api/v1/auth/refresh`;
    const refreshHeaders: Record<string, string> = { 'content-type': 'application/json' };
    try {
      const fp = getDeviceFingerprint();
      if (fp?.fpHash) refreshHeaders['X-Device-FP'] = fp.fpHash;
      const machineId = fp?.fpBlob?.machineId;
      if (machineId) refreshHeaders['X-Machine-Id'] = String(machineId);
    } catch (err) {
      /* 指纹算不出来不该挡住 refresh 本身 (那会直接把用户踢下线), 但要留痕 */
      console.warn('[authHandlers] refresh 取设备指纹失败, 本次不带 fp header:', (err as any)?.message ?? err);
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: refreshHeaders,
      body: JSON.stringify({ refreshToken: cur.refreshToken, clientId: 'neox-desktop' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      /* 跨运行时竞态兜底: sibling 可能抢先 rotate 并写了新 token → 重读, 变了就用新的, 别误报过期 */
      const reread = await readTokens();
      if (reread?.refreshToken && reread.refreshToken !== cur.refreshToken) {
        /* sibling 真的转好了 — 清失败计数 */
        REFRESH_FAILURE_COUNTER.delete(counterKey);
        return { tokens: reread, fatal: false, degraded: false };
      }
      /* 真失败 — 累计计数; 超阈值进 cooldown 不再 hot retry */
      const prior = REFRESH_FAILURE_COUNTER.get(counterKey) ?? { count: 0, cooldownUntil: 0 };
      const next = { count: prior.count + 1, cooldownUntil: 0 };
      if (next.count >= REFRESH_MAX_CONSECUTIVE_FAILURES) {
        next.cooldownUntil = Date.now() + REFRESH_COOLDOWN_MS;
        console.warn(`[authHandlers] refresh failed ${next.count}× HTTP ${resp.status} — cooldown 60s 避免 hot loop`);
      } else {
        console.warn(`[authHandlers] refresh failed: HTTP ${resp.status} (${next.count}/${REFRESH_MAX_CONSECUTIVE_FAILURES})`);
      }
      REFRESH_FAILURE_COUNTER.set(counterKey, next);
      return { tokens: cur, fatal: resp.status === 401, degraded: resp.status !== 401 };
    }
    /* 成功 — 清失败计数 + 记风暴窗口时刻 */
    REFRESH_FAILURE_COUNTER.delete(counterKey);
    LAST_ROTATE_OK_AT = Date.now();
    const j: any = await readJsonResponseLimited(resp).catch(() => null);
    const tokens = j?.tokens;
    if (!tokens?.accessToken) return { tokens: cur, fatal: false, degraded: true };
    const next: AuthTokens = {
      ...cur,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? cur.refreshToken,
      /* control-plane 默认 1h, 没回字段就保守按 50min 推断 */
      accessExpiresAt: typeof tokens.expiresIn === 'number'
        ? Date.now() + tokens.expiresIn * 1000
        : Date.now() + 50 * 60 * 1000,
    };
    await writeTokens(next);
    return { tokens: next, fatal: false, degraded: false };
  } catch (err) {
    const reread = await readTokens();
    if (reread?.refreshToken && reread.refreshToken !== cur.refreshToken) {
      return { tokens: reread, fatal: false, degraded: false };
    }
    console.warn('[authHandlers] refresh exception:', err);
    /* 异常 = 网络层没通, 绝不是"会话过期" */
    return { tokens: cur, fatal: false, degraded: true };
  } finally {
    releaseRefreshLock();
  }
}

/** 启动快路径 — 只做本地身份恢复 (读+解密 auth.enc → setActiveUserId), 不碰网络。
 * token 网络刷新由调用方在后台跑 ensureFreshDesktopAuthTokens, 不挡建窗。 */
export async function restoreAuthIdentity(): Promise<AuthTokens | null> {
  return readTokens();
}

async function readTokens(): Promise<AuthTokens | null> {
  /* 进 readTokens 前先迁移旧路径 (Electron/ → Neox/), 兼容历史用户. */
  await migrateLegacyAuthEncIfNeeded();
  try {
    const buf = await fs.readFile(tokenFilePath());

    /* 新格式 (NXS1) — localSecretCipher 自加密. */
    if (isLocalSecretBlob(buf)) {
      let plaintext: string;
      try {
        plaintext = decryptLocalSecret(buf);
      } catch (decryptErr: any) {
        /* 解密失败 ≠ 未登录。可能是 machine-id 暂时读取异常（ioreg 超时等）。
           重试一次，仍然失败则打明确日志但不删 auth.enc（下次启动可能恢复）。 */
        console.warn('[authHandlers] decrypt failed, retrying once:', decryptErr?.message);
        try {
          plaintext = decryptLocalSecret(buf);
        } catch (retryErr: any) {
          console.error('[authHandlers] decrypt retry also failed — auth.enc preserved, user will appear logged out this session:', retryErr?.message);
          return null;
        }
      }
      const tokens = JSON.parse(plaintext) as AuthTokens;
      setActiveUserId(tokens?.user?.id ?? null);
      return tokens;
    }

    /* 历史 plaintext JSON — 老 Linux 无 keyring 用户. 升级到新 cipher 后返回. */
    const utf = buf.toString('utf-8');
    if (utf.trim().startsWith('{')) {
      const parsed = JSON.parse(utf) as AuthTokens;
      /* 迁移改写也是本进程动 auth.enc — 同样要自我标记, 否则启动时就自己广播一次"外部登录" */
      markAuthSelfBroadcast();
      try { await fs.writeFile(tokenFilePath(), encryptLocalSecret(utf), { mode: 0o600 }); } catch { /* ignore */ }
      markAuthSelfBroadcast();
      setActiveUserId(parsed?.user?.id ?? null);
      return parsed;
    }

    /* 老 safeStorage 加密的 auth.enc — 不再尝试 safeStorage.decryptString (会触发 macOS
     * Keychain 密码框, 商用产品体验上不可接受). 直接当作丢失 → 删除文件, 用户重新登录一次,
     * 此后所有读写都走 NXS1, 永远不会再触发系统密码框. */
    console.warn('[authHandlers] token file in legacy safeStorage format — discarding (user will re-login).');
    markAuthSelfBroadcast();
    try { await fs.unlink(tokenFilePath()); } catch { /* ignore */ }
    markAuthSelfBroadcast();
    return null;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    console.error('[authHandlers] readTokens failed (auth.enc preserved):', err?.message ?? err);
    return null;
  }
}

/** 已废弃 — 旧 safeStorage 模式的可用性查询. 新方案永远可用, 保留 export 返 true 兜底. */
export function getAuthStorageStatus(): { available: boolean; checked: boolean } {
  return { available: true, checked: true };
}

/** 已废弃 — 旧 safeStorage 不可用时的启动 dialog. 新方案不依赖 Keychain, 无需 dialog. */
export async function ensureAuthStorageReady(): Promise<void> {
  /* no-op */
}

async function writeTokens(tokens: AuthTokens): Promise<void> {
  const newUid = tokens?.user?.id ?? null;

  const json = JSON.stringify(tokens);
  const bytes = encryptLocalSecret(json);
  /* 确保目录存在 — 新路径 ~/Library/Application Support/Neox/ 首次可能不存在
   *  (尤其全新机器或 dev 启动). 不创建会让 writeFile 抛 ENOENT, 整个登录 IPC reject. */
  await fs.mkdir(tokenDirPath(), { recursive: true }).catch(() => {});
  markAuthSelfBroadcast();
  const tmpPath = `${tokenFilePath()}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, bytes, { mode: 0o600 });
  await fs.rename(tmpPath, tokenFilePath());
  markAuthSelfBroadcast();
  setActiveUserId(newUid);

  try {
    const { notifyPresenceReauthenticated } = await import('../mobile-bridge/index.js');
    notifyPresenceReauthenticated(tokens?.accessToken);
  } catch { /* bridge 没起来 (纯 Node 宿主 / 还没 whenReady) — 下次启动自然会连 */ }
  void (async () => {
    try {
      const { ensureCloudRelayClientRunning } = await import('../mobile-bridge/index.js');
      await ensureCloudRelayClientRunning();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!msg.includes('mobile-bridge not started')) {
        console.warn('[auth] ensure cloud relay after token write failed:', msg);
      }
    }
  })();
}

async function clearTokens(): Promise<void> {
  let lastErr: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      /* 跟 writeTokens 同理: 删也是"本进程动了 auth.enc", 必须自我标记,
       * 否则 fs.watch 会把自己的登出当成"外部登出"再广播一轮。 */
      markAuthSelfBroadcast();
      await fs.unlink(tokenFilePath());
      markAuthSelfBroadcast();
      lastErr = null;
      break;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        lastErr = null;
        break; /* 文件本就不在, 视为成功 */
      }
      lastErr = err;
      if (i < 2) {
        await new Promise(r => setTimeout(r, 100 * (i + 1))); /* 100ms / 200ms 短退避 */
      }
    }
  }
  /* 切回匿名登录态 + 通知 server. 即使 unlink 仍失败也要切, 防止 server 还以为用户登录中. */
  setActiveUserId(null);
  if (lastErr) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error('[authHandlers] clearTokens persisted failure after 3 retries:', msg);
    throw new Error(`auth:clear-tokens failed: ${msg}`);
  }
}

function makeSessionStatus(tokens: AuthTokens | null): AuthSessionStatus {
  return {
    loggedIn: !!tokens?.accessToken,
    user: tokens?.user ?? null,
    accessExpiresAt: tokens?.accessExpiresAt ?? null,
    scopes: tokens?.scopes,
  };
}

async function broadcastAuthChanged(payload: Record<string, unknown>, excludeWebContentsId?: number): Promise<void> {
  /* 走宿主注入点而不是直接 import electron —— 这样同一份 auth 逻辑在
   * Electron 和 Tauri(Node 后端) 两个宿主下都能跑, 不用维护第二份实现。
   * 见 authHostBindings.ts 文件头。 */
  try {
    await authHost().broadcastAuthChanged(payload, excludeWebContentsId);
  } catch (e: any) {
    console.warn('[authHandlers] broadcast auth:changed failed:', e?.message ?? e);
  }
}

async function broadcastAuthLogin(prevUserId: string | null, nextUserId: string | null, excludeWebContentsId?: number): Promise<void> {
  await broadcastAuthChanged({
    type: prevUserId === nextUserId ? 'token-refresh' : 'login',
    userId: nextUserId,
  }, excludeWebContentsId);
}

async function clearAuthStateAndBroadcast(previousUserId: string | null): Promise<void> {
  await runLogout({ previousUserId });
  await clearTokens();
  markAuthSelfBroadcast();
  await broadcastAuthChanged({ type: 'logout', previousUserId });
}

function authJsonProxyResponse(status: number, payload: unknown, statusText = 'Error'): AuthProxyResponse {
  const body = JSON.stringify(payload);
  return {
    status,
    statusText,
    headers: [['content-type', 'application/json; charset=utf-8']],
    bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
  };
}

const AUTH_PROXY_MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const AUTH_PROXY_MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const AUTH_PROXY_MAX_HEADER_COUNT = 64;
const AUTH_PROXY_MAX_HEADER_NAME_BYTES = 128;
const AUTH_PROXY_MAX_HEADER_VALUE_BYTES = 8 * 1024;
const AUTH_PROXY_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

class AuthProxyPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProxyPayloadTooLargeError';
  }
}

function authProxyTooLargeResponse(message: string): AuthProxyResponse {
  return authJsonProxyResponse(502, {
    error: 'AUTH_PROXY_RESPONSE_TOO_LARGE',
    message,
  }, 'Bad Gateway');
}

function sanitizeResponseHeadersForRenderer(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of headers.entries()) {
    if (out.length >= AUTH_PROXY_MAX_HEADER_COUNT) break;
    const name = String(rawName).trim().toLowerCase();
    if (!name || name === 'set-cookie' || name === 'set-cookie2') continue;
    if (Buffer.byteLength(name, 'utf8') > AUTH_PROXY_MAX_HEADER_NAME_BYTES) continue;
    if (!AUTH_PROXY_HEADER_NAME_RE.test(name)) continue;
    const value = String(rawValue ?? '');
    if (Buffer.byteLength(value, 'utf8') > AUTH_PROXY_MAX_HEADER_VALUE_BYTES) continue;
    if (/[\r\n\u0000]/.test(value)) continue;
    out.push([name, value]);
  }
  return out;
}

async function readResponseBytesLimited(resp: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AuthProxyPayloadTooLargeError('认证代理响应过大');
  }

  if (!resp.body) return Buffer.alloc(0);

  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new AuthProxyPayloadTooLargeError('认证代理响应过大');
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks, total);
}

async function readJsonResponseLimited(resp: Response): Promise<unknown> {
  const bytes = await readResponseBytesLimited(resp, AUTH_PROXY_MAX_JSON_RESPONSE_BYTES);
  if (!bytes.length) return null;
  return JSON.parse(bytes.toString('utf8'));
}

async function serializeResponse(resp: Response): Promise<AuthProxyResponse> {
  try {
    const bytes = await readResponseBytesLimited(resp, AUTH_PROXY_MAX_RESPONSE_BYTES);
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: sanitizeResponseHeadersForRenderer(resp.headers),
      bodyBase64: bytes.toString('base64'),
    };
  } catch (err) {
    if (err instanceof AuthProxyPayloadTooLargeError) {
      return authProxyTooLargeResponse(err.message);
    }
    throw err;
  }
}

function classifyFetchError(err: unknown, url?: string): { code: string; message: string; status: number; detail: unknown } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = String(raw).toLowerCase();
  const name = err instanceof Error ? err.name : '';
  let code = 'NETWORK_FAILED';
  let message = '网络请求失败,请检查网络后重试';
  /* Timeout 必须先于 abort: 主进程 setTimeout → controller.abort() 抛的也是 AbortError,
   * 但 message/超时文案里常带 timeout; 误标 ABORTED 会导致 renderer withRetry 不重试. */
  if (
    name === 'TimeoutError'
    || lower.includes('timeout') || lower.includes('etimedout')
  ) {
    code = 'NETWORK_TIMEOUT';
    message = '请求超时,请检查网络或稍后重试';
  } else if (name === 'AbortError' || lower.includes('aborted') || lower.includes('abort')) {
    code = 'NETWORK_ABORTED';
    message = '请求已取消';
  } else if (lower.includes('dns') || lower.includes('enotfound') || lower.includes('eai_again')) {
    code = 'NETWORK_DNS';
    message = '无法解析服务器地址,可能是 DNS 异常或被网络拦截';
  } else if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls') || lower.includes('cert_')) {
    code = 'NETWORK_TLS';
    message = '安全连接失败,可能是网络证书被篡改或系统时间不正确';
  } else if (lower.includes('failed to fetch') || lower.includes('load failed') || lower.includes('networkerror')) {
    code = 'NETWORK_FAILED';
    message = '网络连接失败,请检查网络是否通畅或服务是否可达';
  }
  return { code, message, status: 0, detail: { rawMessage: raw, url } };
}

function isWithinBasePath(targetPath: string, basePath: string): boolean {
  const base = String(basePath || '/').replace(/\/+$/, '');
  if (!base || base === '') return true;
  return targetPath === base || targetPath.startsWith(`${base}/`);
}

function resolveAuthProxyUrl(input: string): URL {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('认证请求 URL 为空');
  if (trimmed.startsWith('//')) throw new Error('认证请求不允许 protocol-relative URL');

  const ep = resolveCloudEndpoints();
  const apiBase = ep.api.replace(/\/+$/, '');
  const baseUrl = new URL(apiBase);

  if (/^https?:\/\//i.test(trimmed)) {
    const target = new URL(trimmed);
    if (target.origin !== baseUrl.origin || !isWithinBasePath(target.pathname, baseUrl.pathname)) {
      throw new Error('认证请求只能发送到 Neox API 域名');
    }
    return target;
  }

  if (!trimmed.startsWith('/')) {
    throw new Error('认证请求必须使用 / 开头的 API path');
  }
  return new URL(`${apiBase}${trimmed}`);
}

function sanitizeProxyHeaders(raw: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return headers;
  const blocked = new Set([
    'authorization',
    'cookie',
    'host',
    'origin',
    'referer',
    'connection',
    'content-length',
    'x-device-fp',
    'x-sig',
    'x-sig-ts',
    'x-sig-nonce',
    'x-client-version',
  ]);
  let accepted = 0;
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).trim().toLowerCase();
    if (!name || blocked.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue;
    if (!AUTH_PROXY_HEADER_NAME_RE.test(name) || Buffer.byteLength(name, 'utf8') > AUTH_PROXY_MAX_HEADER_NAME_BYTES) {
      throw new Error('认证请求包含非法 header');
    }
    const value = String(v ?? '');
    if (Buffer.byteLength(value, 'utf8') > AUTH_PROXY_MAX_HEADER_VALUE_BYTES || /[\r\n\u0000]/.test(value)) {
      throw new Error('认证请求 header 过长或格式非法');
    }
    accepted += 1;
    if (accepted > AUTH_PROXY_MAX_HEADER_COUNT) {
      throw new Error('认证请求 header 过多');
    }
    headers.set(name, value);
  }
  return headers;
}

const AUTH_PROXY_MAX_BODY_BYTES = 30 * 1024 * 1024;
const AUTH_PROXY_MAX_FILE_BYTES = 25 * 1024 * 1024;
const AUTH_PROXY_MAX_FORM_ENTRIES = 128;
const AUTH_PROXY_MAX_FORM_NAME_BYTES = 256;
const AUTH_PROXY_MAX_FILE_NAME_BYTES = 512;
const AUTH_PROXY_MAX_CONTENT_TYPE_BYTES = 128;

function base64DecodedLength(dataBase64: string): number {
  const trimmed = dataBase64.trim();
  if (!trimmed) return 0;
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.floor(trimmed.length * 3 / 4) - padding;
}

function appendBodySize(total: { bytes: number }, nextBytes: number, fileName?: string): void {
  if (fileName && nextBytes > AUTH_PROXY_MAX_FILE_BYTES) {
    throw new Error(`上传文件过大: ${fileName}`);
  }
  total.bytes += nextBytes;
  if (total.bytes > AUTH_PROXY_MAX_BODY_BYTES) {
    throw new Error('请求体过大');
  }
}

function assertProxyString(value: unknown, label: string, maxBytes: number, opts: { allowEmpty?: boolean; noControls?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new Error(`${label}格式非法`);
  }
  if (opts.allowEmpty === false && value.length === 0) {
    throw new Error(`${label}不能为空`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label}过长`);
  }
  if (opts.noControls && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}格式非法`);
  }
  return value;
}

function normalizeBase64Payload(value: unknown, label: string): string {
  const maxBase64Bytes = Math.ceil(AUTH_PROXY_MAX_BODY_BYTES * 4 / 3) + 8;
  const text = assertProxyString(value, label, maxBase64Bytes).trim();
  if (text.length === 0) return '';
  if (text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error(`${label}格式非法`);
  }
  return text;
}

function normalizeOptionalContentType(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  return assertProxyString(value, 'Content-Type', AUTH_PROXY_MAX_CONTENT_TYPE_BYTES, { noControls: true });
}

async function buildProxyBody(body: AuthProxyBody | undefined, headers: Headers): Promise<AuthProxyFetchBody | undefined> {
  if (!body) return undefined;
  if (typeof body !== 'object') throw new Error('请求体格式非法');
  const size = { bytes: 0 };
  if (body.kind === 'text') {
    const text = assertProxyString(body.text, '请求体', AUTH_PROXY_MAX_BODY_BYTES);
    const bytes = Buffer.byteLength(text, 'utf8');
    appendBodySize(size, bytes);
    return text;
  }
  if (body.kind === 'base64') {
    const dataBase64 = normalizeBase64Payload(body.dataBase64, '请求体');
    const contentType = normalizeOptionalContentType(body.contentType);
    const bytes = base64DecodedLength(dataBase64);
    appendBodySize(size, bytes);
    if (contentType && !headers.has('content-type')) {
      headers.set('content-type', contentType);
    }
    const buf = Buffer.from(dataBase64, 'base64');
    return new Blob([new Uint8Array(buf)], { type: contentType || 'application/octet-stream' });
  }
  if (body.kind !== 'formData' || !Array.isArray(body.entries)) {
    throw new Error('请求体格式非法');
  }
  if (body.entries.length > AUTH_PROXY_MAX_FORM_ENTRIES) {
    throw new Error('表单字段过多');
  }
  const form = new FormData();
  for (const entry of body.entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('表单字段格式非法');
    }
    if (entry.kind === 'field') {
      const name = assertProxyString(entry.name, '表单字段名', AUTH_PROXY_MAX_FORM_NAME_BYTES, { allowEmpty: false, noControls: true });
      const value = assertProxyString(entry.value, '表单字段值', AUTH_PROXY_MAX_BODY_BYTES);
      appendBodySize(size, Buffer.byteLength(value, 'utf8'));
      form.append(name, value);
    } else if (entry.kind === 'file') {
      const name = assertProxyString(entry.name, '表单字段名', AUTH_PROXY_MAX_FORM_NAME_BYTES, { allowEmpty: false, noControls: true });
      const fileName = assertProxyString(entry.fileName, '文件名', AUTH_PROXY_MAX_FILE_NAME_BYTES, { allowEmpty: false, noControls: true });
      const dataBase64 = normalizeBase64Payload(entry.dataBase64, '文件内容');
      const contentType = normalizeOptionalContentType(entry.contentType);
      const bytes = base64DecodedLength(dataBase64);
      appendBodySize(size, bytes, fileName);
      const buf = Buffer.from(dataBase64, 'base64');
      form.append(name, new Blob([new Uint8Array(buf)], { type: contentType || 'application/octet-stream' }), fileName);
    } else {
      throw new Error('表单字段格式非法');
    }
  }
  return form;
}

function shouldSignProxyPath(path: string): boolean {
  return path === '/n1/chat/completions'
    || path === '/n1/responses'
    || path === '/n1/embeddings';
}

function bodySha256HexForProxy(body: AuthProxyBody | undefined): string {
  if (!body) return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  if (typeof body !== 'object') throw new Error('请求体格式非法');
  if (body.kind === 'text') {
    const text = assertProxyString(body.text, '请求体', AUTH_PROXY_MAX_BODY_BYTES);
    return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  }
  if (body.kind === 'base64') {
    const dataBase64 = normalizeBase64Payload(body.dataBase64, '请求体');
    return createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex');
  }
  return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
}

async function fetchWithMainAuth(req: AuthProxyRequest): Promise<AuthProxyResult> {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { ok: false, code: 'INVALID_METHOD', message: '不支持的认证请求方法', status: 400 };
  }

  let url: URL;
  try {
    url = resolveAuthProxyUrl(req.url);
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_URL_FORBIDDEN',
      message: err instanceof Error ? err.message : '认证请求 URL 无效',
      status: 400,
    };
  }

  const tokens = await ensureFreshDesktopAuthTokens();
  if (!tokens?.accessToken) {
    return { ok: false, code: 'NOT_AUTHENTICATED', message: '未登录, 无法发起认证请求', status: 401 };
  }

  const run = async (accessToken: string): Promise<Response> => {
    const headers = sanitizeProxyHeaders(req.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    const fp = await getDeviceFingerprint();
    if (fp?.fpHash) headers.set('X-Device-FP', fp.fpHash);
    const machineId = fp?.fpBlob?.machineId;
    if (machineId) headers.set('X-Machine-Id', String(machineId));
    if (nativeSigner && shouldSignProxyPath(url.pathname)) {
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(8).toString('hex');
      const bodyHash = bodySha256HexForProxy(req.body);
      const nxkId = createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
      const deviceFp = fp?.fpHash ?? '';
      headers.set('X-Sig-Ts', ts);
      headers.set('X-Sig-Nonce', nonce);
      headers.set('X-Sig', nativeSigner.computeHmacSigV2(ts, nonce, url.pathname, bodyHash, nxkId, deviceFp));
      headers.set('X-Sig-Proto', '2');
      headers.set('X-Client-Version', nativeSigner.getSecretVersion());
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1_000, Math.min(req.timeoutMs ?? 120_000, 300_000));
    const timeout = setTimeout(() => {
      try {
        controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
      } catch {
        controller.abort(`Request timed out after ${timeoutMs}ms`);
      }
    }, timeoutMs);
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await buildProxyBody(req.body, headers);
      return await fetch(url.toString(), { method, headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let response = await run(tokens.accessToken);
    if (response.status === 401) {
      const outcome = await ensureFreshDesktopAuthTokensEx({ force: true, staleAccessToken: tokens.accessToken });
      if (outcome.tokens?.accessToken && outcome.tokens.accessToken !== tokens.accessToken) {
        response = await run(outcome.tokens.accessToken);
      }
      if (response.status === 401) {
        if (outcome.degraded && !outcome.fatal) {
          console.warn('[authHandlers] 401 但刷新未成功 (限流/网络/cooldown) — 保留会话, 让调用方重试');
          return {
            ok: false,
            code: 'AUTH_REFRESH_UNAVAILABLE',
            message: '暂时无法刷新登录状态, 请稍后重试',
            status: 503,
          };
        }
        /* 刚刚才成功转过一次 → 这个 401 是轮换风暴里落后的那一枪 (服务端对已 rotate 的旧 token
         * 一律回 401 'Invalid refresh token', 跟真过期长得一模一样)。不许据此清账, 让调用方重试。 */
        if (Date.now() - LAST_ROTATE_OK_AT < ROTATE_STORM_WINDOW_MS) {
          ROTATE_STORM_HITS++;
          if (ROTATE_STORM_HITS > ROTATE_STORM_MAX_CONSECUTIVE) {
            /* 轮换一直成功、业务一直 401 —— 这不是竞态。别再让调用方热转了。 */
            console.error(
              `[authHandlers] 轮换成功但业务接口连续 ${ROTATE_STORM_HITS} 次 401 —— 这不是轮换竞态。`
              + ` 请排查服务端签名密钥/audience (${url.pathname})。退避 ${ROTATE_STORM_BACKOFF_MS}ms, 会话保留不清账。`,
            );
            return {
              ok: false,
              code: 'AUTH_REFRESH_UNAVAILABLE',
              message: '登录状态校验持续失败, 请稍后再试',
              status: 503,
              retryAfterMs: ROTATE_STORM_BACKOFF_MS,
            };
          }
          console.warn(`[authHandlers] 401 但刚轮换成功过 — 判为轮换竞态, 保留会话让调用方重试 (${ROTATE_STORM_HITS}/${ROTATE_STORM_MAX_CONSECUTIVE})`);
          return {
            ok: false,
            code: 'AUTH_REFRESH_UNAVAILABLE',
            message: '登录状态正在刷新, 请稍后重试',
            status: 503,
            retryAfterMs: 1_000,
          };
        }
        /* 铁律: **只有 /auth/refresh 明确拒绝了 refresh token (outcome.fatal) 才允许清账**。
         * 业务接口自己回 401 (权限/scope/端点问题) 不代表会话死了, 删凭据是不可逆的破坏性动作。 */
        if (!outcome.fatal) {
          console.warn('[authHandlers] 业务接口 401 但 refresh 没被拒 — 不清账, 交给调用方重试');
          return {
            ok: false,
            code: 'AUTH_REFRESH_UNAVAILABLE',
            message: '登录状态校验失败, 请稍后重试',
            status: 503,
          };
        }
        await clearAuthStateAndBroadcast(tokens.user?.id ?? null).catch((err: any) => {
          console.warn('[authHandlers] clear after 401 failed:', err?.message ?? err);
        });
      }
    }
    if (response.status !== 401) ROTATE_STORM_HITS = 0;
    return { ok: true, response: await serializeResponse(response) };
  } catch (err) {
    const classified = classifyFetchError(err, url.toString());
    return { ok: false, code: classified.code, message: classified.message, status: classified.status };
  }
}

const COMPLETE_LOGIN_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/login/code/confirm',
  '/api/v1/auth/register',
  '/api/v1/auth/register/code/confirm',
  '/api/v1/auth/sms/code/confirm',
]);

async function completeLoginInMain(eventSenderId: number, req: AuthProxyRequest): Promise<AuthCompleteLoginResult> {
  const method = String(req.method || 'POST').toUpperCase();
  if (method !== 'POST') {
    return { ok: false, response: authJsonProxyResponse(405, { error: 'INVALID_METHOD', message: '登录请求必须使用 POST' }, 'Method Not Allowed') };
  }
  let url: URL;
  try {
    url = resolveAuthProxyUrl(req.url);
  } catch (err) {
    return {
      ok: false,
      response: authJsonProxyResponse(400, {
        error: 'AUTH_URL_FORBIDDEN',
        message: err instanceof Error ? err.message : '登录请求 URL 无效',
      }),
    };
  }
  if (!COMPLETE_LOGIN_PATHS.has(url.pathname)) {
    return { ok: false, response: authJsonProxyResponse(403, { error: 'AUTH_URL_FORBIDDEN', message: '该登录入口不允许通过 complete-login 调用' }, 'Forbidden') };
  }

  try {
    const prevUserId = (await readTokens())?.user?.id ?? null;
    const headers = sanitizeProxyHeaders(req.headers);
    headers.set('content-type', headers.get('content-type') || 'application/json');
    const fp = await getDeviceFingerprint();
    if (fp?.fpHash) headers.set('X-Device-FP', fp.fpHash);
    const machineId = fp?.fpBlob?.machineId;
    if (machineId) headers.set('X-Machine-Id', String(machineId));
    const body = await buildProxyBody(req.body, headers);
    const response = await fetch(url.toString(), { method, headers, body });
    if (!response.ok) {
      return { ok: false, response: await serializeResponse(response) };
    }
    const payload = await readJsonResponseLimited(response).catch(() => null) as any;
    const user = payload?.user;
    const tokenPair = payload?.tokens;
    if (!user?.id || !tokenPair?.accessToken || !tokenPair?.refreshToken) {
      return {
        ok: false,
        response: authJsonProxyResponse(502, {
          error: 'INVALID_AUTH_RESPONSE',
          message: '登录服务返回格式异常',
        }, 'Bad Gateway'),
      };
    }
    const nextTokens: AuthTokens = {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      accessExpiresAt: typeof tokenPair.expiresIn === 'number'
        ? Date.now() + tokenPair.expiresIn * 1000
        : Date.now() + 50 * 60 * 1000,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone ?? null,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        emailVerifiedAt: user.emailVerifiedAt ?? null,
        phoneVerifiedAt: user.phoneVerifiedAt ?? null,
        suspendedAt: user.suspendedAt ?? null,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt ?? null,
      },
      scopes: typeof tokenPair.scope === 'string'
        ? tokenPair.scope.split(/\s+/).filter(Boolean)
        : undefined,
    };
    await writeTokens(nextTokens);
    markAuthSelfBroadcast();
    await broadcastAuthLogin(prevUserId, nextTokens.user.id, eventSenderId);
    void announceDeviceToCloud(nextTokens.accessToken).catch((e) =>
      console.warn('[auth] announceDeviceToCloud failed:', e?.message ?? e));
    return { ok: true, session: makeSessionStatus(nextTokens) };
  } catch (err) {
    const classified = classifyFetchError(err, url.toString());
    return {
      ok: false,
      response: authJsonProxyResponse(503, {
        error: classified.code,
        message: classified.message,
      }, 'Service Unavailable'),
    };
  }
}

async function logoutWithMainAuth(): Promise<void> {
  const tokens = await readTokens();
  const previousUserId = tokens?.user?.id ?? null;
  if (tokens?.refreshToken) {
    try {
      const ep = resolveCloudEndpoints();
      await fetch(`${ep.api.replace(/\/+$/, '')}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken, clientId: 'neox-desktop' }),
      });
    } catch (err) {
      console.warn('[authHandlers] remote logout failed (will still clear local):', err);
    }
  }
  await clearAuthStateAndBroadcast(previousUserId);
}

export function registerAuthIpcHandlers(): void {
  ipcMain.handle('auth:get-tokens', async (): Promise<null> => {
    /* 安全登录边界: renderer 永不再读取 raw access/refresh token.
     * 保留 IPC 名称只为旧 preload/renderer 不崩, 返回 null 让旧路径自然进入未登录态. */
    return null;
  });

  ipcMain.handle('auth:get-session-status', async (): Promise<AuthSessionStatus> => {
    const tokens = await ensureFreshDesktopAuthTokens();
    return makeSessionStatus(tokens);
  });

  ipcMain.handle('auth:fetch', async (_event, req: AuthProxyRequest): Promise<AuthProxyResult> => {
    return fetchWithMainAuth(req);
  });

  ipcMain.handle('auth:complete-login', async (event, req: AuthProxyRequest): Promise<AuthCompleteLoginResult> => {
    return completeLoginInMain(event?.sender?.id, req);
  });

  ipcMain.handle('auth:logout', async (): Promise<void> => {
    await logoutWithMainAuth();
  });

  ipcMain.handle('auth:set-tokens', async (): Promise<void> => {
    throw new Error('auth:set-tokens 已禁用: 请使用 auth:complete-login / auth:launch-oauth');
  });

  ipcMain.handle('auth:clear-tokens', async (): Promise<void> => {
    /* 登出顺序:
     *   1. 读出旧 user.id 给 logoutBus 用 (handler 按 userId 做精细清理)
     *   2. 触发 logoutBus — presence/relay/cloud-session 等下游优雅停止 (此时 token 还在)
     *   3. 删 auth.enc
     *   4. 广播 auth:changed 给所有 BrowserWindow — renderer 立刻清本地状态  */
    let previousUserId: string | null = null;
    try {
      const tokens = await readTokens();
      previousUserId = tokens?.user?.id ?? null;
    } catch { /* ignore */ }

    await clearAuthStateAndBroadcast(previousUserId);
  });

  /** 自加密方案永远可用 — 保留 IPC 兼容旧 renderer 调用, 一律 true. */
  ipcMain.handle('auth:get-storage-status', async () => {
    return { available: true };
  });

  /**
   * auth:launch-oauth — 浏览器 PKCE 登录主入口.
   *
   *   主进程职责: 生成 PKCE pair, 跳浏览器, 等 deep link, 换 token, 写 auth.enc.
   *   返回给 renderer 仅 user 公开资料 — token 永远不离开主进程.
   *   renderer 后续通用业务请求走 auth:fetch main 代理, 不再持有 Bearer token.
   */
  ipcMain.handle('auth:launch-oauth', async (event, params: {
    controlPlaneBaseUrl?: string;
    webBaseUrl?: string;
    scope?: string;
    deviceName?: string;
  } = {}): Promise<OAuthLoginResult['user']> => {
    const ep = resolveCloudEndpoints();
    const controlPlaneBaseUrl = params.controlPlaneBaseUrl
      || process.env.NEOX_API_BASE
      || ep.api;
    const webBaseUrl = params.webBaseUrl
      || process.env.NEOX_WEB_BASE
      || ep.web;
    const result = await oauthFlow.start({
      controlPlaneBaseUrl,
      webBaseUrl,
      scope: params.scope,
      deviceName: params.deviceName,
    });
    const prevUserId = (await readTokens())?.user?.id ?? null;
    /* 持久化 token — writeTokens 走 localSecretCipher 自加密. */
    await writeTokens({
      accessToken:     result.accessToken,
      refreshToken:    result.refreshToken,
      accessExpiresAt: Date.now() + result.expiresIn * 1000,
      user: {
        id:               result.user.id,
        email:            result.user.email,
        displayName:      result.user.displayName,
        emailVerifiedAt:  result.user.emailVerifiedAt ?? null,
      },
      scopes: result.scope ? result.scope.split(/\s+/).filter(Boolean) : undefined,
    });
    markAuthSelfBroadcast();
    await broadcastAuthLogin(prevUserId, result.user.id, event?.sender?.id);
    /* B 方案: 登录成功立刻把本机 X25519 pubkey announce 到 NeoxCloud, 同账号 mobile 自动发现 */
    void announceDeviceToCloud(result.accessToken).catch((e) =>
      // eslint-disable-next-line no-console
      console.warn('[auth] announceDeviceToCloud failed:', e?.message ?? e));
    return result.user;
  });

  /** auth:cancel-oauth — 用户主动取消 (关闭登录窗口 / 点取消) */
  ipcMain.handle('auth:cancel-oauth', async (): Promise<void> => {
    oauthFlow.cancel();
  });

  ipcMain.handle('auth:device-fingerprint', async (): Promise<{ fpHash: string }> => {
    const { fpHash } = getDeviceFingerprint();
    return { fpHash };
  });

  /**
   * auth:device-headers — renderer 直接 fetch 场景 (OAuth 弹窗 / 登录页) 用的 header 组装.
   *   服务端 middleware 要 X-Device-FP + X-Machine-Id 做六层风控 (device_free_credit_grants 等).
   *   之前 renderer 自己从 fpBlob 拼 header, machineId 就漂在 renderer heap 里成 XSS 目标.
   *   现在 main 组装好 header 字典下发 — renderer 只知道 header 键值对, 不知道 machineId 值.
   *   attack 面: 依然可以 window.fetch 时拿到这个 header, 但 machineId 不再进 JS 内存/localStorage
   *   → renderer XSS 后无法用它离线复现 localSecretCipher KDF 解 .enc.
   */
  ipcMain.handle('auth:device-headers', async (): Promise<Record<string, string>> => {
    const { fpHash, fpBlob } = getDeviceFingerprint();
    const out: Record<string, string> = {};
    if (fpHash) out['X-Device-FP'] = fpHash;
    const machineId = fpBlob?.machineId;
    if (machineId && typeof machineId === 'string') out['X-Machine-Id'] = String(machineId);
    return out;
  });

  /**
   * auth:sign-request — 旧兼容桩.
   * HMAC 签名能力现在只允许 main 内部 auth:fetch 使用, renderer 不再获取任意路径签名能力.
   */
  ipcMain.handle('auth:sign-request', async (_event, path: string, bodySha256Hex: string): Promise<{ ts: string; nonce: string; sig: string; version: string } | null> => {
    void path;
    void bodySha256Hex;
    return null;
  });
}
