/**
 * mobile-bridge/index.ts — Mobile Bridge 启动入口.
 *
 * 在 Electron main 进程的 app.whenReady() 阶段调 startMobileBridge():
 *   - 起 WS server (动态 port)
 *   - 启动 mDNS 广播 _neox._tcp
 *   - 注册 IPC handlers 给 renderer 用 (配对 / 已配对设备列表 / 撤销)
 *
 * 单例模式 — 整个 Electron app 只跑一个 bridge 实例.
 */

import { lazyElectron } from '../lazyElectron.js';

/* electron 走运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里
 * 加载失败, 连累同包所有 handler (见 lazyElectron.ts, 方法必须 bind 回宿主)。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
const electronApp = lazyElectron<typeof import('electron').app>('app');

function safeAppVersion(): string {
  const fromEnv = process.env.NEOX_RELEASE_VERSION || process.env.npm_package_version;
  if (fromEnv) return fromEnv;
  try {
    const v = electronApp.getVersion?.();
    if (v) return v;
  } catch { /* 非 electron 宿主 */ }
  return '';
}
import { MobileBridgeServer } from './wsServer.js';
import { startMdnsBroadcast, stopMdnsBroadcast } from './mdnsBroadcast.js';
import { startSessionEventBridge, stopSessionEventBridge } from './sessionEventBridge.js';
import { bridgeLog, flushBridgeLogSync } from './log.js';
import { CloudRelayClient } from './cloudRelayClient.js';
import { PresenceClient } from './presenceClient.js';
import {
  RELAY_OWNER_HEARTBEAT_MS,
  isRelayOwnedElsewhere,
  refreshRelayOwnership,
  relayOwnedElsewhereAndConnected,
  releaseRelayOwnership,
  tryAcquireRelayOwnership,
} from './relayOwnerLock.js';
import { parseRpcMessage, serializeRpcMessage } from './jsonRpc.js';
import { getPrimaryLanIp, listLanIpCandidates } from './lanIp.js';
import type { RpcMessage } from './types.js';

let server: MobileBridgeServer | null = null;
let cloudClient: CloudRelayClient | null = null;
let presenceClient: PresenceClient | null = null;
/* 持有中继所有权期间的心跳 timer —— 见 relayOwnerLock.ts */
let ownerHeartbeatTimer: NodeJS.Timeout | null = null;
let cloudClientVirtualConns: Map<string, ReturnType<MobileBridgeServer['registerCloudConn']>> = new Map();
/* ProjectManager 引用 — Mobile WS 收到 user_message 时要派给对应 workspace 的
 *  AgentBridge.sendMessage 触发 agent loop. 由 main.ts 注入. */
let projectManagerRef: unknown = null;

export function setMobileBridgeProjectManager(pm: unknown): void {
  projectManagerRef = pm;
}

export function getMobileBridgeProjectManager(): any {
  return projectManagerRef;
}

/** 通知 Desktop renderer "session 列表变了 / 这条 session 应该被打开".
 *
 *   触发点: mobile 通过 session.create RPC 新建后, mobile 端 subscribeSession 后.
 *   Desktop renderer 监听 IPC 'neox:sessions-changed' 后重拉 getSessions() 刷列表;
 *   监听 'neox:mobile-active-session' 后 (可选) 跳到对应 session 实现"联动显示".
 *
 *   实现: 给所有打开的 BrowserWindow 都发, renderer 选自己关心的事件.
 */
export function notifyDesktopSessionsChanged(): void {
  try {
    const wins = BrowserWindow.getAllWindows();
    bridgeLog('notifyDesktop:sessions-changed', `wins=${wins.length}`);
    for (const win of wins) {
      try {
        win.webContents.send('neox:sessions-changed');
      } catch (e: any) {
        bridgeLog('notifyDesktop:sessions-changed', `send failed: ${e?.message}`);
      }
    }
  } catch (e: any) {
    bridgeLog('notifyDesktop:sessions-changed', `getAllWindows failed: ${e?.message}`);
  }
}

