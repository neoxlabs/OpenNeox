/**
 * presenceClient.ts — Desktop 端 NeoxCloud presence 注册客户端.
 *
 * 协议文档: 内部设计文档 §4.3
 *
 * 跟 CloudRelayClient 解耦:
 *   - cloudRelayClient = mobile-bridge 数据通道 (跨网络转发加密 envelope), 用户开关
 *   - presenceClient   = 设备在线状态通道, 登录 NeoxCloud 即启用, 不依赖 mobile-bridge
 *
 * 行为:
 *   - 启动后立刻 WSS 连 ${serverBaseUrl}/presence/api/v1/registry
 *   - 上后 immediately 发 presence.register notification (上报 capabilities)
 *   - 每 10s 发 presence.heartbeat notification (刷 Redis TTL)
 *   - 收到 presence.re_register_required (server 端 Redis key gone) → 立刻重发 register
 *   - 连接断 → exponential backoff 1-30s 重连; 重连前 refresh JWT
 *   - dispose() 主动 close (server 立刻 broadcast offline)
 */

import { WebSocket } from 'ws';
import { bridgeLog as log } from './log.js';

export interface PresenceCapabilities {
  /** Desktop LAN IP (mDNS broadcast 一致), 给 Phone 同 WiFi 时优先 LAN 用 */
  lan_ip?: string;
  lan_port?: number;
  /** Desktop 应用版本 */
  version?: string;
  /** mobile-bridge 是否启用 (false 时 Phone 知道走不通 cloud relay) */
  mobile_bridge_enabled?: boolean;
  os?: string;
  arch?: string;
  [k: string]: unknown;
}

export interface PresenceClientConfig {
  /** http://relay.neox.dev 或 http://<gateway-host> — 自动转 ws/wss */
  serverBaseUrl: string;
  /** 初始 JWT. 重连前 refreshToken 拉新替换 */
  bearerJwt: string;
  /** Desktop 主账户 token 续期. 每次 (re)connect 前调一次. */
  refreshToken?: () => Promise<string | null>;
  /** 本机 device_id (跟 paired_mobiles 视角的 desktop deviceId 一致) */
  desktopDeviceId: string;
  /** 显示名 ("Liu's MacBook" 之类), Phone UI 显设备列表用 */
  deviceName?: string;
  /** lazy capabilities provider — register 时调一次拿当前快照, 不缓存
   *  (mobile_bridge_enabled 可能在 register 之后被切换) */
  capabilities: () => PresenceCapabilities;
  /** token 过期且刷不出新的 → 进终态时回调一次, 宿主据此提示"需要重新登录". */
  onAuthDead?: () => void;
  onRelayWake?: (reason: string) => void;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const WS_CONNECT_TIMEOUT_MS = 8_000;
/** server 端 token 临期 < 这个时间提前 refresh */
const TOKEN_REFRESH_GRACE_SECS = 300;
/** token 已过期还刷不出新的, 连续这么多轮就进终态 (给刷新一点瞬时故障的余地) */
const STALE_TOKEN_MAX_ROUNDS = 3;

export class PresenceClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private disposed = false;
  private connected = false;
  /** token 已过期且刷不出新的 → 终态, 停止一切重连, 等 resumeAfterReauth() */
  private authDead = false;
  private staleTokenRounds = 0;

  constructor(private cfg: PresenceClientConfig) {}

  isConnected(): boolean { return this.connected; }

  /** 是否卡在"需要重新登录"终态 — UI 拿这个显示可执行的提示, 而不是永远转圈. */
  isAuthDead(): boolean { return this.authDead; }

