/**
 * cloudRelayClient.ts — Desktop electron 主进程的 cloud-relay 客户端 (Mode B).
 *
 * 协议规范 内部设计文档 §4:
 *   - Desktop 跟 Mobile 一样是 cloud-relay 的客户端 (不是 server pattern)
 *   - WSS 连 ${serverBaseUrl}/relay/api/v1/relay, Bearer JWT 鉴权
 *   - 收 envelope (mobile 发的) → AES-256-GCM 解密 → 还原 RpcMessage → dispatch 到
 *     wsServer 同款 dispatcher 处理 (透明跨 transport)
 *   - 发 reply / push → AES-256-GCM 加密 → envelope JSON → ws.send
 *
 * 跟 MobileBridgeServer 并存: 同一进程内 Desktop 既是 LAN server (mobile 连过来),
 *   又是 cloud client (主动连云端 relay). 两条路径都接收/响应同样的 JSON-RPC.
 */

import { WebSocket } from 'ws';

import { bridgeLog } from './log.js';
import { makeErrorResponse, parseRpcMessage } from './jsonRpc.js';
import type { RpcMessage } from './types.js';
import {
  encryptAesGcm,
  decryptAesGcm,
  randomNonce,
  makeEnvelope,
  parseEnvelope,
  isPeerOfflineFrame,
  isBinaryFrame,
  decodeFrame,
  encodeFrames,
  splitSealed,
  FrameAssembler,
  FrameCaps,
  FRAME_VERSION,
  encodeRpcPlaintext,
} from '@neoxlabs/core/relay-transport/index.js';

/** 云中转单条 envelope 上限 (NeoxCloud cloud-relay relay.go maxEnvelopeBytes = 256KB), 留一点余量。
 *  超了中转会断掉整条连接, 所以发之前自己量。 */
const RELAY_ENVELOPE_LIMIT_BYTES = 250 * 1024;

export interface CloudRelayConfig {
  serverBaseUrl: string;        // http://<gateway-host> / https://relay.neox.dev
  bearerJwt: string;            // NeoxCloud JWT (初始值; 临期由 refreshToken() 续)
  /** token 过期前 < 5min 重连时调一次拉新 access. 主进程 SSO 行为. */
  refreshToken?: () => Promise<string | null>;
  desktopDeviceId: string;      // 本机 deviceId (跟 paired_mobiles 那边的一致)
  getMobileKey: (mobileDeviceId: string) => Buffer | null;
  /**
   * 收到不认识的 peer 时调一次, 让上层有机会当场补配对 (如按账号拉一次设备列表)。
   * 返回 true 表示配对表可能变了, client 会再查一次 key; 仍然没有才丢弃并大声记日志。
   */
  onUnknownPeer?: (peerDeviceId: string) => Promise<boolean>;
  heartbeat?: { intervalMs: number; pongTimeoutMs: number };
  /**
   * 收到 RpcMessage 后的 dispatch 入口. cloudRelayClient 解密后调这个,
   *   让 wsServer.dispatcher 走同套 handler. 返回 reply 让本 client 走加密回发.
   *
   *   conn 提供"虚拟 mobile conn"语义 (deviceId 当 from_device_id) 给 dispatcher
   *   的 handler 用 (e.g. session.subscribe 要 subscribedSessionIds Set).
   */
  dispatch: (msg: RpcMessage, mobileDeviceId: string) => Promise<RpcMessage | null>;
}

/**
 * Cloud-pod inbound 角色 — desktop 作为 *consumer* 连云端 agent pod.
 *   跟 mobile inbound (上面那套 dispatch) 共用同一条 WS, 避免两个 client 同 JWT 互相挤掉.
 *   按 from_device_id 路由: 先查 getMobileKey, 没匹配再问这里.
 *   getKey 返回 null 表示该 peer 不归本 inbound 管 (传上层 drop).
 */
export interface CloudPodInbound {
  getKey: (podDeviceId: string) => Buffer | null;
  onMessage: (msg: RpcMessage, fromPodDeviceId: string) => void;
}