export function notifyDesktopMobileActiveSession(sessionId: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('neox:mobile-active-session', sessionId);
      } catch { /* swallow */ }
    }
  } catch { /* swallow */ }
}

/** 启动 — 返实际监听 port.
 *  allowLan 默认 false (只绑 127.0.0.1): app 启动即调本函数, 明文 server 不该未经
 *  用户动作就 LAN 可达. 用户在 UI 显式发起配对时走 enableMobileBridgeLan() 升级. */
export async function startMobileBridge(opts?: { allowLan?: boolean }): Promise<{ port: number; deviceId: string }> {
  if (server) {
    throw new Error('mobile-bridge already started');
  }
  /* 启动前先 load device store (会自动生成 X25519 keypair if 首次) */
  const { getDeviceId, dedupePairedMobiles } = await import('./deviceStore.js');
  const deviceId = getDeviceId();
  try {
    const r = dedupePairedMobiles();
    if (r.before !== r.after) {
      // eslint-disable-next-line no-console
      console.log(`[mobile-bridge] dedupe paired_mobiles: ${r.before} → ${r.after}`);
    }
  } catch { /* ignore */ }

  server = new MobileBridgeServer();
  let hasPairedDevices = false;
  try {
    const { listPairedMobiles } = await import('./deviceStore.js');
    /* filter:'all' — 这里判定的是"这台桌面机是否配过任何手机", 与当前登录用户无关
     * (未登录启动也要让已配对设备连得上, 连上后的会话访问另有 per-user 隔离) */
    hasPairedDevices = listPairedMobiles({ filter: 'all' }).length > 0;
  } catch { /* 读失败按无配对处理 (保守绑 loopback) */ }
  const allowLan = opts?.allowLan === true || hasPairedDevices;
  const port = await server.start({ allowLan });
  /* mDNS 只在 LAN 可达时才广播 — loopback 阶段广播只会引 phone 连一个连不上的地址 */
  if (allowLan) startMdnsBroadcast(port);
  /* 接通 SessionContext 事件 → WS 推送 (Phase 1.D) — server 启完才 subscribe,
   * 保证 handleAppend 拿到 getMobileBridgeServer() 非 null. */
  startSessionEventBridge();
  /* Pilot ↔ 手机: 来电改响手机、手机要念的话由电脑合成 (services/pilotPhoneLink.ts) */
  try {
    const { attachPilotPhoneLink } = await import('../services/pilotPhoneLink.js');
    attachPilotPhoneLink(server);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] pilot phone link not attached:', e?.message);
  }
  // eslint-disable-next-line no-console
  console.log(`[mobile-bridge] started (${allowLan ? 'LAN' : 'loopback'}), port=${port}`);
  return { port, deviceId };
}

/** 升级 mobile-bridge 到 LAN 可达 — 用户在 Settings 显式发起配对时调.
 *  重绑 0.0.0.0 + 起 mDNS 广播 (幂等: 已 LAN 绑定时只返当前 port). */
export async function enableMobileBridgeLan(): Promise<number> {
  if (!server) throw new Error('mobile-bridge not started');
  if (server.isLanBound()) return server.getPort();
  const port = await server.enableLan();
  startMdnsBroadcast(port);
  // eslint-disable-next-line no-console
  console.log(`[mobile-bridge] LAN enabled, http://${getPrimaryLanIp() ?? '<lan-ip>'}:${port}/api/v1/health`);
  return port;
}

export async function disableMobileBridgeLanIfIdle(): Promise<boolean> {
  if (!server || !server.isLanBound()) return false;
  try {
    const { listPairedMobiles } = await import('./deviceStore.js');
    /* filter:'all' — 跟启动时同一口径: 判的是"这台机器配过任何手机吗", 与当前登录用户无关 */
    if (listPairedMobiles({ filter: 'all' }).length > 0) return false;
    const { listPendingPairings } = await import('./pairing.js');
    if (listPendingPairings().length > 0) return false;
  } catch {
    /* 读不出来就不动 —— 保持现状比误断用户的手机安全 */
    return false;
  }
  await stopMdnsBroadcast();
  await server.disableLan();
  return true;
}