  /**
   * 重新登录 / 拿到新 token 之后叫醒。
   * 幂等: 没在终态就什么都不做; 在终态就清标志立刻重连一次。
   */
  resumeAfterReauth(freshJwt?: string): void {
    if (this.disposed) return;
    if (freshJwt) this.cfg.bearerJwt = freshJwt;
    if (!this.authDead) return;
    this.authDead = false;
    this.staleTokenRounds = 0;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    log('presence:client', '收到新凭据, 从 auth-dead 终态恢复, 立刻重连');
    void this.connect();
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    await this.connect();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearReconnect();
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, 'client_dispose'); } catch { /* ignore */ }
    }
  }

  /** 上层切了 capabilities (比如 mobile-bridge 开关) → 主动重发一次 register 上报新 caps. */
  async refreshCapabilities(): Promise<void> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendRegister();
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.authDead) return;

    /* 重连前先 refresh token, 防止 JWT 临期被 server 401 卡死循环 */
    if (this.cfg.refreshToken) {
      try {
        const fresh = await this.cfg.refreshToken();
        if (fresh && fresh !== this.cfg.bearerJwt) {
          this.cfg.bearerJwt = fresh;
          this.staleTokenRounds = 0;
          log('presence:client', 'token refreshed before connect');
        }
      } catch (e: any) {
        log('presence:client', `token refresh failed: ${e?.message ?? e}`);
      }
    }

    const expiresIn = this.tokenExpiresInSecs();
    if (expiresIn != null && expiresIn <= 0) {
      this.staleTokenRounds += 1;
      if (this.staleTokenRounds >= STALE_TOKEN_MAX_ROUNDS) {
        this.authDead = true;
        this.clearReconnect();
        this.clearHeartbeat();
        log(
          'presence:client',
          `token 已过期 ${-expiresIn}s 且连续 ${this.staleTokenRounds} 轮刷不出新的 → ` +
          '停止重连 (等重新登录唤醒), 不再向服务端打 401',
        );
        try { this.cfg.onAuthDead?.(); } catch { /* 宿主回调不该拖垮这里 */ }
        return;
      }
      log('presence:client', `token 已过期 ${-expiresIn}s, 第 ${this.staleTokenRounds} 轮重试`);
    } else if (expiresIn != null && expiresIn < TOKEN_REFRESH_GRACE_SECS) {
      log('presence:client', `token 临期 (剩 ${expiresIn}s), 继续 try`);
    }

    const base = this.cfg.serverBaseUrl.replace(/\/+$/, '');
    const scheme = base.startsWith('https://') ? 'wss' : 'ws';
    const hostPath = base.replace(/^https?:\/\//, '');
    const url = `${scheme}://${hostPath}/presence/api/v1/registry`;
    log('presence:client', `dialing ${url}`);

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.cfg.bearerJwt}`,
          'X-Neox-Device-Id': this.cfg.desktopDeviceId,
          'X-Neox-Device-Kind': 'desktop',
        },
        handshakeTimeout: WS_CONNECT_TIMEOUT_MS,
      });

      let opened = false;

      const openHandler = (): void => {
        opened = true;
        this.ws = ws;
        this.connected = true;
        this.reconnectDelayMs = RECONNECT_MIN_MS;
        log('presence:client', 'connected');
        this.sendRegister();
        this.startHeartbeat();
        resolve();
      };

      ws.on('open', openHandler);
      ws.on('message', (data: Buffer | string) => this.handleMessage(data));
      ws.on('error', (err: Error) => {
        log('presence:client', `socket error: ${err.message}`);
        if (!opened) {
          /* connect 阶段错 — 不立即 reject 让外层崩, 走 reconnect 自愈 */
          this.scheduleReconnect();
          resolve();
        }
      });
      ws.on('close', (code: number, reason: Buffer) => {
        log('presence:client', `closed code=${code} reason=${reason.toString().slice(0, 80)}`);
        this.connected = false;
        this.ws = null;
        this.clearHeartbeat();
        if (!this.disposed) this.scheduleReconnect();
      });
    });
  }

  private sendRegister(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const caps = (() => {
      try { return this.cfg.capabilities(); } catch { return {}; }
    })();
    const msg = {
      jsonrpc: '2.0',
      method: 'presence.register',
      params: {
        device_id: this.cfg.desktopDeviceId,
        device_kind: 'desktop',
        device_name: this.cfg.deviceName ?? '',
        capabilities: caps,
      },
    };
    try {
      ws.send(JSON.stringify(msg));
      log('presence:client', `register sent (caps keys=${Object.keys(caps).join(',')})`);
    } catch (e: any) {
      log('presence:client', `register send failed: ${e?.message ?? e}`);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'presence.heartbeat' }));
      } catch (e: any) {
        log('presence:client', `heartbeat send failed: ${e?.message ?? e}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
    /* P0-N4: 不阻塞 event loop — 防 quit 时如果 dispose 异常没 clear, 主进程要等下一 tick (10s).
     *  心跳只在 app 跑时有意义, 关时 ws 也跟着死, 没必要让 timer 拦窗口关闭. */
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleMessage(data: Buffer | string): void {
    let text: string;
    if (typeof data === 'string') text = data;
    else text = data.toString('utf8');
    try {
      const msg = JSON.parse(text);
      if (msg?.method === 'presence.re_register_required') {
        log('presence:client', 'server requested re-register (TTL expired), resending');
        this.sendRegister();
        return;
      }
      if (msg?.method === 'relay.wake') {
        const reason = typeof msg?.params?.reason === 'string' ? msg.params.reason : 'server_request';
        log('presence:client', `relay.wake (${reason}) → 重拨中继`);
        try {
          this.cfg.onRelayWake?.(reason);
        } catch (e: any) {
          log('presence:client', `relay wake handler threw: ${e?.message ?? e}`);
        }
        return;
      }
      if (msg?.error) {
        log('presence:client', `server error: ${msg.error.code} ${msg.error.message}`);
        /* 401/40101 → token 死了, 主动断 + 让 reconnect 拿新 token */
        if (msg.error.code === 40101 || msg.error.code === 401) {
          this.ws?.close(4001, 'token_expired');
        }
        return;
      }
      /* 其余 server-initiated 消息 (presence.changed 等) 是给 mobile 看的, desktop 不关心.
       * desktop 不订阅自己, server 也不会推 changed 给注册者. */
    } catch {
      /* 非 JSON, 忽略 */
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.authDead) return;
    this.clearReconnect();
    const delay = this.reconnectDelayMs;
    log('presence:client', `reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
      void this.connect();
    }, delay);
    /* P0-N4: 不阻塞 event loop — quit 时挂的重连定时器要让主进程立刻走. */
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 解 JWT exp claim. 返当前距过期的秒数; 解失败返 null. */
  private tokenExpiresInSecs(): number | null {
    try {
      const parts = this.cfg.bearerJwt.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf8'));
      if (typeof payload?.exp !== 'number') return null;
      return payload.exp - Math.floor(Date.now() / 1000);
    } catch {
      return null;
    }
  }
}