const DEFAULT_HEARTBEAT = { intervalMs: 10_000, pongTimeoutMs: 20_000 };

const DISPLACED_BACKOFF_MIN_MS = 20_000;
const DISPLACED_BACKOFF_MAX_MS = 5 * 60_000;
const DISPLACED_STABLE_MS = 60_000;

/** 服务端踢人时给的 reason —— 见 NeoxCloud apps/cloud-relay/internal/hub/hub.go。 */
function isDisplacedClose(reasonText: string): boolean {
  return reasonText.includes('displaced_by_new_conn');
}

/** 解出来的一条: v1 信封 base64 解开 / v2 帧拼好拆开, 后面一视同仁 */
interface Sealed { nonce: Buffer; ciphertext: Buffer }

/** envelope 解密 —— 密钥轮换重试要调两次, 抽出来。 */
function decryptEnvelope(key: Buffer, env: Sealed): string {
  return decryptAesGcm(key, env.nonce, env.ciphertext).toString('utf8');
}

/** 发分片时 socket 缓冲超过这个就等一等, 让小消息 (流式增量 / 心跳回包) 插到前面 */
const BULK_HIGH_WATER_BYTES = 1024 * 1024;

export class CloudRelayClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private connected = false;
  /** 在途的 dial —— 防两条并发拨号各自注册、互相顶号。 */
  private inflightDial: Promise<void> | null = null;
  /** 本次连接建立的时刻 —— 判断顶号是偶发还是互顶风暴。 */
  private openedAtMs = 0;
  /** 顶号退避的当前档位。 */
  private displacedBackoffMs = DISPLACED_BACKOFF_MIN_MS;
  /** Optional cloud-pod inbound — 由 consumerClient 共享同一条 WS 时挂上来. */
  private cloudPodInbound: CloudPodInbound | null = null;
  /** 连接状态变化订阅 (consumerClient 用来 reject 等响应中的 RPC). */
  private connectionListeners = new Set<(connected: boolean) => void>();

  /** 协议 v2 (frameCodec.ts): 谁认二进制帧 + 分片拼装 */
  private readonly caps = new FrameCaps();
  private readonly assembler = new FrameAssembler();

  constructor(private cfg: CloudRelayConfig) {}

  /** 这台手机走的是 v2 (能发大回包): file.fetch 据此放大块 */
  peerSupportsFrames(mobileDeviceId: string): boolean {
    return this.caps.canSend(mobileDeviceId);
  }

  /** Pluggable cloud-pod 入站 — desktop 当 consumer 跟 cloud agent pod 共用本条 WS. */
  setCloudPodInbound(inbound: CloudPodInbound | null): void {
    this.cloudPodInbound = inbound;
  }

  /** consumerClient 等响应中 RPC 在断线/重连时需要 reject pending — 订阅状态变化. */
  onConnectionStateChange(fn: (connected: boolean) => void): () => void {
    this.connectionListeners.add(fn);
    return () => { this.connectionListeners.delete(fn); };
  }
  private emitConnectionState(state: boolean): void {
    for (const fn of this.connectionListeners) {
      try { fn(state); } catch { /* ignore */ }
    }
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    if (this.inflightDial) return this.inflightDial;
    this.inflightDial = this.dialOnce().finally(() => { this.inflightDial = null; });
    return this.inflightDial;
  }

  private async dialOnce(): Promise<void> {
    if (this.disposed) return;
    /* 连接前先确保 token 没过期 (调 caller 提供的 refreshToken 拿新 access). */
    if (this.cfg.refreshToken) {
      try {
        const fresh = await this.cfg.refreshToken();
        if (fresh && fresh !== this.cfg.bearerJwt) {
          this.cfg.bearerJwt = fresh;
          bridgeLog('cloud-relay:client', 'token refreshed before connect');
        }
      } catch (e: any) {
        bridgeLog('cloud-relay:client', `token refresh failed (will try with old): ${e?.message}`);
      }
    }
    if (this.disposed) return;
    const base = this.cfg.serverBaseUrl.replace(/\/+$/, '');
    const scheme = base.startsWith('https://') ? 'wss' : 'ws';
    const hostPath = base.replace(/^https?:\/\//, '');
    const url = `${scheme}://${hostPath}/relay/api/v1/relay`;
    bridgeLog('cloud-relay:client', `dialing ${url}`);
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.cfg.bearerJwt}`,
          'X-Neox-Device-Id': this.cfg.desktopDeviceId,
          'X-Neox-Device-Type': 'desktop',
        },
        handshakeTimeout: 10_000,
      });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.connected = true;
        /* 新连接的中转版本以它的 relay_hello 为准 */
        this.caps.resetRelay();
        this.openedAtMs = Date.now();
        this.reconnectDelay = 1000;
        bridgeLog('cloud-relay:client', 'authenticated');
        this.startHeartbeat(ws);
        this.emitConnectionState(true);
        resolve();
      });
      ws.on('message', (data) => this.handleMessage(data));
      ws.on('close', (code, reason) => {
        /* 只认当前这条: 被 terminate 的旧连接晚到的 close 不该把新连接的状态打成断开 */
        if (this.ws !== ws) return;
        this.stopHeartbeat();
        this.connected = false;
        const reasonText = reason.toString();
        bridgeLog('cloud-relay:client', `closed code=${code} reason=${reasonText.slice(0, 80)}`);
        this.emitConnectionState(false);
        if (this.disposed) return;
        if (isDisplacedClose(reasonText)) {
          this.scheduleReconnect(this.nextDisplacedBackoff());
          return;
        }
        this.scheduleReconnect();
      });
      ws.on('error', (err: Error) => {
        bridgeLog('cloud-relay:client', `error: ${err.message}`);
        if (!opened) reject(err);
      });
    });
  }

  /**
   * 立刻重拨 —— 服务端说"有手机现在要连你" (presence 推的 relay.wake) 时调.
   *
   * 已经连着就什么都不做。断着的话不等退避那 1→30s: 手机此刻就在等, 让它多等
   * 半分钟毫无道理。退避计数也一并归零 —— 这一次是有人主动要连, 不是盲目重试。
   */
  wakeNow(reason: string): void {
    if (this.disposed) return;
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      bridgeLog('cloud-relay:client', `wake (${reason}): 已连着, 忽略`);
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 1000;
    bridgeLog('cloud-relay:client', `wake (${reason}): 立刻重拨`);
    this.connect().catch((e) => bridgeLog('cloud-relay:client', `wake dial failed: ${e?.message ?? e}`));
  }

  private scheduleReconnect(overrideDelayMs?: number): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 500);
    const base = overrideDelayMs ?? this.reconnectDelay;
    const delay = base + jitter;
    bridgeLog('cloud-relay:client', `reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      /* 只有常规档才递增进避档位; 顶号长档是另一条曲线, 不污染它。 */
      if (overrideDelayMs === undefined) this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect().catch((e) => bridgeLog('cloud-relay:client', `reconnect failed: ${e?.message}`));
    }, delay);
    /* P0-N4 同款: 不阻塞 event loop — 防 quit 时 dispose 异常没 clearTimeout, 主进程
     *  要等下一 reconnect tick (30s 上限) 才能退. */
    this.reconnectTimer.unref?.();
  }

  /** 顶号退避 —— 连着活过 DISPLACED_STABLE_MS 说明是偶发, 回到最小档; 否则逐次翻倍。 */
  private nextDisplacedBackoff(): number {
    const livedMs = this.openedAtMs > 0 ? Date.now() - this.openedAtMs : 0;
    if (livedMs >= DISPLACED_STABLE_MS) this.displacedBackoffMs = DISPLACED_BACKOFF_MIN_MS;
    const current = this.displacedBackoffMs;
    this.displacedBackoffMs = Math.min(current * 2, DISPLACED_BACKOFF_MAX_MS);
    bridgeLog('cloud-relay:client',
      `displaced by another conn (lived ${livedMs}ms), retry in ~${Math.round(current / 1000)}s`);
    return current;
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    const { intervalMs, pongTimeoutMs } = this.cfg.heartbeat ?? DEFAULT_HEARTBEAT;
    let lastAliveAt = Date.now();
    const markAlive = () => { lastAliveAt = Date.now(); };
    ws.on('pong', markAlive);
    ws.on('message', markAlive);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws) { this.stopHeartbeat(); return; }
      const silentMs = Date.now() - lastAliveAt;
      if (silentMs > pongTimeoutMs) {
        bridgeLog('cloud-relay:client', `heartbeat: no pong for ${silentMs}ms, terminate & reconnect`);
        this.stopHeartbeat();
        /* terminate 会同步触发 close 事件 → connected=false + scheduleReconnect */
        try { ws.terminate(); } catch (e: any) {
          bridgeLog('cloud-relay:client', `heartbeat terminate failed: ${e?.message}`);
        }
        return;
      }
      try { ws.ping(); } catch (e: any) {
        bridgeLog('cloud-relay:client', `heartbeat ping failed: ${e?.message}`);
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** mobile key 现查; 查不到给上层一次补配对的机会再查。仍没有返 null。 */
  private async resolveMobileKey(fromDevice: string): Promise<Buffer | null> {
    const key = this.cfg.getMobileKey(fromDevice);
    if (key) return key;
    if (!this.cfg.onUnknownPeer) return null;
    let maybeChanged = false;
    try {
      maybeChanged = await this.cfg.onUnknownPeer(fromDevice);
    } catch (e: any) {
      bridgeLog('cloud-relay:client', `onUnknownPeer failed for ${fromDevice}: ${e?.message}`);
    }
    return maybeChanged ? this.cfg.getMobileKey(fromDevice) : null;
  }

  private async handleMessage(data: any): Promise<void> {
    /* v2 二进制帧: 拼齐了才往下走 */
    if (isBinaryFrame(data)) {
      const f = decodeFrame(data);
      if (!f) {
        bridgeLog('cloud-relay:client', 'binary frame invalid');
        return;
      }
      const whole = this.assembler.push(f.hdr, f.body);
      if (!whole) return;
      const sealed = splitSealed(whole);
      if (!sealed) return;
      this.caps.onPeerCap(f.hdr.from, undefined, FRAME_VERSION);
      await this.handleSealed(f.hdr.from, sealed);
      return;
    }
    const env = parseEnvelope(data);
    if (!env) {
      bridgeLog('cloud-relay:client', 'envelope schema invalid');
      return;
    }
    /* relay control frame (relay_error / device_offline / ...) — 顶层 type, 不加密 */
    if ('type' in env) {
      if (env.type === 'relay_hello') {
        this.caps.onRelayHello(env.v);
        return;
      }
      bridgeLog('cloud-relay:client', `control frame: ${env.type} ${env.message ?? ''}`);
      if (isPeerOfflineFrame(env)) {
        /* host 模式: 对端 mobile 离线了, 当前 desktop 不需要做啥 (mobile 自己重连),
         * 这里只 log. consumer 模式那边才需要翻 failed state. */
      }
      return;
    }
    this.caps.onPeerCap(env.from_device_id, undefined, env.cap);
    await this.handleSealed(env.from_device_id, {
      nonce: Buffer.from(env.nonce, 'base64'),
      ciphertext: Buffer.from(env.ciphertext, 'base64'),
    });
  }

  private async handleSealed(fromDevice: string, env: Sealed): Promise<void> {
    /* 先按 mobile peer 找 key; 没匹配再问 cloud-pod inbound (consumer 角色, 共享本 WS). */
    const mobileKey = this.cfg.getMobileKey(fromDevice);
    if (mobileKey) {
      await this.handleMobileEnvelope(env, fromDevice, mobileKey);
      return;
    }
    /* 不是 mobile, 试 cloud-pod */
    if (this.cloudPodInbound) {
      const podKey = this.cloudPodInbound.getKey(fromDevice);
      if (podKey) {
        let plaintext: string;
        try {
          plaintext = decryptEnvelope(podKey, env);
        } catch (e: any) {
          bridgeLog('cloud-relay:client', `decrypt failed for pod ${fromDevice.slice(0, 16)}: ${e?.message}`);
          return;
        }
        let msg: RpcMessage | null;
        try { msg = parseRpcMessage(plaintext); }
        catch { return; }
        if (!msg) return;
        try { this.cloudPodInbound.onMessage(msg, fromDevice); }
        catch (e: any) { bridgeLog('cloud-relay:client', `pod onMessage err: ${e?.message}`); }
        return;
      }
    }
    /* 都不认识 → 可能是刚在云端注册、本机还没轮询到的同账号手机: 当场补一次再查。
     *  放在 pod 判断之后, 免得每条 pod 消息都去打一次云端。 */
    const lateKey = await this.resolveMobileKey(fromDevice);
    if (lateKey) {
      bridgeLog('cloud-relay:client', `peer ${fromDevice} paired on demand, handling message`);
      await this.handleMobileEnvelope(env, fromDevice, lateKey);
      return;
    }
    bridgeLog('cloud-relay:client',
      `DROP: unknown peer ${fromDevice} (not a paired mobile for this account, not a cloud pod) — `
      + 'phone will time out; check paired_mobiles / account auto-pair');
  }

  private async handleMobileEnvelope(
    env: Sealed,
    fromDevice: string,
    mobileKey: Buffer,
  ): Promise<void> {
    let plaintext: string;
    try {
      plaintext = decryptEnvelope(mobileKey, env);
    } catch (e: any) {
      const refreshed = await this.refreshPeerKey(fromDevice, mobileKey);
      if (!refreshed) {
        bridgeLog('cloud-relay:client', `decrypt failed for mobile ${fromDevice.slice(0, 16)}: ${e?.message}`);
        return;
      }
      try {
        plaintext = decryptEnvelope(refreshed, env);
        bridgeLog('cloud-relay:client', `peer key rotated for ${fromDevice.slice(0, 16)}, message recovered`);
      } catch (e2: any) {
        bridgeLog('cloud-relay:client', `decrypt failed after key refresh for ${fromDevice.slice(0, 16)}: ${e2?.message}`);
        return;
      }
    }
    let msg: RpcMessage | null;
    try { msg = parseRpcMessage(plaintext); }
    catch { return; }
    if (!msg) return;
    try {
      const reply = await this.cfg.dispatch(msg, fromDevice);
      if (reply) await this.sendEncryptedWithKey(fromDevice, mobileKey, reply);
    } catch (e: any) {
      bridgeLog('cloud-relay:client', `dispatch err: ${e?.message}`);
    }
  }

  /** 换 key 重试用: 拉一次同账号设备表并重新派生, 返回新 key (没变 / 拉不到返 null)。 */
  private async refreshPeerKey(fromDevice: string, staleKey: Buffer): Promise<Buffer | null> {
    if (!this.cfg.onUnknownPeer) return null;
    try {
      await this.cfg.onUnknownPeer(fromDevice);
    } catch (e: any) {
      bridgeLog('cloud-relay:client', `key refresh failed for ${fromDevice.slice(0, 16)}: ${e?.message}`);
      return null;
    }
    const fresh = this.cfg.getMobileKey(fromDevice);
    if (!fresh || fresh.equals(staleKey)) return null;
    return fresh;
  }

  /** 给某 mobile device 加密发 RpcMessage. */
  async sendEncrypted(toMobileDeviceId: string, msg: RpcMessage): Promise<boolean> {
    const key = this.cfg.getMobileKey(toMobileDeviceId);
    if (!key) {
      bridgeLog('cloud-relay:client', `sendEncrypted: no key for ${toMobileDeviceId.slice(0, 16)}`);
      return false;
    }
    return this.sendEncryptedWithKey(toMobileDeviceId, key, msg);
  }

  /** 用任意 key 给任意 peer 加密发. consumer 角色用这条发给 cloud agent pod. */
  async sendEncryptedWithKey(toDeviceId: string, key: Buffer, msg: RpcMessage): Promise<boolean> {
    if (!this.connected || !this.ws) return false;
    if (this.caps.canSend(toDeviceId)) return this.sendFrames(toDeviceId, key, msg);
    const frame = this.sealEnvelope(toDeviceId, key, msg);
    if (Buffer.byteLength(frame, 'utf8') > RELAY_ENVELOPE_LIMIT_BYTES) {
      /* 超过中转上限的帧**绝不能发**: 中转读到就断掉电脑这整条连接 (所有手机一起掉),
       * 这条请求也就丢了, 手机干等到超时 —— 用户看到的是「有的会话拉取失败」。
       * 是请求的回包就换成一个明确的错误回过去, 手机立刻知道失败; 推送直接丢, 记一笔。 */
      const id = (msg as { id?: unknown }).id;
      bridgeLog('cloud-relay:client', `drop oversized frame to ${toDeviceId.slice(0, 16)}: ${Buffer.byteLength(frame, 'utf8')} bytes (id=${String(id ?? '-')})`);
      if (id == null || !('result' in (msg as object))) return false;
      const errFrame = this.sealEnvelope(toDeviceId, key, makeErrorResponse(id as any, -32001, 'payload too large for relay'));
      this.ws.send(errFrame);
      return false;
    }
    this.ws.send(frame);
    return true;
  }

  /**
   * v2: 加密一次 → 切帧 → 二进制发。一帧的直接发; 多帧的大回包边发边看 socket 缓冲,
   * 堆到 1MB 就让一让, 期间别的小消息 (单帧, 直接 send) 自然排到前面, 流式输出不被大图卡住。
   */
  private async sendFrames(toDeviceId: string, key: Buffer, msg: RpcMessage): Promise<boolean> {
    const plaintext = encodeRpcPlaintext(msg, true);
    const nonce = randomNonce();
    const frames = encodeFrames(
      { to: toDeviceId, from: this.cfg.desktopDeviceId },
      nonce,
      encryptAesGcm(key, nonce, plaintext),
    );
    for (const f of frames) {
      const ws = this.ws;
      if (!ws || !this.connected) return false;
      while (frames.length > 1 && ws.bufferedAmount > BULK_HIGH_WATER_BYTES) {
        await new Promise((r) => setTimeout(r, 15));
        if (this.ws !== ws || !this.connected) return false;
      }
      ws.send(f, { binary: true });
    }
    return true;
  }

  private sealEnvelope(toDeviceId: string, key: Buffer, msg: RpcMessage): string {
    const plaintext = encodeRpcPlaintext(msg, false);
    const nonce = randomNonce();
    const ciphertext = encryptAesGcm(key, nonce, plaintext);
    return JSON.stringify(makeEnvelope({
      toDeviceId,
      fromDeviceId: this.cfg.desktopDeviceId,
      nonce,
      ciphertext,
      /* 告诉对端「我认 v2 帧」, 它也认就会改发 v2 */
      cap: FRAME_VERSION,
    }));
  }

  isConnected(): boolean { return this.connected; }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    const wasConnected = this.connected;
    if (this.ws) {
      try { this.ws.close(1000, 'client_dispose'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    /* close 处理器现在只认当前 ws, 而上面已经置 null —— 断开通知在这里补发,
     *  订阅方 (consumerClient) 靠它 reject 等响应中的 RPC。 */
    if (wasConnected) this.emitConnectionState(false);
  }
}

// AES-GCM 加密/解密迁移到 @neoxlabs/core/relay-transport — 跟 pod / consumer 共享一份.