/** 关闭 — Electron app quit 时调 */
export async function stopMobileBridge(): Promise<void> {
  stopSessionEventBridge();
  await stopMdnsBroadcast();
  if (server) {
    await server.stop();
    server = null;
  }
  flushBridgeLogSync();
}

export function getMobileBridgeServer(): MobileBridgeServer | null {
  return server;
}

export function getMobileBridgePort(): number {
  return server?.getPort() ?? 0;
}

/* ─── M4 Mode B Cloud Relay 客户端启动 / 停止 ───────────────────────────────
 *
 * Desktop 主动连云端 relay endpoint. 收到 mobile 发来的 envelope, AES-GCM 解密 →
 * 跑 wsServer 同款 dispatcher → reply 加密回发. 跟 LAN ws server 并存, 用户可同时
 * 跑两种 transport (同 WiFi LAN, 跨网络 Cloud).
 *
 * 配对了多 mobile 时, 每个 mobile 有独立 relaySessionKey, 内部 Map 按 mobile.deviceId
 * 路由. Desktop 自己拿 desktopDeviceId 作为 from_device_id 在 envelope 里发. */
export async function startCloudRelayClient(opts: {
  serverBaseUrl: string;
  bearerJwt: string;
  /** 每次重连前取新 bearer; 不传 = 账号 token (自托管中继传固定的部署令牌) */
  refreshToken?: () => Promise<string | null>;
}): Promise<void> {
  if (!server) throw new Error('mobile-bridge not started, cannot start cloud client');
  if (cloudClient) {
    bridgeLog('cloud-relay:client', 'already started, stopping old');
    await stopCloudRelayClient();
  }
  if (!tryAcquireRelayOwnership()) {
    bridgeLog('cloud-relay:client', 'another instance on this machine owns the relay, standby');
    throw new Error(RELAY_OWNED_ELSEWHERE_MSG);
  }
  startOwnerHeartbeat();
  try {
    await startCloudRelayClientOwned(opts);
  } catch (e) {
    /* 没建起 client (没配对手机 / 取 device_id 失败) 就把锁让出去, 别让别的实例干等;
     * 首连失败不算 —— 那种情况 client 已经建好并在后台重连, 锁必须留着。 */
    if (!cloudClient) {
      stopOwnerHeartbeat();
      releaseRelayOwnership();
    }
    throw e;
  }
}

/** 真正建 client 的部分 —— 调用前必须已经持有中继所有权 (见 startCloudRelayClient)。 */
async function startCloudRelayClientOwned(opts: {
  serverBaseUrl: string;
  bearerJwt: string;
  refreshToken?: () => Promise<string | null>;
}): Promise<void> {
  const { getDeviceId, listPairedMobiles, getPairedMobileById } = await import('./deviceStore.js');
  const desktopDeviceId = getDeviceId();
  /* 当前 user — cloud relay 服务于此 user 的 mobile; 其他 user 的配对此处不该带入,
   * 防 A 的旧记录在 B 登录时被无意激活. */
  let currentUserId: string | null = null;
  try {
    const { readDesktopAuthTokens } = await import('../ipc/authHandlers.js');
    const tok = await readDesktopAuthTokens();
    currentUserId = tok?.user?.id ?? null;
  } catch { /* fall through: 不过滤 */ }
  const pairedCount = listPairedMobiles({ currentUserId })
    .filter((m) => !!m.relay_session_key_b64).length;
  if (pairedCount === 0) {
    bridgeLog('cloud-relay:client', 'no paired mobile with relay_session_key, skip start');
    throw new Error(NO_PAIRED_MOBILE_MSG);
  }
  const lookupMobile = (deviceId: string) => {
    const m = getPairedMobileById(deviceId, { currentUserId });
    return m?.relay_session_key_b64 ? m : null;
  };

  const client = new CloudRelayClient({
    serverBaseUrl: opts.serverBaseUrl,
    bearerJwt: opts.bearerJwt,
    refreshToken: opts.refreshToken ?? (async () => {
      /* 每次 (re)connect 前调一次, 确保用 Desktop 主账户当前 fresh token. */
      try {
        const { ensureFreshDesktopAuthTokens } = await import('../ipc/authHandlers.js');
        const tok = await ensureFreshDesktopAuthTokens();
        return tok?.accessToken ?? null;
      } catch {
        return null;
      }
    }),
    desktopDeviceId,
    getMobileKey: (deviceId: string) => {
      const m = lookupMobile(deviceId);
      return m ? Buffer.from(m.relay_session_key_b64!, 'base64') : null;
    },
    onUnknownPeer: async (deviceId: string) => {
      /* 手机刚在云端注册、5 分钟轮询还没轮到 —— 跟 LAN 握手同一个按需补配对入口 (自带限流) */
      const { ensureMobilePairedOnDemand } = await import('./autoPairPoller.js');
      return ensureMobilePairedOnDemand(deviceId);
    },
    dispatch: async (msg: RpcMessage, fromMobileDeviceId: string) => {
      /* 为每个 mobile 维护一个 virtual conn (复用 dispatch 后续的 subscribedSessionIds Set) */
      let virtualConn = cloudClientVirtualConns.get(fromMobileDeviceId);
      if (!virtualConn) {
        const mobile = lookupMobile(fromMobileDeviceId);
        if (!mobile) {
          bridgeLog('cloud-relay:client', `unknown mobile ${fromMobileDeviceId}, drop`);
          return null;
        }
        virtualConn = server!.registerCloudConn({
          mobile,
          isOpen: () => client.isConnected(),
          framesActive: () => client.peerSupportsFrames(fromMobileDeviceId),
          sendRaw: (payload: string) => {
            /* sendRaw 拿到 JSON-RPC payload string, parse 回 RpcMessage 走加密发 */
            const m = parseRpcMessage(payload);
            if (m) void client.sendEncrypted(fromMobileDeviceId, m);
          },
        });
        cloudClientVirtualConns.set(fromMobileDeviceId, virtualConn);
      }
      const reply = await server!.getDispatcher().handle(msg, virtualConn);
      return reply;
    },
  });
  cloudClient = client;
  client.onConnectionStateChange(() => { void presenceClient?.refreshCapabilities(); });
  try {
    const { remoteSessions } = await import('../remoteSessions.js');
    remoteSessions().attachRelayClient(client);
  } catch (e: any) {
    bridgeLog('cloud-relay:client', `wire consumer failed: ${e?.message}`);
  }
  try {
    await client.connect();
    bridgeLog('cloud-relay:client', `started, pairs=${pairedCount}`);
  } catch (e: any) {
    bridgeLog('cloud-relay:client', `first connect failed, client keeps retrying: ${e?.message ?? e}`);
    throw e;
  }
}

const NO_PAIRED_MOBILE_MSG = '没有已配对 mobile 设备, 无法启动云中转客户端 (需先扫码配对 phone)';
/** 同一台机器上已有实例持有中继 —— 正常待命路径, 不是故障。 */
const RELAY_OWNED_ELSEWHERE_MSG = '同一台机器的另一个 Neox 实例已持有云中继连接, 本实例待命';

/** 持有所有权期间的心跳 —— 让待命实例知道我还活着 (顺便带上中继是否真的连着)。 */
function startOwnerHeartbeat(): void {
  stopOwnerHeartbeat();
  const beat = () => refreshRelayOwnership(isCloudRelayConnected());
  beat();
  ownerHeartbeatTimer = setInterval(beat, RELAY_OWNER_HEARTBEAT_MS);
  /* 不阻塞退出 —— 跟本文件其它 timer 一致 (P0-N4) */
  ownerHeartbeatTimer.unref?.();
}

function stopOwnerHeartbeat(): void {
  if (ownerHeartbeatTimer) {
    clearInterval(ownerHeartbeatTimer);
    ownerHeartbeatTimer = null;
  }
}

/**
 * 待命实例的复检 —— 持有者退出后接管。
 *
 * 不依赖"碰巧有人调 ensure" (启动/登录/5 分钟配对轮询/手机唤醒那些触发点): 持有者
 * 进程一死 (正常退出 / 崩), 这里 30s 内就会把中继接回来。持有者还活着时这个复检很便宜
 * —— isRelayOwnedElsewhere() 只读一个文件, 走不到刷 token 那一步。
 */
let standbyRecheckTimer: NodeJS.Timeout | null = null;
const STANDBY_RECHECK_MS = 30_000;
function scheduleStandbyRecheck(): void {
  if (standbyRecheckTimer) return;
  standbyRecheckTimer = setTimeout(() => {
    standbyRecheckTimer = null;
    void ensureCloudRelayClientRunning().catch(() => { /* 下轮再来 */ });
  }, STANDBY_RECHECK_MS);
  standbyRecheckTimer.unref?.();
}

/** 待命结果 —— 顺手排一次复检 (持有者退出后接管)。 */
function standby(): 'other_instance' {
  scheduleStandbyRecheck();
  return 'other_instance';
}

let _ensureCloudInflight: Promise<'running' | 'started' | 'disabled' | 'logged_out' | 'no_paired_mobile' | 'other_instance'> | null = null;
export function ensureCloudRelayClientRunning(): Promise<'running' | 'started' | 'disabled' | 'logged_out' | 'no_paired_mobile' | 'other_instance'> {
  if (_ensureCloudInflight) return _ensureCloudInflight;
  _ensureCloudInflight = (async () => {
    if (!server) throw new Error('mobile-bridge not started, cannot start cloud client');
    if (cloudClient) return 'running' as const;
    /* 同机已有实例在服务手机 —— 不拨号、不报错。中继对同一 device_id 只留一条 WS,
     * 我也拨一条只会把它顶掉, 两边一起进重连风暴 (详见 relayOwnerLock.ts)。
     * 这条日志必须打: "没拨号" 和 "拨号失败" 在用户侧长得一模一样, 排障时全靠它区分。 */
    if (isRelayOwnedElsewhere()) {
      bridgeLog('cloud-relay:client', 'another instance on this machine owns the relay, standby');
      return standby();
    }
    const { isCloudRelayDisabledByUser } = await import('./cloudPrefs.js');
    if (isCloudRelayDisabledByUser()) return 'disabled' as const;
    /* 配了自托管中继就走它 —— 鉴权是部署令牌, 不看账号 */
    const { loadSelfHostedRelay } = await import('./selfHostedRelay.js');
    const selfHosted = loadSelfHostedRelay();
    if (selfHosted) {
      try {
        await startCloudRelayClient({
          serverBaseUrl: selfHosted.url,
          bearerJwt: selfHosted.token,
          refreshToken: async () => loadSelfHostedRelay()?.token ?? null,
        });
      } catch (e: any) {
        const msg = e?.message ?? '';
        if (msg === NO_PAIRED_MOBILE_MSG) return 'no_paired_mobile' as const;
        if (msg === RELAY_OWNED_ELSEWHERE_MSG) return standby();
        throw e;
      }
      return 'started' as const;
    }
    const { ensureFreshDesktopAuthTokens } = await import('../ipc/authHandlers.js');
    const tok = await ensureFreshDesktopAuthTokens();
    if (!tok?.accessToken) return 'logged_out' as const;
    const { resolveCloudEndpoints } = await import('../services/cloudEndpoints.js');
    try {
      await startCloudRelayClient({
        serverBaseUrl: resolveCloudEndpoints().api,
        bearerJwt: tok.accessToken,
      });
    } catch (e: any) {
      const msg = e?.message ?? '';
      if (msg === NO_PAIRED_MOBILE_MSG) return 'no_paired_mobile' as const;
      if (msg === RELAY_OWNED_ELSEWHERE_MSG) return standby();
      throw e;
    }
    return 'started' as const;
  })().finally(() => { _ensureCloudInflight = null; });
  return _ensureCloudInflight;
}

let _stopCloudInflight: Promise<void> | null = null;
export async function stopCloudRelayClient(): Promise<void> {
  if (_stopCloudInflight) return _stopCloudInflight;
  if (!cloudClient) return;
  /* 提前 null 防 race window 内其它代码看到陈旧 ref. dispose 仍持本地 ref toDispose. */
  const toDispose = cloudClient;
  cloudClient = null;
  _stopCloudInflight = (async () => {
    try {
      const { remoteSessions } = await import('../remoteSessions.js');
      await remoteSessions().dispose();
    } catch { /* ignore */ }
    try { await toDispose.dispose(); } catch { /* ignore - dispose idempotent */ }
    if (server) {
      for (const c of cloudClientVirtualConns.values()) {
        server.unregisterCloudConn(c);
      }
    }
    cloudClientVirtualConns.clear();
    /* 停了就不再是中继持有者 —— 让出锁, 同机别的实例可以接管 (否则它要等心跳过期)。 */
    stopOwnerHeartbeat();
    releaseRelayOwnership();
    /* 同上: 停了也要让手机知道远程这条路没了, 否则它还会一直往这儿撞 */
    void presenceClient?.refreshCapabilities();
  })().finally(() => { _stopCloudInflight = null; });
  return _stopCloudInflight;
}

export function isCloudRelayConnected(): boolean {
  return cloudClient?.isConnected() ?? false;
}

/**
 * 启 Desktop presence client — 登录 NeoxCloud 即调一次, logout 调 stopPresenceClient.
 *
 * 跟 mobile-bridge 解耦 — 不管 mobile-bridge 启没启, presence 都常驻. Phone 即使没扫码
 * 配对, server 也能看到这台 desktop 在线 (后续配对时不用让用户等). 详见
 * 内部设计文档
 */
export async function startPresenceClient(opts: {
  serverBaseUrl: string;
  bearerJwt: string;
  deviceName?: string;
}): Promise<void> {
  if (presenceClient) {
    bridgeLog('presence:client', 'already started, stopping old');
    await stopPresenceClient();
  }
  const { getDeviceId, getSupersededDeviceIds, machineFingerprintOrNull } =
    await import('./deviceStore.js');
  const desktopDeviceId = getDeviceId();
  const client = new PresenceClient({
    serverBaseUrl: opts.serverBaseUrl,
    bearerJwt: opts.bearerJwt,
    refreshToken: async () => {
      try {
        const { ensureFreshDesktopAuthTokens } = await import('../ipc/authHandlers.js');
        const tok = await ensureFreshDesktopAuthTokens();
        return tok?.accessToken ?? null;
      } catch { return null; }
    },
    desktopDeviceId,
    deviceName: opts.deviceName ?? '',
    capabilities: () => {
      /* 每次 register 时 lazy 拿当前 caps — mobile_bridge_enabled / lan_ip 都可能动态变 */
      const lanIps = getAllLanIps();
      const lanIp = lanIps[0] ?? null;
      const port = getMobileBridgePort();
      return {
        lan_ip: lanIp ?? undefined,
        lan_ips: lanIps.length > 0 ? lanIps : undefined,
        lan_port: port > 0 ? port : undefined,
        version: safeAppVersion(),
        mobile_bridge_enabled: server !== null,
        relay_connected: cloudClient?.isConnected() === true || relayOwnedElsewhereAndConnected(),
        os: process.platform,
        arch: process.arch,
        /* 同机合并依据 —— 服务端按 (user_id, machine_fp) 把重复设备行并成一台.
         * superseded_device_ids 是本机历史上漂出去的旧 id, 一并交给服务端下线。 */
        machine_fp: machineFingerprintOrNull() ?? undefined,
        superseded_device_ids: (() => {
          const ids = getSupersededDeviceIds();
          return ids.length > 0 ? ids : undefined;
        })(),
      };
    },
    onRelayWake: (reason: string) => {
      /* 服务端: "有手机要连你, 但你的中继不在". 这是"电脑开着却连不上"的唯一修法 ——
       * 中继那条 WS 死了以前没人管 (线上实录: 24 小时没拨号, presence 却报在线)。
       *   已有 client → wakeNow 取消退避立刻拨;
       *   没有 client → 走幂等入口起一条 (启动时没配手机 / 用户刚开开关都是这种)。 */
      bridgeLog('presence:client', `relay wake: ${reason}`);
      if (cloudClient) {
        cloudClient.wakeNow(reason);
        return;
      }
      void ensureCloudRelayClientRunning()
        .then((r) => bridgeLog('presence:client', `relay wake → ensure: ${r}`))
        .catch((e: any) => bridgeLog('presence:client', `relay wake → ensure failed: ${e?.message ?? e}`));
    },
    onAuthDead: () => {
      /* 不再无声地打 401 —— 告诉界面这台电脑现在手机连不上, 且原因是可操作的。 */
      bridgeLog('presence:client', 'auth dead → 通知 renderer 提示重新登录');
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents?.send('neox:presence-auth-dead', {
            reason: 'token_expired',
            deviceId: desktopDeviceId,
          });
        }
      } catch { /* 窗口没了就算了 */ }
    },
  });
  presenceClient = client;
  await client.start();
  bridgeLog('presence:client', 'started');
}

/**
 * 重新登录 / 刷到新 token 之后叫醒 presence。
 *
 * presence 在 token 过期且刷不出新的时候会进终态 (不再无限打 401), 登录成功那一刻
 * 必须有人把它叫回来, 否则要等用户重启 App —— 那正是以前"电脑明明开着, 手机就是
 * 看不到它"的另一半原因。幂等, 没在终态就是空操作。
 */
export function notifyPresenceReauthenticated(freshJwt?: string): void {
  if (!presenceClient) return;
  try { presenceClient.resumeAfterReauth(freshJwt); } catch { /* 叫醒失败不该影响登录流程 */ }
}

/** presence 是否卡在"需要重新登录"终态 — 状态查询给 UI / 诊断用. */
export function isPresenceAuthDead(): boolean {
  try { return presenceClient?.isAuthDead() === true; } catch { return false; }
}

/* P1-N2 同款 inflight guard — 跟 stopCloudRelayClient 一致防并发 dispose. */
let _stopPresenceInflight: Promise<void> | null = null;
export async function stopPresenceClient(): Promise<void> {
  if (_stopPresenceInflight) return _stopPresenceInflight;
  if (!presenceClient) return;
  const toDispose = presenceClient;
  presenceClient = null;
  _stopPresenceInflight = (async () => {
    try { await toDispose.dispose(); } catch { /* ignore - dispose idempotent */ }
    bridgeLog('presence:client', 'stopped');
  })().finally(() => { _stopPresenceInflight = null; });
  return _stopPresenceInflight;
}

/** 切了 mobile-bridge 开关 / 换 WiFi → 主动重发 register 上报最新 caps. */
export async function refreshPresenceCapabilities(): Promise<void> {
  if (presenceClient) {
    await presenceClient.refreshCapabilities();
  }
}

export function isPresenceConnected(): boolean {
  return presenceClient?.isConnected() ?? false;
}

/** 实时算 — 不 cache, 让 Desktop 换 WiFi 后下一次 QR 立即拿到新 IP. */
export function getMobileBridgeLanIp(): string | null {
  return getPrimaryLanIp();
}

/** 返所有候选 LAN IP — QR 编全部, Phone 端逐个 try 直到连通.
 *  防止 Desktop 多网卡 (有线+WiFi+Hotspot) 时挑错 IP, Phone 走不通. */
export function getAllLanIps(): string[] {
  return listLanIpCandidates();
}
