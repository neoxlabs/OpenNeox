/**
 * mobile-bridge/wsServer.ts — Mobile <-> Desktop HTTP + WS server
 *
 * 跟 内部设计文档 §3 严格对齐.
 *
 * 端点:
 *   - POST /api/v1/pair             (配对)
 *   - POST /api/v1/pair-by-code     (备份码配对)
 *   - GET  /api/v1/health           (健康检查, 不必 auth)
 *   - WSS  /api/v1/socket           (双向 WS, 需要 device_token + HMAC)
 *
 * 端口动态分配 (避免冲突). 默认只监听 127.0.0.1 — 明文 HTTP+WS 常年挂 0.0.0.0
 * 是 LAN 暴露面; 仅当用户显式发起配对 (start({allowLan:true}) / enableLan()) 才绑 0.0.0.0.
 *
 * Phase 1 范围: HTTP 明文 (LAN 内). HTTPS 自签证书留 Phase 1.D.
 */

import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { getCurrentUserId } from '@neoxlabs/platform/utils/config.js';
import { normalizeAgentMode } from '@neoxlabs/platform/runtime/agentMode.js';
import {
  consumePairingByQR,
  consumePairingByCode,
} from './pairing.js';
import {
  getPairedMobileById,
  getPairedMobileByToken,
  touchPairedMobile,
  getLastWsPort,
  saveLastWsPort,
  getDeviceId,
  getDeviceName,
} from './deviceStore.js';
import { verifyRequestSignatureWithKey } from './crypto.js';
import { JsonRpcDispatcher, parseRpcMessage, serializeRpcMessage, makeNotification, RpcError, RpcErrorCode } from './jsonRpc.js';
import { bridgeLog } from './log.js';
import { buildHistoryPage, slimPayloadForMobile } from './mobilePayloadSlim.js';
import { lookupFetchable } from './mobileArtifactPreview.js';
import { attachBinary } from '@neoxlabs/core/relay-transport/index.js';
import { ConnEvents, pickMostRecentConn } from './connEvents.js';
import { resolveNewSessionScope } from './newSessionWorkspace.js';
import {
  AttachmentError,
  beginUpload,
  appendUploadChunk,
  finishUpload,
  resolveIncomingAttachments,
  toDesktopAttachments,
} from './mobileAttachments.js';
import { PROTOCOL_VERSION } from './types.js';
import type { PairedMobile, RpcMessage } from './types.js';
import { stripRuntimeInjectedMarkers } from '../../shared/runtimeInjectedMarkers.js';
import { fileFetchChunkLength } from './fileFetchChunk.js';
import { resolveNewSessionModelId } from './newSessionModel.js';
import { ensureWorkspaceOpen } from './openWorkspace.js';
import { isOrphanSubAgentPlaceholder } from './sessionIndexUploader.js';
import { getMirroredRunState, onRunStatusChange } from './runStateMirror.js';
import {
  clearPendingActions,
  getPendingActions,
  removeApproval,
  removeAskUser,
  type PendingActionsSnapshot,
} from './pendingActionsRegistry.js';

const HEARTBEAT_INTERVAL_MS = 30000;
const TIMESTAMP_TOLERANCE_MS = 30000; // ±30s
const NONCE_TTL_MS = 5 * 60 * 1000; // 5min
const MAX_SEEN_NONCES = 10000;
const MAX_HTTP_JSON_BYTES = 16 * 1024;
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
/* file.fetch 单块大小按 transport 分 —— 云中转一封包就 16/9 倍, 见 fileFetchChunk.ts */
const MAX_DEVICE_ID_LEN = 128;
const MAX_DEVICE_TOKEN_LEN = 256;
const MAX_NONCE_LEN = 128;
const MAX_SIGNATURE_LEN = 128;
const MAX_TIMESTAMP_LEN = 32;
const MAX_SESSION_ID_LEN = 160;
const MAX_RPC_ID_LEN = 160;
const MAX_MODEL_ID_LEN = 256;
const MAX_WORKSPACE_PATH_LEN = 4096;
const MAX_SESSION_NAME_LEN = 120;
const MAX_USER_TEXT_LEN = 64 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_ASK_ANSWERS = 20;
const MAX_ASK_ANSWER_LEN = 8192;
const MAX_SESSION_LIST_LIMIT = 200;
const MAX_SESSION_HISTORY_LIMIT = 200;

async function buildPendingActionsSnapshot(sessionId: string): Promise<PendingActionsSnapshot> {
  const snapshot = getPendingActions(sessionId);
  const seenAskUserIds = new Set(snapshot.ask_user.map((a) => a.request_id));

  try {
    const storeMod: any = await import('@neoxlabs/core/runtime/store/PendingAskUserStore.js');
    const store = storeMod.getPendingAskUserStore?.();
    const records = store?.findBySession?.(sessionId) ?? [];
    for (const record of records) {
      const requestId = (record?.toolCallId ?? record?.tool_call_id ?? '') as string;
      if (!requestId || seenAskUserIds.has(requestId)) continue;
      snapshot.ask_user.push({
        request_id: requestId,
        questions: Array.isArray(record?.questions) ? record.questions : [],
        turn_id: null,
        created_at: typeof record?.createdAt === 'number' ? record.createdAt : Date.now(),
      });
      seenAskUserIds.add(requestId);
    }
  } catch (e: any) {
    console.warn('[mobile-bridge] subscribe: load pending ask_user failed', e?.message);
  }

  return snapshot;
}

/** Transport-agnostic 客户端连接抽象.
 *
 *   过去 conn 跟 WebSocket 强绑定 (ws.send 写 wire). M4 Mode B 引入云中转客户端后,
 *   conn 也可能是"虚拟 conn" — 没有真 ws, sendRaw 走加密 envelope 通过 cloud-relay
 *   client 转发. 抽象 send 接口让上层 broadcast / pushToSession 等代码不关心 transport.
 *
 *   readyState/OPEN 跟 deviceId 也抽象, 方便检查在线状态.
 */
type ConnTransport = 'lan' | 'cloud';

interface MobileConn {
  transport: ConnTransport;
  /** LAN 真 ws conn; cloud 虚拟 conn 此字段为 null */
  ws: WebSocket | null;
  mobile: PairedMobile;
  subscribedSessionIds: Set<string>;
  lastPingAt: number;
  lastPongAt: number;
  /** 手机报的前后台 (device.presence): 此刻在不在前台、最近一次切到前台的时间 —— Pilot 来电只响你最近打开的那台 */
  foreground?: boolean;
  foregroundAt?: number;
  /** 是否还能写 — LAN 看 ws.readyState, cloud 看 cloudClient.isConnected */
  isOpen(): boolean;
  framesActive?(): boolean; /* 云中转已跟这台手机协商到 v2 帧 (大回包自动分片) */
  /** 串行 send. caller 已 JSON.stringify 好 (broadcastToAllConns 复用同 payload buffer). */
  sendRaw(payload: string): void;
}

/** 用过的 nonce 去重表 — 防 replay 攻击 */
const seenNonces = new Map<string, number>(); // nonce → expire_at

function gcNonces(): void {
  const now = Date.now();
  for (const [k, v] of seenNonces) {
    if (v <= now) seenNonces.delete(k);
  }
}

function rememberNonce(nonce: string, expiresAt: number): void {
  seenNonces.set(nonce, expiresAt);
  while (seenNonces.size > MAX_SEEN_NONCES) {
    const oldest = seenNonces.keys().next().value;
    if (!oldest) break;
    seenNonces.delete(oldest);
  }
}

function readBoundedHeader(value: string | string[] | undefined, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > maxLen) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function requireBoundedString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== 'string') {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${name} required`);
  }
  if (value.length === 0 || value.length > maxLen) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${name} length invalid`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${name} contains control characters`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, `${name} required`);
  }
  return trimmed;
}

function optionalBoundedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > maxLen) {
    throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'string length invalid');
  }
  const trimmed = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampRpcLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), max));
}

function clampBeforeSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER));
}

export class MobileBridgeServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private dispatcher = new JsonRpcDispatcher<MobileConn>();
  private conns = new Set<MobileConn>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** mirrorPolicy 内存缓存 — push 热路径 (每 token delta 一次) 禁止逐帧 async
   *  loadSession: 首帧走盘、后帧走 cache 时 resolve 次序会反, 手机端 delta 乱序拼字。
   *  写入口只有 session.set_mirror RPC, subscribe/delete 时同步维护。 */
  private mirrorPolicyCache = new Map<string, 'always' | 'manual' | 'never'>();
  /** cache miss 期间排队的已序列化 frames — policy 载入后按到达序 flush (保序不漏推). */
  private actualPort = 0;
  /** 当前是否绑在 0.0.0.0 (LAN 可达). 默认 loopback, 用户显式配对时才升级. */
  private lanBound = false;

  constructor() {
    this.registerCoreMethods();
    /* 会话运行态翻转 → 告诉所有连着的手机 (电脑页「正在跑」/ 侧栏「等你」靠它, 不用逐条订阅) */
    onRunStatusChange((sessionId, status) => {
      this.broadcastToAllConns(makeNotification('session.run_status', { session_id: sessionId, status }));
    });
  }

  /** 启动 server, 返实际监听 port.
   *  allowLan 默认 false → 只绑 127.0.0.1: app 启动即监听, 明文 HTTP/WS 不该
   *  未经用户动作就暴露到局域网. 显式发起配对的路径再 enableLan() 升级. */
  async start(opts?: { allowLan?: boolean }): Promise<number> {
    if (this.httpServer) throw new Error('mobile-bridge server already started');
    this.lanBound = opts?.allowLan === true;
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
    /* WS upgrade — 路径必须是 /api/v1/socket */
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/v1/socket') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      void (async () => {
        let authResult = this.authenticateWsUpgrade(req);
        if (!authResult.ok && this.shouldTryOnDemandPair(req)) {
          const { ensureMobilePairedOnDemand } = await import('./autoPairPoller.js');
          const paired = await ensureMobilePairedOnDemand(
            String(req.headers['x-neox-device-id'] ?? ''),
          );
          if (paired) authResult = this.authenticateWsUpgrade(req);
        }
        if (!authResult.ok) {
          socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n${authResult.error}`);
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.attachWsConnection(ws, (authResult as { ok: true; mobile: PairedMobile }).mobile);
        });
      })();
    });
    const host = this.lanBound ? '0.0.0.0' : '127.0.0.1';
    const preferredPort = getLastWsPort();
    return new Promise<number>((resolve, reject) => {
      const tryListen = (port: number, onFail: ((err: NodeJS.ErrnoException) => void) | null): void => {
        const errorHandler = (err: NodeJS.ErrnoException): void => {
          if (onFail) {
            this.httpServer!.removeListener('error', errorHandler);
            onFail(err);
          } else {
            reject(err);
          }
        };
        this.httpServer!.once('error', errorHandler);
        this.httpServer!.listen(port, host, () => {
          this.httpServer!.removeListener('error', errorHandler);
          const addr = this.httpServer!.address();
          if (addr && typeof addr === 'object') {
            this.actualPort = addr.port;
            saveLastWsPort(this.actualPort);
            this.startHeartbeat();
            // eslint-disable-next-line no-console
            console.log(`[mobile-bridge] WS server listening on ${host}:${this.actualPort}${port !== 0 ? ' (reused last port)' : ''}`);
            resolve(this.actualPort);
          } else {
            reject(new Error('failed to get server address'));
          }
        });
      };
      if (preferredPort && preferredPort > 0) {
        tryListen(preferredPort, (err) => {
          // eslint-disable-next-line no-console
          console.warn(`[mobile-bridge] last port ${preferredPort} unavailable (${err.code}), falling back to dynamic`);
          tryListen(0, null);
        });
      } else {
        tryListen(0, null);
      }
    });
  }

  /** 当前是否 LAN 可达 (绑 0.0.0.0). */
  isLanBound(): boolean { return this.lanBound; }

  /**
   * 升级监听到 0.0.0.0 — 只在用户显式发起配对时调 (ipcHandlers start-pairing).
   * 优先同 port 重绑, 已配对 phone 存的 host:port 不失效; port 被抢时回落动态分配
   * (新 QR 编的是重绑后的 port, 配对仍可走通). 已绑 LAN 时 no-op.
   * loopback 阶段不可能有 LAN 连接, 关 listener 不丢任何 mobile conn (cloud 虚拟 conn 不走本 server).
   */
  async enableLan(): Promise<number> {
    if (!this.httpServer) throw new Error('mobile-bridge server not started');
    if (this.lanBound) return this.actualPort;
    const server = this.httpServer;
    const port = this.actualPort;
    /* 先释放 loopback listener. close callback 要等存量连接清空 (loopback 阶段正常 0 条),
     * 兜底 1.5s 超时继续 — 跟 stop() 的两阶段关闭同款防卡策略. */
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 1500);
      t.unref?.();
      server.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      });
    });
    return new Promise<number>((resolve, reject) => {
      const tryListen = (p: number, onFail: ((err: NodeJS.ErrnoException) => void) | null): void => {
        const errorHandler = (err: NodeJS.ErrnoException): void => {
          server.removeListener('error', errorHandler);
          if (onFail) onFail(err);
          else reject(err);
        };
        server.once('error', errorHandler);
        server.listen(p, '0.0.0.0', () => {
          server.removeListener('error', errorHandler);
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            this.actualPort = addr.port;
            saveLastWsPort(this.actualPort);
            this.lanBound = true;
            // eslint-disable-next-line no-console
            console.log(`[mobile-bridge] listener upgraded to 0.0.0.0:${this.actualPort} (user-initiated pairing)`);
            resolve(this.actualPort);
          } else {
            reject(new Error('failed to get server address after LAN rebind'));
          }
        });
      };
      tryListen(port, (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[mobile-bridge] LAN rebind on port ${port} failed (${err.code}), falling back to dynamic`);
        tryListen(0, null);
      });
    });
  }

  async disableLan(): Promise<void> {
    if (!this.httpServer || !this.lanBound) return;
    const server = this.httpServer;
    const port = this.actualPort;
    /* 走到这里说明"没有任何已配对设备", 那么现存的 LAN 连接都不是可信设备,
     * 断掉正是我们要的结果 —— 不是误伤。 */
    for (const c of this.conns) {
      if (c.transport === 'lan' && c.ws) {
        try { c.ws.close(1001, 'LAN access disabled'); } catch { /* ignore */ }
      }
    }
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 1500);
      t.unref?.();
      server.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        /* 重绑 loopback 失败是最坏情况: listener 彻底没了, 手机功能不可用,
         * 但**没有留下 LAN 暴露面** —— 这个方向的失败是安全的, 记一条日志即可。 */
        // eslint-disable-next-line no-console
        console.warn(`[mobile-bridge] loopback rebind failed (${err.code}); listener is down`);
        this.lanBound = false;
        resolve();
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') this.actualPort = addr.port;
        this.lanBound = false;
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] listener downgraded to 127.0.0.1:${this.actualPort} (no paired devices)`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const c of this.conns) {
      if (c.transport === 'lan' && c.ws) {
        const ws = c.ws;
        try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
      }
    }
    const closeWithTimeout = (label: string, fn: (cb: () => void) => void, timeoutMs: number): Promise<void> =>
      new Promise<void>((resolve) => {
        let settled = false;
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          // eslint-disable-next-line no-console
          console.warn(`[mobile-bridge] ${label}.close timeout ${timeoutMs}ms, forcing exit`);
          /* 仍未关闭 — 把残留 ws 强 terminate, 让 server.close 的等待解除 */
          for (const c of this.conns) {
            if (c.transport === 'lan' && c.ws) {
              try { c.ws.terminate(); } catch { /* ignore */ }
            }
          }
          resolve();
        }, timeoutMs);
        t.unref?.();
        fn(() => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve();
        });
      });

    if (this.wss) {
      await closeWithTimeout('wss', (cb) => this.wss!.close(cb), 1500);
      this.wss = null;
    }
    this.conns.clear();
    if (this.httpServer) {
      await closeWithTimeout('httpServer', (cb) => this.httpServer!.close(cb), 1500);
      this.httpServer = null;
    }
    this.actualPort = 0;
  }

  getPort(): number { return this.actualPort; }
  getDispatcher(): JsonRpcDispatcher<MobileConn> { return this.dispatcher; }
  listConns(): MobileConn[] { return Array.from(this.conns); }

  /** M4 Mode B — 让 cloud-relay client 注册一条 "虚拟 conn" (没真 ws, sendRaw 走加密
   *  envelope 经 cloudClient 发回 mobile). dispatcher 同款 handler 处理, 透明. */
  registerCloudConn(opts: {
    mobile: PairedMobile;
    isOpen: () => boolean;
    framesActive?: () => boolean;
    sendRaw: (payload: string) => void;
  }): MobileConn {
    const conn: MobileConn = {
      transport: 'cloud',
      ws: null,
      mobile: opts.mobile,
      subscribedSessionIds: new Set(),
      lastPingAt: 0,
      lastPongAt: Date.now(),
      isOpen: opts.isOpen,
      framesActive: opts.framesActive,
      sendRaw: opts.sendRaw,
    };
    this.conns.add(conn);
    this.emitConnOpened(conn);
    return conn;
  }

  unregisterCloudConn(conn: MobileConn): void {
    this.conns.delete(conn);
    this.emitConnClosed();
  }

  /* 手机连上 / 断开的订阅 (Pilot 来电), 见 connEvents.ts */
  private readonly connEvents = new ConnEvents<MobileConn>();
  onConnClosed(fn: () => void): () => void { return this.connEvents.onClosed(fn); }
  onConnOpened(fn: (conn: MobileConn) => void): () => void { return this.connEvents.onOpened(fn); }
  private emitConnClosed(): void { this.connEvents.emitClosed(); }
  private emitConnOpened(conn: MobileConn): void { this.connEvents.emitOpened(conn); }

  /**
   * 推 notification 给所有连接的某 device. 一台 device 可能多连接 (并发).
   */
  pushToDevice(deviceId: string, msg: RpcMessage): void {
    const payload = serializeRpcMessage(msg);
    for (const c of this.conns) {
      if (c.mobile.device_id === deviceId && c.isOpen()) {
        try { c.sendRaw(payload); } catch { /* ignore */ }
      }
    }
  }

  pushToSessionSubscribers(sessionId: string, msg: RpcMessage): void {
    this.sendToSessionSubscribers(sessionId, serializeRpcMessage(msg));
  }

  private sendToSessionSubscribers(sessionId: string, payload: string): void {
    for (const c of this.conns) {
      if (c.subscribedSessionIds.has(sessionId) && c.isOpen()) {
        try { c.sendRaw(payload); } catch { /* ignore */ }
      }
    }
  }

  /** set_mirror / delete 等入口同步维护 policy 缓存. */
  setMirrorPolicyCache(sessionId: string, policy: 'always' | 'manual' | 'never'): void {
    this.mirrorPolicyCache.set(sessionId, policy);
  }

  evictMirrorPolicyCache(sessionId: string): void {
    this.mirrorPolicyCache.delete(sessionId);
  }

  /** 广播给所有已连接的 conn — 不关心是否订阅了具体 session.
   *
   *   用于 session lifecycle: 新建 session / 删除 session 时, phone 还没机会 subscribe
   *   到这条新 id, 用 pushToSessionSubscribers 永远是 0 命中. broadcast 给所有 phone,
   *   各自的 ws_client_provider 收到后落 drift session_mirror 触发 UI 刷. */
  broadcastToAllConns(msg: RpcMessage, except?: MobileConn): void {
    const payload = serializeRpcMessage(msg);
    for (const c of this.conns) {
      if (c !== except && c.isOpen()) {
        try { c.sendRaw(payload); } catch { /* ignore */ }
      }
    }
  }

  /** 连着的手机里你最近打开的那台 —— 来电只响它 (见 connEvents.ts) */
  mostRecentConn(): MobileConn | null { return pickMostRecentConn(this.conns); }

  /** 手机报前后台 (device.presence) */
  setConnPresence(conn: MobileConn, foreground: boolean): void {
    conn.foreground = foreground;
    if (foreground) conn.foregroundAt = Date.now();
  }

  /** 现在连着几台手机 —— Pilot 来电要知道能不能打到手机上 */
  openConnCount(): number {
    let n = 0;
    for (const c of this.conns) if (c.isOpen()) n++;
    return n;
  }

  /** 注册业务方法 (外部调用) */
  registerMethod(name: string, handler: (params: any, conn: MobileConn) => Promise<any> | any): void {
    this.dispatcher.register(name, handler);
  }

  /* ─────────────── 私有 ─────────────── */

  /** HTTP 请求路由 */
  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/api/v1/health') {
      /* device_id/name 本来就在 mDNS 广播里公开 — 这里补上是给"手动地址"
       * 配对路径用 (SSH 隧道中转 / mDNS 不可达网络), phone 没有 beacon 时
       * 靠 health 拿桌面标识再走 pair-by-code. */
      this.sendJson(res, 200, {
        status: 'ok',
        protocol_version: PROTOCOL_VERSION,
        device_id: getDeviceId(),
        device_name: getDeviceName(),
      });
      return;
    }
    /* 扫码 / 备份码 / 同一 WiFi 点一下 (电脑弹窗确认, pairRequest.ts) */
    const pairRoute = req.method !== 'POST' ? undefined : ({
      '/api/v1/pair': async (b: any) => { const r = await consumePairingByQR(b); return r.ok ? { status: 200, body: r.response } : { status: 400, body: { error: r.error } }; },
      '/api/v1/pair-by-code': async (b: any) => { const r = await consumePairingByCode(b); return r.ok ? { status: 200, body: r.response } : { status: 400, body: { error: r.error } }; },
      '/api/v1/pair-request': async (b: any) => (await import('./pairRequest.js')).handlePairRequest(b, undefined, res),
    } as Record<string, (b: unknown) => Promise<{ status: number; body: unknown }>>)[req.url ?? ''];
    if (pairRoute) {
      void this.readJson(req).then(pairRoute).then((r) => this.sendJson(res, r.status, r.body))
        .catch((e) => this.sendJson(res, 400, { error: e?.message ?? String(e) }));
      return;
    }
    /* unknown */
    this.sendJson(res, 404, { error: 'not found' });
  }

  private sendJson(res: http.ServerResponse, code: number, body: any): void {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*', // LAN 内 CORS 简单放行
    });
    res.end(JSON.stringify(body));
  }

  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_JSON_BYTES) {
      throw new Error('request body too large');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_HTTP_JSON_BYTES) {
        throw new Error('request body too large');
      }
      chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    if (!text) return {};
    return JSON.parse(text);
  }

  /** WS upgrade 时校验 headers (按 protocol §3.2) */
  private shouldTryOnDemandPair(req: http.IncomingMessage): boolean {
    const id = String(req.headers['x-neox-device-id'] ?? '').trim();
    const token = String(req.headers['x-neox-device-token'] ?? '').trim();
    return id.length > 0 && id.length <= 128 && token === `account:${id}`;
  }

  private authenticateWsUpgrade(req: http.IncomingMessage): { ok: true; mobile: PairedMobile } | { ok: false; error: string } {
    const deviceId = readBoundedHeader(req.headers['x-neox-device-id'], MAX_DEVICE_ID_LEN);
    const deviceToken = readBoundedHeader(req.headers['x-neox-device-token'], MAX_DEVICE_TOKEN_LEN);
    const protoVer = readBoundedHeader(req.headers['x-neox-protocol-version'], 8);
    const signature = readBoundedHeader(req.headers['x-neox-signature'], MAX_SIGNATURE_LEN);
    const tsStr = readBoundedHeader(req.headers['x-neox-timestamp'], MAX_TIMESTAMP_LEN);
    const nonce = readBoundedHeader(req.headers['x-neox-nonce'], MAX_NONCE_LEN);

    if (!deviceId || !deviceToken || !signature || !tsStr || !nonce) {
      return { ok: false, error: 'missing auth headers' };
    }
    if (protoVer !== String(PROTOCOL_VERSION)) {
      return { ok: false, error: `protocol version mismatch (server: ${PROTOCOL_VERSION})` };
    }
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return { ok: false, error: 'invalid timestamp' };
    const now = Date.now();
    if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_MS) {
      return { ok: false, error: `timestamp out of tolerance (±${TIMESTAMP_TOLERANCE_MS}ms)` };
    }
    /* nonce 去重 */
    gcNonces();
    if (seenNonces.has(nonce)) {
      return { ok: false, error: 'nonce reused (replay attack?)' };
    }
    const currentUserId = getCurrentUserId();
    const isAccountPaired = deviceToken.startsWith('account:');
    let mobile: PairedMobile | null;
    let signingKey: Buffer | string;

    if (isAccountPaired) {
      mobile = getPairedMobileById(deviceId, { currentUserId });
      if (!mobile) return { ok: false, error: 'device not paired for current user' };
      /* token 必须正是这条记录自己的 `account:<deviceId>` — 防止拿 A 的 deviceId
       * 配 B 的 token 蒙混; 同时排除"扫码配对的记录被 account token 命中"。 */
      if (mobile.device_token !== deviceToken) {
        return { ok: false, error: 'device_token mismatch' };
      }
      if (!mobile.relay_session_key_b64) {
        /* account 配对却没有派生密钥 = 配对记录不完整, 没有任何可验证的凭据。
         * 不能放行 —— 放行就等于只凭一个公开的 deviceId 就能连上这台电脑。 */
        return { ok: false, error: 'account pairing missing derived key — re-pair required' };
      }
      signingKey = Buffer.from(mobile.relay_session_key_b64, 'base64');
    } else {
      mobile = getPairedMobileByToken(deviceToken, { currentUserId });
      if (!mobile) return { ok: false, error: 'device_token not paired for current user' };
      if (mobile.device_id !== deviceId) return { ok: false, error: 'device_id mismatch' };
      signingKey = deviceToken;
    }

    if (!verifyRequestSignatureWithKey(signingKey, ts, nonce, signature)) {
      return { ok: false, error: 'signature invalid' };
    }
    rememberNonce(nonce, now + NONCE_TTL_MS);
    return { ok: true, mobile };
  }

  private attachWsConnection(ws: WebSocket, mobile: PairedMobile): void {
    const conn: MobileConn = {
      transport: 'lan',
      ws,
      mobile,
      subscribedSessionIds: new Set(),
      lastPingAt: 0,
      lastPongAt: Date.now(),
      isOpen() { return ws.readyState === ws.OPEN; },
      sendRaw(payload: string) { ws.send(payload); },
    };
    this.conns.add(conn);
    this.emitConnOpened(conn);
    touchPairedMobile(mobile.device_id, { currentUserId: getCurrentUserId() });
    // eslint-disable-next-line no-console
    console.log(`[mobile-bridge] WS connected: ${mobile.device_name} (${mobile.device_id})`);

    ws.on('message', (raw) => {
      const msg = parseRpcMessage(raw as Buffer);
      if (!msg) {
        try { ws.send(serializeRpcMessage({ jsonrpc: '2.0', id: '', error: { code: -32700, message: 'Parse error' } })); }
        catch { /* ignore */ }
        return;
      }
      void this.dispatcher.handle(msg, conn).then((reply) => {
        if (reply) {
          try { ws.send(serializeRpcMessage(reply)); } catch { /* ignore */ }
        }
      });
    });

    ws.on('pong', () => {
      conn.lastPongAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      // eslint-disable-next-line no-console
      console.log(`[mobile-bridge] WS closed: ${mobile.device_name} (${code} ${reason?.toString() ?? ''})`);
      this.conns.delete(conn);
      this.emitConnClosed();
    });

    ws.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[mobile-bridge] WS error from ${mobile.device_name}:`, err.message);
    });

    /* 连上后立即推 snapshot — 真拉 sessionStore.listSessions, 让 Phone 立刻看到列表 */
    void (async () => {
      try {
        const snapshot = await listSessions(100);
        if (ws.readyState !== ws.OPEN) return;
        ws.send(serializeRpcMessage(makeNotification('session.snapshot', snapshot)));
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[mobile-bridge] initial snapshot failed:', e?.message);
        try {
          ws.send(serializeRpcMessage(makeNotification('session.snapshot', {
            sessions: [],
            total: 0,
            has_more: false,
            complete: false,
            limit: 100,
          })));
        } catch { /* ignore */ }
      }
    })();
  }

  /** 心跳: 每 30s ping 一次, 60s 没 pong 就断 — LAN ws only (cloud conn 心跳由 cloud client 管). */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const c of this.conns) {
        if (c.transport !== 'lan' || !c.ws) continue;
        const ws = c.ws;
        if (ws.readyState !== ws.OPEN) continue;
        if (now - c.lastPongAt > HEARTBEAT_INTERVAL_MS * 2) {
          /* dead */
          try { ws.terminate(); } catch { /* ignore */ }
          this.conns.delete(c);
          this.emitConnClosed();
          continue;
        }
        try {
          ws.ping();
          c.lastPingAt = now;
        } catch { /* ignore */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** 注册协议规范定义的核心 RPC methods (subscribe / input / list / history / pong) */
  private registerCoreMethods(): void {
    /* session.subscribe — Phone projector attach(sessionId):
     *   - latest_seq: EntryLog cursor (SessionContext)
     *   - run_state: ExecutionState snapshot = max(updated_at)(runStateMirror, sessionStore)
     *   Live run_state_changed / agent_turn_done are best-effort; attach snapshot is
     *   the authoritative re-attach path (same role as desktop execution-state). */
    this.dispatcher.register('session.subscribe', async (params, conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      conn.subscribedSessionIds.add(sessionId);
      const latest = await getLatestSeq(sessionId);
      const mirrorMod = await import('./runStateMirror.js');
      let fromStore: ReturnType<typeof mirrorMod.normalizeRunState> = null;
      try {
        const storeMod: any = await import('@neoxlabs/core/platform/sessionStore.js');
        const s = await storeMod.sessionStore.loadSession(sessionId);
        /* subscribe 顺手回填 policy 缓存 — push 热路径同步判定不再逐帧查盘 */
        const p = s?.mirrorPolicy;
        this.setMirrorPolicyCache(sessionId, p === 'never' || p === 'manual' ? p : 'always');
        if (s?.runState) {
          fromStore = mirrorMod.normalizeRunState({
            status: s.runState.status ?? 'idle',
            turn_id: s.runState.turnId ?? null,
            last_committed_seq: s.runState.lastCommittedSeq ?? null,
            pending_tool_calls: s.runState.pendingToolCalls ?? [],
            initiated_by: s.runState.initiatedBy ?? null,
            paused_at: s.runState.pausedAt ?? null,
            updated_at: s.runState.updatedAt ?? null,
          });
        }
      } catch (e: any) {
        console.warn('[mobile-bridge] subscribe: load runState failed', e?.message);
      }
      const runState =
        mirrorMod.mergeRunStateForSubscribe(
          mirrorMod.getMirroredRunState(sessionId),
          fromStore,
        ) ?? {
          status: 'idle',
          turn_id: null,
          last_committed_seq: null,
          pending_tool_calls: [],
          initiated_by: null,
          paused_at: null,
          updated_at: Date.now(),
        };
      const pendingActions = await buildPendingActionsSnapshot(sessionId);
      /* v1.1 — plan / 活跃子代理快照, phone 断线重连一次性恢复 (streaming 是 best-effort) */
      const uiStateMod = await import('./sessionUiStateRegistry.js');
      const uiState = {
        plan: uiStateMod.getPlan(sessionId),
        active_subagents: uiStateMod.getActiveSubagents(sessionId),
      };
      /* v1.3 — mid-stream attach: 本轮已流出但未落 drift 的半成品 (正文/思考/在跑工具).
       *   必须先 flush 排队 delta 再取快照 — 快照含累积全文, 排队 delta 若在快照后
       *   重放, phone 端会重复拼接。语义: phone 用它 REPLACE 本轮 streaming buffer. */
      const fwdMod = await import('./agentStreamForwarder.js');
      fwdMod.flushPendingDeltas(sessionId);
      const streamingState = fwdMod.getLiveStreamingSnapshot(sessionId);
      /* 通知 Desktop renderer "mobile 当前正在看这条 session" — 让桌面联动跳到同一条
       *   (renderer 自行决定要不要 honor: 用户可能想各看各的). */
      const { notifyDesktopMobileActiveSession } = await import('./index.js');
      notifyDesktopMobileActiveSession(sessionId);
      /* 这三块跟 history 一样要过中转 256KB 的线: 半途 attach 时 streaming_state 里是本轮
       * 已流出的全文 + 在跑工具的完整参数, 一个 write_file 就能把它顶过线 —— 历史页瘦了它没瘦,
       * 进会话第一步就断, 看起来就是「这个会话加载不出来」。 */
      return slimPayloadForMobile({
        ok: true,
        latest_seq: latest,
        run_state: runState,
        pending_actions: pendingActions,
        ui_state: uiState,
        streaming_state: streamingState,
      });
    });

    /* session.input — Phone 发用户输入 / 控制指令
     *   kind 路由:
     *     user_message    → injectUserMessage (写 SessionContext + 触发 agent loop)
     *     control:approve / control:reject → AgentBridge.replyPermission (审批回应)
     *     control:ask_user_reply → AgentBridge.replyAskUser (agent 追问回应)
     *     control:pause   → AgentBridge.pauseSession (暂停所有 worker)
     *     control:stop_agent → client.abortSubAgent (只停 payload.agent_id 那一个子 agent)
     *     control:compact → AgentBridge.compactSession (手动压缩上下文)
     *     control:cancel  → AgentBridge.interruptSession (abort 当前 run)
     *     control:retry   → 用上一轮 user prompt 重跑 (对齐桌面 ErrorView「重试」)
     *     control:switch_model → session.update-model (Phone 直接走 session.update-model RPC) */
    this.dispatcher.register('session.input', async (params, conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const kind = requireBoundedString(params?.kind, 'kind', 64);
      if (kind === 'user_message') {
        const text: string = typeof params.payload?.text === 'string' ? params.payload.text : '';
        if (text.length > MAX_USER_TEXT_LEN) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, `payload.text too large (max ${MAX_USER_TEXT_LEN})`);
        }
        const rawAttachmentsAll = Array.isArray(params.payload?.attachments) ? params.payload.attachments : [];
        if (rawAttachmentsAll.length > MAX_ATTACHMENTS) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, `too many attachments (max ${MAX_ATTACHMENTS})`);
        }
        const rawAttachments = rawAttachmentsAll.slice(0, MAX_ATTACHMENTS);
        if (!text && rawAttachments.length === 0) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'payload.text or attachments required');
        }
        const approvalMode = typeof params.payload?.approval_mode === 'string'
          ? params.payload.approval_mode
          : undefined;
        const chatMode = params.payload?.chat_mode === true;
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] session.input user_message session=${sessionId.slice(0,16)}… text="${text.slice(0,30)}…" attach=${rawAttachments.length} mode=${approvalMode ?? '-'} deviceId=${conn?.mobile?.device_id?.slice(0, 16)}`);
        try {
          const seq = await injectUserMessage(
            sessionId,
            text,
            conn?.mobile?.device_id,
            rawAttachments,
            approvalMode,
            chatMode,
          );
          // eslint-disable-next-line no-console
          console.log(`[mobile-bridge] injectUserMessage ok, userSeq=${seq}`);
          return { ok: true, seq };
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.error(`[mobile-bridge] injectUserMessage failed:`, e?.message ?? e, e?.stack);
          if (e instanceof AttachmentError) throw new RpcError(RpcErrorCode.INVALID_PARAMS, e.message);
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, `inject failed: ${e?.message ?? e}`);
        }
      }
      if (kind === 'control:approve' || kind === 'control:reject') {
        const requestId = requireBoundedString(
          params.payload?.request_id ?? params.payload?.requestId,
          'payload.request_id',
          MAX_RPC_ID_LEN,
        );
        const remember = params.payload?.remember === true;
        const bridge = await getAgentBridgeForSession(sessionId);
        if (!bridge) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no AgentBridge for session workspace');
        }
        const approved = kind === 'control:approve';
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] approval reply: session=${sessionId.slice(0,16)} req=${requestId.slice(0,16)} approved=${approved} remember=${remember}`);
        await bridge.replyPermission(requestId, approved, remember);
        removeApproval(sessionId, requestId);
        return { ok: true };
      }
      if (kind === 'control:ask_user_reply') {
        const requestId = requireBoundedString(
          params.payload?.request_id ?? params.payload?.requestId,
          'payload.request_id',
          MAX_RPC_ID_LEN,
        );
        const rawAnswers = params.payload?.answers;
        if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'payload.answers object required for ask_user reply');
        }
        const entries = Object.entries(rawAnswers);
        if (entries.length > MAX_ASK_ANSWERS) {
          throw new RpcError(RpcErrorCode.INVALID_PARAMS, `too many answers (max ${MAX_ASK_ANSWERS})`);
        }
        const answers: Record<string, string> = Object.create(null);
        for (const [key, value] of entries) {
          if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
          if (key.length > MAX_RPC_ID_LEN) {
            throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'answer key too long');
          }
          const answer = typeof value === 'string' ? value : String(value ?? '');
          if (answer.length > MAX_ASK_ANSWER_LEN) {
            throw new RpcError(RpcErrorCode.INVALID_PARAMS, `answer too large (max ${MAX_ASK_ANSWER_LEN})`);
          }
          answers[key] = answer;
        }
        const bridge = await getAgentBridgeForSession(sessionId);
        const client = bridge && typeof bridge.getClientAsync === 'function'
          ? await bridge.getClientAsync()
          : null;
        if (!client || typeof client.replyAskUser !== 'function') {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no ask_user handler for session workspace');
        }
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] ask_user reply: session=${sessionId.slice(0,16)} req=${requestId.slice(0,16)} answers=${Object.keys(answers).length}`);
        const result = await client.replyAskUser(requestId, answers);
        removeAskUser(sessionId, requestId);
        return { ok: true, ...(result ?? {}) };
      }
      /* control:stop_agent — 停掉**单个**后台子 agent (payload.agent_id).
       * 手机长按子 agent 痕迹 → "停掉这个 agent"。跟桌面 SubAgentsBar 的停止按钮
       * 同一条通路 (runtime:abort-sub-agent → client.abortSubAgent →
       * BackgroundAgentManager.abort), 不是 control:cancel 那种整会话级中断。 */
      if (kind === 'control:stop_agent') {
        const agentId = requireBoundedString(
          params?.payload?.agent_id,
          'agent_id',
          MAX_SESSION_ID_LEN,
        );
        const bridge = await getAgentBridgeForSession(sessionId);
        const client = bridge && typeof bridge.getClientAsync === 'function'
          ? await bridge.getClientAsync()
          : null;
        if (!client || typeof (client as any).abortSubAgent !== 'function') {
          throw new RpcError(
            RpcErrorCode.INTERNAL_ERROR,
            'no abortSubAgent handler for session workspace',
          );
        }
        const result = await (client as any).abortSubAgent(agentId);
        bridgeLog('stopAgent', `session=${sessionId.slice(0, 16)} agent=${agentId} ok=${result?.ok === true}`);
        return { ok: result?.ok === true };
      }
      /* control:compact — 手动压缩上下文 (手机 [+] 菜单里的"压缩上下文")。
       * 走 AgentBridge.compactSession, 与桌面 composer 的压缩按钮同一条通路。
       * 压缩结果经 context_compaction 事件推回手机 timeline 显示"已压缩 · 省 N tokens"。 */
      if (kind === 'control:compact') {
        const bridge = await getAgentBridgeForSession(sessionId);
        if (!bridge || typeof bridge.compactSession !== 'function') {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no AgentBridge for session workspace');
        }
        bridgeLog('compact', `session=${sessionId.slice(0, 16)} (async)`);
        const { pushStreamEvent } = await import('./agentStreamForwarder.js');
        const storeMod2: any = await import('@neoxlabs/core/platform/sessionStore.js');
        const readUsed = async (): Promise<number> => {
          try {
            const sess = await storeMod2.sessionStore.loadSession(sessionId);
            const n = sess?.contextUsed ?? sess?.totalTokens ?? 0;
            return typeof n === 'number' ? n : 0;
          } catch { return 0; }
        };
        const before = await readUsed();
        pushStreamEvent(sessionId, 'context_compaction', { status: 'running' });
        void bridge.compactSession(sessionId).then(async () => {
          const after = await readUsed();
          bridgeLog('compact', `done session=${sessionId.slice(0, 16)} ${before} → ${after}`);
          pushStreamEvent(sessionId, 'context_compaction', {
            status: 'completed',
            original_tokens: before,
            final_tokens: after,
          });
        }).catch((err: any) => {
          bridgeLog('compact', `failed session=${sessionId.slice(0, 16)}: ${err?.message ?? err}`);
          /* 失败也要收口那条转圈的线, 否则它会一直转 */
          pushStreamEvent(sessionId, 'context_compaction', {
            status: 'completed',
            original_tokens: before,
            final_tokens: before,
          });
        });
        return { ok: true, started: true };
      }
      if (kind === 'control:pause') {
        const bridge = await getAgentBridgeForSession(sessionId);
        if (!bridge) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no AgentBridge for session workspace');
        }
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] pause: session=${sessionId.slice(0,16)}`);
        const result = await bridge.pauseSession(sessionId);
        return { ok: true, ...result };
      }
      if (kind === 'control:resume') {
        /* M2 接力 — paused 状态恢复; server 端会切 running 状态 + 触发 chat 续 */
        const bridge = await getAgentBridgeForSession(sessionId);
        if (!bridge) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no AgentBridge for session workspace');
        }
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] resume: session=${sessionId.slice(0,16)} from device=${conn?.mobile?.device_id?.slice(0, 16)}`);
        const result = await bridge.resumeSession(sessionId);
        return { ok: true, ...result };
      }
      if (kind === 'control:takeover') {
        /* M2 接力 — 显式宣告 "本设备接管此 session" 后续 user 输入 initiatedBy=mobile-{deviceId}.
         * 不动 runState status (running 不会因 takeover 变 paused), 只更新 initiatedBy 标签.
         * 客户端展示用 — 让用户知道是谁在主导. */
        const newInitiator = conn?.mobile?.device_id ? `mobile-${conn.mobile.device_id.slice(0, 16)}` : 'mobile';
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] takeover: session=${sessionId.slice(0,16)} → ${newInitiator}`);
        /* 持久化 initiatedBy 到 sessionStore — 下次 chat() 会从这里读 */
        try {
          const storeMod: any = await import('@neoxlabs/core/platform/sessionStore.js');
          const session = await storeMod.sessionStore.loadSession(sessionId);
          if (session) {
            session.runState = {
              ...(session.runState ?? {}),
              status: session.runState?.status ?? 'idle',
              initiatedBy: newInitiator,
              updatedAt: Date.now(),
            };
            await storeMod.sessionStore.saveSessionMetadata(session);
          }
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn(`[mobile-bridge] takeover persist failed: ${e?.message}`);
        }
        return { ok: true, initiatedBy: newInitiator };
      }
      if (kind === 'control:cancel') {
        const bridge = await getAgentBridgeForSession(sessionId);
        if (!bridge) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'no AgentBridge for session workspace');
        }
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] cancel: session=${sessionId.slice(0,16)}`);
        clearPendingActions(sessionId);
        await bridge.interruptSession(sessionId);
        return { ok: true };
      }
      if (kind === 'control:retry') {
        /* 对齐桌面 ErrorView「重试」: 复用上一轮 user prompt + messageId, 不冒新气泡.
         *   SessionContext 去重 / phone user-mid dedup 靠同一 messageId. */
        // eslint-disable-next-line no-console
        console.log(`[mobile-bridge] retry: session=${sessionId.slice(0,16)} from device=${conn?.mobile?.device_id?.slice(0, 16)}`);
        try {
          await retryLastUserMessage(sessionId, conn?.mobile?.device_id, params?.payload?.chat_mode === true);
          return { ok: true };
        } catch (e: any) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, `retry failed: ${e?.message ?? e}`);
        }
      }
      /* 未知 kind — 仍 ACK 防止 Phone 端 await 卡住, 但日志要打出来便于发现协议漂移 */
      // eslint-disable-next-line no-console
      console.warn(`[mobile-bridge] unknown control kind: ${kind} (session=${sessionId.slice(0,16)})`);
      return { ok: true, ignored: true };
    });

    /* session.list — 用 sessionStore 拿当前 session 列表 */
    this.dispatcher.register('session.list', async (params, _conn) => {
      const limit = clampRpcLimit(params?.limit, 50, MAX_SESSION_LIST_LIMIT);
      return await listSessions(limit);
    });

    /* M3 — session.set_mirror: mobile / desktop 改某 session 的 mirrorPolicy */
    this.dispatcher.register('session.set_mirror', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const policy = requireBoundedString(params?.policy, 'policy', 16);
      if (policy !== 'always' && policy !== 'manual' && policy !== 'never') {
        throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'policy must be always/manual/never');
      }
      try {
        const storeMod: any = await import('@neoxlabs/core/platform/sessionStore.js');
        const session = await storeMod.sessionStore.loadSession(sessionId);
        if (!session) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, `session ${sessionId} not found`);
        }
        session.mirrorPolicy = policy;
        session.updatedAt = Date.now();
        await storeMod.sessionStore.saveSessionMetadata(session);
        this.setMirrorPolicyCache(sessionId, policy);
        /* 广播 mirror change — phone 决定是否还显示 */
        this.broadcastToAllConns(makeNotification('session.mirror_changed', {
          session_id: sessionId,
          policy,
        }));
        /* 如果切到 never, 给所有订阅了的 phone 发删除通知, 让 mobile 列表里那条消失 */
        if (policy === 'never') {
          this.broadcastToAllConns(makeNotification('session.deleted', { session_id: sessionId }));
        }
        return { ok: true, policy };
      } catch (e: any) {
        throw new RpcError(RpcErrorCode.INTERNAL_ERROR, `set_mirror failed: ${e?.message ?? e}`);
      }
    });

    /* attachment.begin / chunk / end — 附件分片上传 (中转单包 256KB, 整图塞 session.input 过不去)。
     *  以 device_id 为归属, 手机中途重连也能续; session.input 用 upload_id 引用, 引用即消费。 */
    const uploadOwner = (conn: MobileConn) => conn?.mobile?.device_id ?? 'anon';
    const rpcAttachmentError = (fn: () => unknown) => {
      try { return fn(); } catch (e: any) {
        if (e instanceof AttachmentError) throw new RpcError(RpcErrorCode.INVALID_PARAMS, e.message);
        throw e;
      }
    };
    this.dispatcher.register('attachment.begin', async (params, conn) => rpcAttachmentError(() => beginUpload(uploadOwner(conn), params)));
    this.dispatcher.register('attachment.chunk', async (params, conn) => rpcAttachmentError(() => appendUploadChunk(uploadOwner(conn), params)));
    this.dispatcher.register('attachment.end', async (params, conn) => rpcAttachmentError(() => finishUpload(uploadOwner(conn), params)));

    /* session.history — 拉 session 历史消息 (before_seq + limit 翻页) */
    this.dispatcher.register('session.history', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const beforeSeq = clampBeforeSeq(params?.before_seq);
      const limit = clampRpcLimit(params?.limit, 50, MAX_SESSION_HISTORY_LIMIT);
      return { messages: await getSessionHistory(sessionId, beforeSeq, limit) };
    });

    /* session.create — Mobile 端"新建会话". 用 Desktop 当前 focused workspace +
     *  最近使用的 model. 返新 session 摘要给 Phone 立即跳进 timeline.
     *  同时 broadcast 给其它已连 phone, 让多设备同步看到.
     *  agent_mode (work|code) 透传 — 跟桌面同语义; 老版本手机发来的 assistant (Life, 已删) 按 work。 */
    this.dispatcher.register('session.create', async (params, _conn) => {
      const name = optionalBoundedString(params?.name, MAX_SESSION_NAME_LEN);
      const rawMode = optionalBoundedString(params?.agent_mode, 16);
      const agentMode = rawMode === 'assistant' || rawMode === 'work' || rawMode === 'code'
        ? normalizeAgentMode(rawMode)
        : undefined;
      const modelId = optionalBoundedString(params?.model_id, MAX_MODEL_ID_LEN);
      const summary = await createSession(name, undefined, agentMode, modelId);
      await broadcastSessionCreated(summary);
      return summary;
    });

    /* session.delete — Mobile 端删除会话. 删 sessionStore + 广播给所有 phone */
    this.dispatcher.register('session.delete', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
      await (storeMod as any).sessionStore.deleteSession(sessionId);
      this.evictMirrorPolicyCache(sessionId);
      clearPendingActions(sessionId);
      const uiStateMod = await import('./sessionUiStateRegistry.js');
      uiStateMod.clearSessionUiState(sessionId);
      bridgeLog('deleteSession', `id=${sessionId.slice(0,16)}`);
      /* 通知 Desktop renderer 重拉 + 广播给所有 phone */
      const idx = await import('./index.js');
      idx.notifyDesktopSessionsChanged();
      await broadcastSessionDeleted(sessionId);
      return { ok: true };
    });

    this.dispatcher.register('session.rename', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const raw = requireBoundedString(params?.title, 'title', 200);
      const title = raw.trim();
      if (!title) throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'title required');
      const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
      const existing = await (storeMod as any).sessionStore.loadSession(sessionId);
      if (!existing) throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'session not found');
      await (storeMod as any).sessionStore.updateSessionMetadata(sessionId, { name: title });
      bridgeLog('renameSession', `id=${sessionId.slice(0,16)} → ${title.slice(0, 24)}`);
      const idx = await import('./index.js');
      idx.notifyDesktopSessionsChanged();
      this.broadcastToAllConns(makeNotification('session.renamed', {
        session_id: sessionId,
        title,
      }));
      return { ok: true, title };
    });

    this.dispatcher.register('session.rollback', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const checkpointId = requireBoundedString(params?.checkpoint_id, 'checkpoint_id', 128);
      const { SQLiteSession } = await import('@neoxlabs/core/memory/sqlite-session.js');
      const sqliteSession = new SQLiteSession(sessionId);
      /* 先取文件基线 —— 裁完对话 checkpoint 条目就没了 */
      let fileCheckpointId: string | undefined;
      try {
        const d = sqliteSession.getCheckpointData(checkpointId) as { fileCheckpointId?: string } | null;
        fileCheckpointId = d?.fileCheckpointId || undefined;
      } catch { /* 读不到就只裁对话 */ }

      await sqliteSession.rollbackToCheckpoint(checkpointId);

      let restoredCount = 0;
      if (fileCheckpointId) {
        try {
          const bridge = await getAgentBridgeForSession(sessionId);
          const r = await bridge?.rollbackToCheckpoint?.(fileCheckpointId);
          restoredCount = Array.isArray(r?.restored) ? r.restored.length : 0;
        } catch (err: any) {
          /* 文件回滚失败不回退已裁的对话 —— 抛错只会让手机端看起来什么都没发生 */
          bridgeLog('rollback', `file rollback failed: ${err?.message ?? err}`);
        }
      }
      bridgeLog('rollback', `session=${sessionId.slice(0, 16)} cp=${checkpointId.slice(0, 16)} files=${restoredCount}`);
      /* 通知桌面 renderer 重载该会话 (timeline 变了) */
      const idx = await import('./index.js');
      idx.notifyDesktopSessionsChanged();
      return { ok: true, restored_files: restoredCount };
    });

    /* session.undo — 撤销最近 N 轮 (user+assistant 对). 语义同 IPC session:undo. */
    this.dispatcher.register('session.undo', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const count = clampRpcLimit(params?.count, 1, 10);
      const { SQLiteSession } = await import('@neoxlabs/core/memory/sqlite-session.js');
      const sqliteSession = new SQLiteSession(sessionId);
      for (let i = 0; i < count; i++) {
        const assistant = await sqliteSession.popItem();
        if (!assistant) break;
        const user = await sqliteSession.popItem();
        if (!user) {
          await sqliteSession.addItems([assistant]);
          break;
        }
      }
      const idx = await import('./index.js');
      idx.notifyDesktopSessionsChanged();
      return { ok: true };
    });

    /* session.get — 拿单条 session 完整 meta (含 modelId / workspace / 标题).
     *  Mobile 进 timeline 后用来渲染 status bar (当前 model / workspace). */
    this.dispatcher.register('session.get', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
      const s = await (storeMod as any).sessionStore.loadSession(sessionId);
      if (!s) throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'session not found');
      return {
        id: s.id,
        title: s.name ?? s.id,
        workspace_path: s.workspacePath ?? null,
        workspace_name: s.workspacePath
          ? s.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
          : '',
        model_id: s.modelId ?? null,
        created_at: s.createdAt ?? 0,
        updated_at: s.updatedAt ?? 0,
        total_tokens: s.totalTokens ?? 0,
        /* mobile timeline 再进入时 seed 上下文 chip — 不再每次进来 chip 归零等下一轮 metrics */
        current_context_tokens: (s as any).contextUsed ?? s.totalTokens ?? 0,
        /* 会话种类 — 'image' = 桌面图片工作台会话 (生图走 renderer 直连不进
         * agent 事件流), mobile 据此显示"生图结果在电脑端"降级提示. */
        kind: (s as any).kind === 'image' ? 'image' : 'chat',
      };
    });

    /* model.list — Mobile picker 选 model 用. 数据源 2 路 merge:
     *   (a) 订阅 (NeoxCloud): 来自 main 的 subscriptionState (renderer membershipStore push 过来),
     *       admin 改 plan/model 后 60s 内 renderer 轮到新数据立刻同步给 main, mobile 现拉就最新.
     *       不再依赖 configService.providers 的 neox-cloud 缓存 (那条已废, models 永远 []).
     *   (b) BYOK: 走 configService.getAvailableModels(), 只剩用户自配的 provider models. */
    this.dispatcher.register('model.list', async (_params, _conn) => {
      try {
        const { subscriptionState } = await import('../services/subscriptionState.js');
        const subs = subscriptionState.getModels();
        /* 按量组 (payAsYouGo) 跟桌面菜单同构: 单独的 providerId, 手机按 pay_as_you_go 另起一组 */
        const subModels = subs.map((m) => ({
          id: `${m.payAsYouGo ? 'neox-cloud-payg' : 'neox-cloud'}:${m.modelId}`,
          name: m.modelId,
          provider: m.provider ?? 'Neox Cloud',
          provider_id: m.payAsYouGo ? 'neox-cloud-payg' : 'neox-cloud',
          is_subscription: !m.payAsYouGo,
          pay_as_you_go: m.payAsYouGo === true,
          context_window: m.contextWindow,
          supports_vision: m.supportsVision === true,
          supports_thinking: m.supportsThinking === true,
          /* 手机 picker 画消耗条用. 老版本 main 没这个字段 → 手机侧不画条 (不是画一条灰的). */
          relative_cost: typeof m.relativeCost === 'number' ? m.relativeCost : undefined,
        }));

        const cfgMod = await import('@neoxlabs/platform/platform/configService.js');
        const allList = (cfgMod as any).configService.getAvailableModels?.() ?? [];
        /* 过滤掉 neox-cloud — 现在它的 provider.models 永远空, 理论上不返;
         *   但旧 cache / 老版本 main 进程残留时多一道防御. */
        const byokModels = (allList as any[])
          .filter((m: any) => m.providerId !== 'neox-cloud')
          .map((m: any) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
            provider_id: m.providerId,
            is_subscription: false,
            context_window: m.contextWindow,
            supports_vision: m.supportsVision === true,
            supports_thinking: m.supportsThinking === true,
          }));

        return { models: [...subModels, ...byokModels] };
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[mobile-bridge] model.list failed:', e?.message);
        return { models: [] };
      }
    });

    /* providers.export — 手机「从已配对电脑导入」BYOK.
     *  仅 LAN 配对通道 (conn.transport === 'lan'): Key 不出云 relay.
     *  必须显式 include_keys: true (手机端弹确认后再传).
     *  不落日志含 key; 跳过 neox-cloud / 非 chat 协议 / 空 key. */
    this.dispatcher.register('providers.export', async (params, conn) => {
      if (conn.transport !== 'lan') {
        throw new RpcError(
          RpcErrorCode.INVALID_REQUEST,
          'providers.export 仅支持同 Wi-Fi 直连，请切换到局域网配对后再试',
        );
      }
      if (params?.include_keys !== true) {
        throw new RpcError(
          RpcErrorCode.INVALID_PARAMS,
          'include_keys must be true (user consent required)',
        );
      }
      try {
        const cfgMod = await import('@neoxlabs/platform/platform/configService.js');
        const all = (cfgMod as any).configService.getProviders?.() ?? [];
        const providers: Array<Record<string, unknown>> = [];
        const skipped: Array<{ id: string; reason: string }> = [];

        for (const p of all as any[]) {
          const id = typeof p?.id === 'string' ? p.id : '';
          if (!id || id === 'neox-cloud') {
            if (id) skipped.push({ id, reason: 'subscription' });
            continue;
          }
          const apiKey = typeof p?.apiKey === 'string' ? p.apiKey.trim() : '';
          if (!apiKey || apiKey === 'neox-managed') {
            skipped.push({ id, reason: 'no_key' });
            continue;
          }
          const mapped = mapDesktopProtocolForMobile(p.protocol);
          if (!mapped) {
            skipped.push({ id, reason: `unsupported_protocol:${String(p.protocol ?? '')}` });
            continue;
          }
          const models = Array.isArray(p.models)
            ? (p.models as any[])
                .map((m) => (typeof m === 'string' ? m : m?.name))
                .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
            : [];
          const extraHeaders: Record<string, string> = {};
          if (mapped.protocol === 'openai' && (p.protocol === 'openrouter' || String(p.baseUrl ?? '').includes('openrouter.ai'))) {
            extraHeaders['HTTP-Referer'] = 'https://neox-dev.com';
            extraHeaders['X-Title'] = 'Neox';
          }
          providers.push({
            desktop_id: id,
            name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
            protocol: mapped.protocol,
            base_url: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
            api_key: apiKey,
            models,
            ...(Object.keys(extraHeaders).length > 0 ? { extra_headers: extraHeaders } : {}),
          });
        }

        bridgeLog('providers.export', `exported=${providers.length} skipped=${skipped.length} device=${conn.mobile.device_name}`);
        return {
          providers,
          skipped,
          device_name: getDeviceName(),
        };
      } catch (e: any) {
        if (e instanceof RpcError) throw e;
        // eslint-disable-next-line no-console
        console.error('[mobile-bridge] providers.export failed:', e?.message);
        throw new RpcError(RpcErrorCode.INTERNAL_ERROR, `providers.export failed: ${e?.message ?? String(e)}`);
      }
    });

    /* session.update-model — Mobile 切换 session 的 model. 写入前归一化,
     * 防止 mobile 客户端老版本传裸名进来污染 store. */
    this.dispatcher.register('session.update-model', async (params, _conn) => {
      const sessionId = requireBoundedString(params?.session_id, 'session_id', MAX_SESSION_ID_LEN);
      const modelId = requireBoundedString(params?.model_id, 'model_id', MAX_MODEL_ID_LEN);
      const normalized = await normalizeModelId(modelId);
      if (!normalized) {
        throw new RpcError(
          RpcErrorCode.INVALID_PARAMS,
          `model_id "${modelId}" 在当前 Desktop 配置中找不到匹配 provider`,
        );
      }
      const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
      const store = (storeMod as any).sessionStore;
      const s = await store.loadSession(sessionId);
      if (!s) throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'session not found');
      const oldModelId = s.modelId;
      s.modelId = normalized;
      s.updatedAt = Date.now();
      /* 换 model → 上下文 tokens 归零. 旧 model tokenization 跟新 model 完全不同,
       * 留着旧值会让 mobile 进 timeline 看到 30k/200k 这种实际不准的占用. */
      if (oldModelId !== normalized) {
        (s as any).contextUsed = 0;
      }
      await store.saveSessionMetadata(s);
      return { ok: true, model_id: normalized };
    });

    /* workspace.list — Mobile 拉当前 desktop 打开的所有项目, 给 timeline 顶部 chip
     *  点击切换用. 同时返 most_recent_session_id 给 mobile 直接跳转, 不用再 list. */
    this.dispatcher.register('workspace.list', async (_params, _conn) => {
      try {
        const { getMobileBridgeProjectManager } = await import('./index.js');
        const pm = getMobileBridgeProjectManager();
        if (!pm) return { workspaces: [] };
        const projects = pm.listAll();
        const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js');
        const items: Array<Record<string, unknown>> = [];
        for (const p of projects) {
          const name = (p.workspacePath.split('/').filter(Boolean).pop() ?? p.workspacePath);
          /* 当 workspace 找最近 session, 给 mobile 一键跳转 */
          let recentSessionId: string | null = null;
          let recentMs = 0;
          try {
            const list = await sessionStore.listSessionsSlim(p.workspacePath) /* 只用元数据 — slim 免全量历史读 */;
            for (const s of list) {
              const t = (s.updatedAt ?? s.createdAt ?? 0) as number;
              if (t > recentMs) { recentMs = t; recentSessionId = s.id; }
            }
          } catch { /* ignore */ }
          items.push({
            workspace_path: p.workspacePath,
            workspace_name: name,
            recent_session_id: recentSessionId,
          });
        }
        return { workspaces: items };
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[mobile-bridge] workspace.list failed:', e?.message);
        return { workspaces: [] };
      }
    });

    this.dispatcher.register('file.fetch', async (params, conn) => {
      const artifactId = requireBoundedString(params?.artifact_id, 'artifact_id', 128);
      /* 产物原件 / 消息里的图 / 现压缩略图 / 产物预览图, 见 mobileArtifactPreview.lookupFetchable */
      const meta = await lookupFetchable(artifactId);
      if (!meta) {
        throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'artifact not found or expired');
      }
      const offset = Math.max(0, Number(params?.offset ?? 0) | 0);
      if (offset > meta.sizeBytes) {
        throw new RpcError(RpcErrorCode.INVALID_PARAMS, 'offset out of range');
      }
      /* 块大小按 transport 收口 —— 云中转一封包就是原始字节的 16/9 倍, 见 fileFetchChunk.ts */
      const length = fileFetchChunkLength(conn?.framesActive?.() ? 'frames' : conn?.transport, Number(params?.length ?? 0), meta.sizeBytes, offset);

      const { open } = await import('node:fs/promises');
      const fh = await open(meta.absPath, 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        const data = buf.subarray(0, bytesRead);
        const res = { artifact_id: artifactId, name: meta.name, mime: meta.mime, size_bytes: meta.sizeBytes, offset, eof: offset + bytesRead >= meta.sizeBytes };
        /* 手机要原始字节且走 v2: 字节挂在明文尾巴上不进 base64 (rpcPlaintext.ts); 其余照旧 data_base64 */
        return params?.binary && conn?.framesActive?.() ? attachBinary(res, data) : { ...res, data_base64: data.toString('base64') };
      } finally {
        await fh.close();
      }
    });

    /* workspace.list_recent — Mobile 列历史用过但当前没打开的 workspace 路径.
     *  数据源 sessionStore.listSessions() 全表扫, 按 workspacePath 去重 + 最近一次 updatedAt 排序.
     *  跟 workspace.list 互补 — 让 mobile 一键唤起 desktop 重开旧项目. */
    this.dispatcher.register('workspace.list_recent', async (_params, _conn) => {
      try {
        const { getMobileBridgeProjectManager } = await import('./index.js');
        const pm = getMobileBridgeProjectManager();
        const openPaths = new Set((pm?.listAll?.() ?? []).map((p: any) => p.workspacePath));
        const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js');
        const all = await sessionStore.listSessionsSlim(); /* 只用元数据 */
        const seen = new Map<string, { path: string; name: string; lastUsedAt: number; sessionId: string }>();
        for (const s of all) {
          if (!s.workspacePath || openPaths.has(s.workspacePath)) continue;
          const ts = (s.updatedAt ?? s.createdAt ?? 0) as number;
          const cur = seen.get(s.workspacePath);
          if (!cur || ts > cur.lastUsedAt) {
            seen.set(s.workspacePath, {
              path: s.workspacePath,
              name: s.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? s.workspacePath,
              lastUsedAt: ts,
              sessionId: s.id,
            });
          }
        }
        const list = [...seen.values()]
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, 20)
          .map((w) => ({
            workspace_path: w.path,
            workspace_name: w.name,
            last_used_at: w.lastUsedAt,
            recent_session_id: w.sessionId,
          }));
        return { workspaces: list };
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[mobile-bridge] workspace.list_recent failed:', e?.message);
        return { workspaces: [] };
      }
    });

    /* workspace.open — Mobile 一键唤起 desktop 打开某 workspace.
     *  跟 desktop UI 文件菜单 "打开项目" 同 IPC, 创建 BrowserWindow + ProjectScope. */
    this.dispatcher.register('workspace.browse', async (params, _conn) => {
      const raw = optionalBoundedString(params?.path, MAX_WORKSPACE_PATH_LEN);
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const home = os.homedir();
      const target = raw && raw.trim() ? path.resolve(raw) : home;

      /* 必须在 home 之内 (含 home 本身)。用 resolve + 前缀比对, 挡住 ../ 逃逸。 */
      const rel = path.relative(home, target);
      const insideHome = target === home || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (!insideHome) {
        throw new RpcError(RpcErrorCode.PERMISSION_DENIED, '只能浏览用户主目录下的文件夹');
      }
      try {
        const dirents = await fs.readdir(target, { withFileTypes: true });
        const dirs = [];
        for (const d of dirents) {
          if (!d.isDirectory()) continue;
          if (d.name.startsWith('.')) continue;          /* 隐藏目录不列 */
          if (d.name === 'node_modules' || d.name === 'Library') continue;
          const full = path.join(target, d.name);
          /* 带上"是不是 git 仓库" —— 用户找的多半是项目, 有这个标记一眼就认得出 */
          let isRepo = false;
          try { await fs.access(path.join(full, '.git')); isRepo = true; } catch { /* 不是 */ }
          dirs.push({ name: d.name, path: full, is_repo: isRepo });
          if (dirs.length >= 300) break;                 /* 手机上翻不了那么多 */
        }
        dirs.sort((a, b) => (Number(b.is_repo) - Number(a.is_repo)) || a.name.localeCompare(b.name));
        return {
          path: target,
          parent: target === home ? null : path.dirname(target),
          home,
          entries: dirs,
        };
      } catch (e: any) {
        throw new RpcError(RpcErrorCode.INTERNAL_ERROR, e?.message ?? 'browse failed');
      }
    });

    this.dispatcher.register('workspace.open', async (params, _conn) => {
      const workspacePath = requireBoundedString(params?.workspace_path, 'workspace_path', MAX_WORKSPACE_PATH_LEN);
      try {
        const { getMobileBridgeProjectManager } = await import('./index.js');
        const pm = getMobileBridgeProjectManager();
        if (!pm) {
          throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'projectManager not initialized');
        }
        /* 已打开只返成功 (手机无法主动 focus 桌面窗口); 边界判定见 openWorkspace.ts */
        const opened = await ensureWorkspaceOpen(pm, workspacePath);
        return { ok: true, workspace_path: workspacePath, already_open: !opened };
      } catch (e: any) {
        if (e instanceof RpcError) throw e;
        throw new RpcError(RpcErrorCode.INTERNAL_ERROR, e?.message ?? 'open workspace failed');
      }
    });

    this.dispatcher.register('session.create_in_workspace', async (params, _conn) => {
      const workspacePath = requireBoundedString(params?.workspace_path, 'workspace_path', MAX_WORKSPACE_PATH_LEN);
      const title = optionalBoundedString(params?.title, MAX_SESSION_NAME_LEN);
      const rawMode = optionalBoundedString(params?.agent_mode, 16);
      const agentMode = rawMode === 'assistant' || rawMode === 'work' || rawMode === 'code' ? normalizeAgentMode(rawMode) : undefined;
      const modelId = optionalBoundedString(params?.model_id, MAX_MODEL_ID_LEN);
      const { getMobileBridgeProjectManager } = await import('./index.js');
      const pm = getMobileBridgeProjectManager();
      if (pm) await ensureWorkspaceOpen(pm, workspacePath);
      const created = await createSession(title, workspacePath, agentMode, modelId);
      await broadcastSessionCreated(created);
      return { ok: true, ...created };
    });

    /* system.pong — Phone 回心跳 */
    this.dispatcher.register('system.pong', (_params, _conn) => {
      return undefined;
    });

    this.dispatcher.register('relay.config', async (_params, conn) => (await import('./selfHostedRelay.js')).relayConfigRpc(conn.transport));

    const wrapLifeStore = async <T,>(fn: (store: import('@neoxlabs/core/life/index.js').LifeEventsStore) => T): Promise<T> => {
      const { getLifeEventsStore } = await import('@neoxlabs/core/life/index.js');
      return fn(getLifeEventsStore());
    };
    this.dispatcher.register('lifeEvents.listByKind', async (params, _conn) => {
      const kind = params?.kind;
      if (kind !== 'outcome' && kind !== 'reminder' && kind !== 'brief_hint') {
        throw new Error('invalid kind');
      }
      const opts = { status: params?.status, limit: params?.limit ?? 50 };
      const events = await wrapLifeStore(s => s.listByKind(kind, opts));
      return { events };
    });
    this.dispatcher.register('lifeEvents.listDueReminders', async (params, _conn) => {
      const before = typeof params?.before === 'number' ? params.before : Date.now();
      const events = await wrapLifeStore(s => s.listDueReminders(before));
      return { events };
    });
    this.dispatcher.register('lifeEvents.listForBrief', async (params, _conn) => {
      const now = typeof params?.now === 'number' ? params.now : Date.now();
      const brief = await wrapLifeStore(s => s.listForDailyBrief(now));
      return brief;
    });
    this.dispatcher.register('lifeEvents.get', async (params, _conn) => {
      if (typeof params?.id !== 'string') throw new Error('id required');
      const ev = await wrapLifeStore(s => s.get(params.id));
      return { event: ev };
    });
    this.dispatcher.register('lifeEvents.transitions', async (params, _conn) => {
      if (typeof params?.id !== 'string') throw new Error('id required');
      const transitions = await wrapLifeStore(s => s.transitions(params.id));
      return { transitions };
    });
  }
}

/* ──────────────── SessionContext bridge helpers ────────────────
 * 这些 helper 把 SessionContext / sessionStore 包成 mobile bridge 用的 shape.
 * 跟协议 §3.3 一致.
 */

/** 把任意 modelId 归一化为完整 "providerId:modelName".
 *
 *   数据源 2 路:
 *     - 订阅 (subscriptionState, renderer push): id 形如 "neox-cloud:${modelId}"
 *     - BYOK (configService.getAvailableModels): id 形如 "${byokProviderId}:${modelName}"
 *
 *   优先级: 同名匹配时订阅优先 (用户主流路径, Neox 计费).
 *
 *   找不到匹配返 null — 调用方抛 friendly error 而不是把裸名扔给 agent. */

/** Desktop protocol → 手机 BYOK 三协议. 非 chat / 专用模态返 null. */
function mapDesktopProtocolForMobile(raw: unknown): { protocol: 'openai' | 'anthropic' | 'gemini' } | null {
  const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!p) return null;
  if (
    p.endsWith('-images') ||
    p.endsWith('-tts') ||
    p.endsWith('-stt') ||
    p.endsWith('-embedding') ||
    p.endsWith('-video') ||
    p === 'openai-images' ||
    p === 'openai-tts' ||
    p === 'openai-stt' ||
    p === 'openai-embedding'
  ) {
    return null;
  }
  if (p === 'anthropic' || p === 'kimi-claude') return { protocol: 'anthropic' };
  if (p === 'gemini') return { protocol: 'gemini' };
  /* OpenAI-compat 族 + 国内厂商 chat 协议 */
  const openaiCompat = new Set([
    'openai', 'openai-responses', 'openrouter', 'deepseek', 'kimi', 'glm', 'glm-claude',
    'qwen', 'doubao', 'minimax', 'groq', 'together', 'mistral', 'grok', 'anthropic-openai',
  ]);
  if (openaiCompat.has(p)) return { protocol: 'openai' };
  return null;
}

export async function normalizeModelId(rawModelId: string | undefined | null): Promise<string | null> {
  const id = (rawModelId ?? '').trim();
  if (!id) return null;
  if (id.length > MAX_MODEL_ID_LEN) return null;

  /* 收集所有可用 modelId — 订阅段 + BYOK 段, 合成统一 shape */
  type Entry = { id: string; name: string; providerId: string };
  const entries: Entry[] = [];

  try {
    const { subscriptionState } = await import('../services/subscriptionState.js');
    for (const m of subscriptionState.getModels()) {
      if (!m.modelId) continue;
      const providerId = m.payAsYouGo ? 'neox-cloud-payg' : 'neox-cloud';
      entries.push({
        id: `${providerId}:${m.modelId}`,
        name: m.modelId,
        providerId,
      });
    }
  } catch { /* ignore — subscriptionState 不可用就走 BYOK 兜底 */ }

  try {
    const cfgMod = await import('@neoxlabs/platform/platform/configService.js');
    const cfg = (cfgMod as any).configService;
    const list: any[] = cfg.getAvailableModels?.() ?? [];
    for (const m of list) {
      if (m.providerId === 'neox-cloud') continue; /* 防御 — 老 cache 残留 */
      entries.push({ id: m.id, name: m.name, providerId: m.providerId });
    }
  } catch { /* ignore */ }

  if (entries.length === 0) return null;

  /* 排序 fn: 订阅 sentinel 排第一 (同名 model 时优先订阅, 计费走 Neox 网关) */
  /* 裸名只按名字匹配时: 订阅 > BYOK > 按量 (按量扣余额, 用户没点名就不落到它身上) */
  const rank = (m: Entry): number =>
    m.providerId === 'neox-cloud' ? 0 : m.providerId === 'neox-cloud-payg' ? 2 : 1;
  const sortMatches = (arr: Entry[]) => arr.slice().sort((a, b) => rank(a) - rank(b));

  const colonIdx = id.indexOf(':');
  if (colonIdx > 0) {
    if (entries.some((m) => m.id === id)) return id;
    const namePart = id.slice(colonIdx + 1);
    const byName = sortMatches(entries.filter((m) => m.name === namePart || m.id.endsWith(`:${namePart}`)));
    if (byName.length > 0) return byName[0].id;
    return null;
  }
  const byName = sortMatches(entries.filter((m) => m.name === id || m.id.endsWith(`:${id}`)));
  if (byName.length > 0) return byName[0].id;
  return null;
}

/** 广播 session.created notification 给所有已连 phone.
 *
 *   summary shape 跟 session.snapshot 单条一致 (id / title / workspace_name / created_at /
 *   updated_at / total_tokens), Phone 端 ws_client_provider 收到后 upsert session_mirror,
 *   首页列表立即看到新 session, 不用断线重连.
 *
 *   dynamic import 避免跟 index.ts 形成静态循环依赖 (本文件被 index.ts 静态 import). */
export async function broadcastSessionCreated(summary: any): Promise<void> {
  try {
    const { getMobileBridgeServer } = await import('./index.js');
    const server = getMobileBridgeServer();
    if (!server) return;
    server.broadcastToAllConns(makeNotification('session.created', { session: summary }));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] broadcastSessionCreated failed:', e?.message);
  }
}

export async function broadcastLifeReminderFired(payload: {
  event_id: string;
  session_id: string | null;
  title: string;
  context?: string;
  fired_at: number;
  /** 迟到毫秒 (关机/休眠错过 tick); >0 时 late_note 会带人类可读说明. */
  late_by_ms?: number;
  late_note?: string;
}): Promise<void> {
  try {
    const { getMobileBridgeServer } = await import('./index.js');
    const server = getMobileBridgeServer();
    if (!server) return;
    server.broadcastToAllConns(makeNotification('life.reminder_fired', payload));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] broadcastLifeReminderFired failed:', e?.message);
  }
}

/** 广播 session.deleted notification — phone 端清掉对应 session_mirror + events. */
export async function broadcastSessionDeleted(sessionId: string): Promise<void> {
  try {
    const { getMobileBridgeServer } = await import('./index.js');
    const server = getMobileBridgeServer();
    if (!server) return;
    server.broadcastToAllConns(makeNotification('session.deleted', { session_id: sessionId }));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mobile-bridge] broadcastSessionDeleted failed:', e?.message);
  }
}

/** 拿某 session 对应 workspace 的 AgentBridge 实例.
 *
 *   approval reply / pause / cancel 都需要往同一个 AgentBridge 调 — 它持有 server SDK
 *   连接和 sessionExecutionStates 表. workspace 错了会失败 / 错绑.
 *
 *   返 null 表示 session 没在已打开的 workspace 里 (用户在 desktop 关掉了那个项目),
 *   调用方应该抛 friendly error 而不是闷头继续. */
async function getAgentBridgeForSession(sessionId: string): Promise<any | null> {
  try {
    const { getMobileBridgeProjectManager } = await import('./index.js');
    const pm = getMobileBridgeProjectManager();
    const { AGENT_BRIDGE } = await import('../context/tokens.js');

    const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
    const session = await (storeMod as any).sessionStore.loadSession(sessionId);
    if (session?.workspacePath) {
      const scope = pm?.getByPath?.(session.workspacePath);
      const bridge = scope?.peekService?.(AGENT_BRIDGE);
      if (bridge) return bridge;
    }
    const scopes: any[] = (pm as any)?.listScopes?.() ?? (pm as any)?.all?.() ?? [];
    for (const s of scopes) {
      const bridge = s?.peekService?.(AGENT_BRIDGE);
      if (bridge) {
        // eslint-disable-next-line no-console
        console.warn(`[mobile-bridge] getAgentBridgeForSession: exact scope miss for ${sessionId.slice(0, 16)}, using fallback bridge`);
        return bridge;
      }
    }
    return null;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] getAgentBridgeForSession failed:', e?.message);
    return null;
  }
}

/** 拿某 session 最新 seq (订阅时 latest_seq 用) */
async function getLatestSeq(sessionId: string): Promise<number> {
  try {
    const mod = await import('@neoxlabs/platform/platform/sessionContext.js');
    const ctx = mod.SessionContext.get(sessionId);
    const all = ctx.getAll();
    if (all.length === 0) return 0;
    return all[all.length - 1]!.seq;
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] getLatestSeq failed:', e?.message);
    return 0;
  }
}

/**
 * Phone「重试」— 对齐桌面 ErrorView / retryLast.
 *   1. 若仍在跑 → interrupt
 *   2. 从 SessionContext 取最近一条 user 文本 + messageId
 *   3. bridge.sendMessage 复用 messageId (phone/desktop dedup 不冒新气泡)
 */
/** 手机上最近一句是在聊天模式里发的会话 —— 重试时沿用 (进程内记, 重启后按 Agent 重试) */
const lastChatModeBySession = new Set<string>();

async function retryLastUserMessage(sessionId: string, deviceId?: string, chatModeHint = false): Promise<void> {
  const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
  const session = await (storeMod as any).sessionStore.loadSession(sessionId);
  if (!session || !session.workspacePath) {
    throw new Error('session has no workspacePath');
  }
  const ctxMod = await import('@neoxlabs/platform/platform/sessionContext.js');
  const ctx = ctxMod.SessionContext.get(sessionId);
  const all = ctx.getAll();
  let lastUserText = '';
  let lastUserMessageId: string | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.role !== 'user') continue;
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content == null ? '' : JSON.stringify(m.content));
    const cleaned = stripRuntimeInjectedMarkers(content)
      .replace(/<[a-z][\w-]*>([\s\S]*?)<\/[a-z][\w-]*>/gi, '$1')
      .replace(/<\/?[a-z][\w-]*>/gi, '')
      .trim();
    if (!cleaned) continue;
    lastUserText = cleaned;
    const mid = m.raw?.messageId ?? m.raw?.message_id;
    if (typeof mid === 'string' && mid.length > 0) lastUserMessageId = mid;
    break;
  }
  if (!lastUserText) {
    throw new Error('no previous user message to retry');
  }

  const { getMobileBridgeProjectManager } = await import('./index.js');
  const pm = getMobileBridgeProjectManager();
  const scope = pm?.getByPath?.(session.workspacePath);
  if (!scope) throw new Error(`no scope for ${session.workspacePath}`);
  const { AGENT_BRIDGE } = await import('../context/tokens.js');
  /* 同 injectUserMessage: AgentBridge 懒建, 只 peek 会让重试永远失败 */
  const bridge = scope.tryGetService?.(AGENT_BRIDGE) ?? scope.peekService?.(AGENT_BRIDGE);
  if (!bridge) throw new Error('no AgentBridge');

  const { attachAgentBridgeForwarder } = await import('./agentStreamForwarder.js');
  attachAgentBridgeForwarder(bridge);

  /* 还在跑就先打断 — 否则 sendMessage 会被 single-busy reject */
  try {
    clearPendingActions(sessionId);
    bridge.interruptSession?.(sessionId);
  } catch { /* ignore */ }

  const modelIdToSend: string | null = await normalizeModelId(session.modelId);
  if (!modelIdToSend) {
    throw new Error(`model "${session.modelId ?? ''}" unavailable`);
  }
  const sourceTag = deviceId ? `mobile-${deviceId.slice(0, 16)}` : 'mobile';
  const sendPayload: any = {
    sessionId,
    prompt: lastUserText,
    modelId: modelIdToSend,
    workspacePath: session.workspacePath,
    userMessageSource: sourceTag,
    userMessageId: lastUserMessageId,
    /* 重试沿用原来那句的模式 —— 聊天模式里重试不能突然带上全套工具。
     * 新手机会在 payload 里带 chat_mode; 老手机不带, 靠本进程记住的那一份 */
    ...(chatModeHint || lastChatModeBySession.has(sessionId) ? { chatMode: true } : {}),
    metadata: {},
  };
  // eslint-disable-next-line no-console
  console.log(`[mobile-bridge] retry → sendMessage session=${sessionId.slice(0,16)} msgId=${(lastUserMessageId ?? '-').slice(0, 16)} promptLen=${lastUserText.length}`);
  void bridge.sendMessage(sendPayload).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] retry sendMessage failed:', err?.message ?? err);
  });
}

async function injectUserMessage(
  sessionId: string,
  text: string,
  deviceId?: string,
  rawAttachments: Array<Record<string, unknown>> = [],
  approvalMode?: string,
  chatMode = false,
): Promise<number> {
  /* 1. 找 session → workspacePath 拿 AgentBridge 触发 agent run */
  const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
  const session = await (storeMod as any).sessionStore.loadSession(sessionId);
  if (!session || !session.workspacePath) {
    throw new RpcError(
      RpcErrorCode.INVALID_PARAMS,
      '这个会话还没有绑定项目, 先在「工作区」里选一个文件夹',
    );
  }
  (await import('./mobileImageStash.js')).rememberSessionImageBase(sessionId, session.workspacePath);
  const { getMobileBridgeProjectManager } = await import('./index.js');
  const pm = getMobileBridgeProjectManager();
  let scope = pm?.getByPath?.(session.workspacePath);
  if (!scope) {
    /* 项目在电脑上没打开 —— 这是最常见的一种, 而它完全可以自愈: 手机端本来就有
     * "在这个项目里开工"的意图, 直接替用户把项目打开, 而不是让消息凭空消失。 */
    // eslint-disable-next-line no-console
    console.log(`[mobile-bridge] inject: 项目未打开, 自动打开 ${session.workspacePath}`);
    try {
      await pm?.openProject?.(session.workspacePath);
      scope = pm?.getByPath?.(session.workspacePath);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[mobile-bridge] 自动打开项目失败: ${e?.message ?? e}`);
    }
  }
  if (!scope) {
    throw new RpcError(
      RpcErrorCode.INTERNAL_ERROR,
      `电脑上打不开这个项目: ${session.workspacePath}`,
    );
  }
  const { AGENT_BRIDGE } = await import('../context/tokens.js');
  const bridge = scope.tryGetService?.(AGENT_BRIDGE) ?? scope.peekService?.(AGENT_BRIDGE);
  if (!bridge) {
    throw new RpcError(
      RpcErrorCode.INTERNAL_ERROR,
      '电脑上这个项目还没准备好, 请稍后重试',
    );
  }

  /* 2. 绑 stream forwarder (一次性, 重复 attach 内部去重) — server 端 publish 的 bus events
   *    (含 user_message + agent stream + run_result) 经此 forwarder 推给 phone WS. */
  const { attachAgentBridgeForwarder } = await import('./agentStreamForwarder.js');
  attachAgentBridgeForwarder(bridge);

  /* 3. modelId 归一化 — 旧 session 可能存了裸 "claude-opus-4-6" 没 provider 前缀,
   *    直接扔给 agent 会路由失败报 "该模型暂不可用". 这里把裸名补全, 并自愈写回 store. */
  bridgeLog('inject', `session=${sessionId.slice(0,16)} raw modelId="${session.modelId}"`);
  let modelIdToSend: string | null = await normalizeModelId(session.modelId);
  bridgeLog('inject', `normalize → "${modelIdToSend ?? 'null'}"`);
  if (!modelIdToSend) {
    /* 没可用 model — 直接通过 server 把错误消息走 SessionContext 写一条 assistant message,
     * 双端都能看到. 简化: 不走 chat() 流, 直接 SessionContext.appendMessage. */
    const ctxMod = await import('@neoxlabs/platform/platform/sessionContext.js');
    const errCtx = ctxMod.SessionContext.get(sessionId);
    const errTurnId = `err-${Date.now()}`;
    const friendly = `❌ 当前模型 "${session.modelId ?? '未指定'}" 在 Desktop 配置中已找不到可用 provider.\n请在 Desktop 端打开模型选择器重新挑一个, 或在手机 timeline 上方 chip 点开换一个.`;
    errCtx.appendMessage('assistant', friendly, errTurnId, Date.now(), {
      role: 'assistant', content: friendly, turnId: errTurnId,
    });
    return -1;
  }
  if (modelIdToSend !== session.modelId) {
    // eslint-disable-next-line no-console
    console.log(`[mobile-bridge] normalizeModelId: "${session.modelId}" → "${modelIdToSend}" (session=${sessionId.slice(0,16)}…)`);
    try {
      session.modelId = modelIdToSend;
      session.updatedAt = Date.now();
      await (storeMod as any).sessionStore.saveSessionMetadata(session);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[mobile-bridge] saveSessionMetadata after normalize failed: ${e?.message}`);
    }
  }

  /* 4. 触发 agent run — server chat() 会先 publish user_message event + appendMessage('user') 落 drift,
   *    再跑 LLM. 不 await; mobile/desktop 通过 session.event SSE 实时收.
   *    源信息透传: userMessageSource='mobile-{deviceId}' 给 server 接力 initiatedBy 用. */
  const sourceTag = deviceId ? `mobile-${deviceId.slice(0, 16)}` : 'mobile';
  /* 附件: mobile {kind,name,mime,data_base64|upload_id,size_bytes} → 桌面 Attachment。
   *  image → data:URL; file → 主进程解析成 markdown 进文档缓存, agent 用 read_document 读
   *  (跟桌面拖文件同一条链)。任何一项不合法都抛错, 不再静默跳过 (见 mobileAttachments.ts)。 */
  const attachments = await toDesktopAttachments(
    resolveIncomingAttachments(deviceId ?? 'anon', rawAttachments),
    /* 聊天模式没有工具, 存了原件也用不上 */
    { workspacePath: chatMode ? null : session.workspacePath },
  );

  if (approvalMode === 'auto' || approvalMode === 'manual' ||
      approvalMode === 'dangerous' || approvalMode === 'yolo') {
    const mode = approvalMode === 'yolo' ? 'dangerous' : approvalMode;
    try {
      await (bridge as any).setApprovalMode?.(sessionId, mode, undefined,
        mode === 'dangerous'
          ? {
              dangerousConfirmation: {
                acknowledgeNoApproval: true,
                acknowledgeHighRiskExecution: true,
              },
            }
          : undefined);
      // eslint-disable-next-line no-console
      console.log(`[mobile-bridge] approval mode applied: ${mode} (session=${sessionId.slice(0, 16)})`);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[mobile-bridge] setApprovalMode failed (non-fatal): ${e?.message}`);
    }
  }

  const sendPayload: any = {
    sessionId,
    prompt: text || (attachments.length > 0 ? '看一下这些附件' : ''),
    modelId: modelIdToSend,
    workspacePath: session.workspacePath,
    userMessageSource: sourceTag,
    ...(chatMode ? { chatMode: true } : {}),
    metadata: {
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
  if (chatMode) lastChatModeBySession.add(sessionId);
  else lastChatModeBySession.delete(sessionId);
  bridgeLog('inject', '→ bridge.sendMessage payload: ' + JSON.stringify({
    sessionId: sendPayload.sessionId.slice(0,16),
    modelId: sendPayload.modelId,
    workspacePath: sendPayload.workspacePath,
    promptLen: sendPayload.prompt.length,
    source: sourceTag,
  }));
  void bridge.sendMessage(sendPayload).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] agent sendMessage failed:', err?.message ?? err);
  });
  /* 返 0 当占位 seq — server publish 时的 真 seq 走 SSE → forwarder → mobile drift insert,
   * Phone RPC ack 不依赖这个返回值。 */
  return 0;
}

/** 列 sessions — sessionStore.listSessions(workspacePath?) async, 跨所有 workspace.
 *  M3 镜像 — mirrorPolicy='never' 的 session 直接 filter 掉, mobile 列表完全看不到。
 *  返回 total/complete 给 Mobile 做本地 mirror reconcile, 避免删除事件漏收后残留旧会话。 */
async function listSessions(limit: number): Promise<{
  sessions: any[];
  total: number;
  has_more: boolean;
  complete: boolean;
  limit: number;
}> {
  const safeLimit = clampRpcLimit(limit, 50, MAX_SESSION_LIST_LIMIT);
  try {
    /* 直接查 sessions 表的行 (纯 SQL, 已按 updated_at DESC) — 列表只要元数据。
     * 不能用 sessionStore.listSessions(): 它对每个 session 全量构建消息历史,
     * 几百个会话时要秒级, 手机端 verify RPC (session.list limit=1) 会超时,
     * 表现为 "电脑暂时没有响应" 重连死循环。 */
    const mod = await import('@neoxlabs/platform/platform/database.js');
    /* 不传 workspacePath 拿全部 workspace, Mobile 看到所有 session */
    const all: any[] = mod.getDatabase().listSessions();
    const filtered = all.filter((s: any) => (s.mirrorPolicy ?? 'always') !== 'never' && !isOrphanSubAgentPlaceholder(s));
    /* sub-agent 子会话 (parent_session_id 非空) 不占顶层名额 — 否则一次多 agent
     * 的任务能把手机会话列表刷屏。做法: limit 只切顶层会话, 再把"父在本页里"的
     * 子会话附加进来 (带 parent_session_id, 手机在抽屉里嵌套缩进显示)。 */
    const toSummary = (s: any) => ({
      id: s.id,
      title: s.name ?? s.id,
      workspace_name: s.workspacePath
        ? s.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
        : '',
      created_at: s.createdAt ?? 0,
      updated_at: s.updatedAt ?? 0,
      total_tokens: s.totalTokens ?? 0,
      mirror_policy: s.mirrorPolicy ?? 'always',
      /* image 会话标识 — phone 显示"图片工作台"降级标注 */
      kind: s.kind === 'image' ? 'image' : 'chat',
      /* sub-agent 父子关系 — null = 顶层会话. 手机据此嵌套 + 不在顶层列表重复出现 */
      parent_session_id: s.parentSessionId ?? null,
      /* 子会话的展示名 (= 派 agent 时的任务描述), 顶层会话为 null */
      agent_name: s.parentSessionId ? (s.name ?? null) : null,
      /* 运行态 (idle/running/paused/awaiting_*): 手机电脑页 / 侧栏不逐条订阅也要知道在跑 / 等人; 没记录按 idle */
      run_status: getMirroredRunState(s.id)?.status ?? 'idle',
    });
    const roots = filtered.filter((s: any) => !s.parentSessionId);
    const children = filtered.filter((s: any) => !!s.parentSessionId);
    const pickedRoots = roots.slice(0, safeLimit);
    const pickedRootIds = new Set(pickedRoots.map((s: any) => s.id));
    const pickedChildren = children.filter((s: any) => pickedRootIds.has(s.parentSessionId));
    const sessions = [...pickedRoots, ...pickedChildren].map(toSummary);
    /* total / has_more 只按顶层算 — 手机的 mirror reconcile 用它判断"这页是不是
     * 权威全量", 把子会话算进去会让 total 永远 > 页大小, 权威判定失效。 */
    const total = roots.length;
    return {
      sessions,
      total,
      has_more: total > pickedRoots.length,
      complete: total <= pickedRoots.length,
      limit: safeLimit,
    };
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] listSessions failed:', e?.message);
    return {
      sessions: [],
      total: 0,
      has_more: false,
      complete: false,
      limit: safeLimit,
    };
  }
}

/** 拿历史消息 — SessionContext 内存 + DB. shape 跟 session.event notification 1:1 一致
 *  (kind + payload), 这样 Phone 端 history + 实时事件能走同一套渲染路径. */
async function getSessionHistory(sessionId: string, beforeSeq: number, limit: number): Promise<any[]> {
  const safeLimit = clampRpcLimit(limit, 50, MAX_SESSION_HISTORY_LIMIT);
  const safeBeforeSeq = clampBeforeSeq(beforeSeq);
  try {
    const mod = await import('@neoxlabs/platform/platform/sessionContext.js');
    const { mapSessionMessageToProtocol } = await import('./sessionEventBridge.js');
    const { isRealTurnId } = await import('./agentStreamForwarder.js');
    const ctx = mod.SessionContext.get(sessionId);
    /* 消息里 `![图](charts/a.png)` 这类相对路径要按会话的项目目录找文件 (见 mobileImageStash) */
    try {
      const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
      const s = await (storeMod as any).sessionStore.loadSession(sessionId);
      const { rememberSessionImageBase } = await import('./mobileImageStash.js');
      rememberSessionImageBase(sessionId, s?.workspacePath);
    } catch { /* 拿不到目录只是相对路径的图不显示, 不影响历史 */ }

    const page: any[] = ctx.getRawMessagesPage(safeBeforeSeq, safeLimit);
    if (page.length > 0) {
      /* turn_id carry-forward: 一轮的真 id 落在开轮的 user 消息上, 后续
       * assistant/tool 沿用最近一个真 id。分页之后页首可能找不到本页内的 user,
       * 所以再往前**有界地**看一页 (只在需要时, 且只读 turnId)。 */
      let lastRealTurn = '';
      if (!isRealTurnId(page[0]?.turnId)) {
        const lookback = ctx.getRawMessagesPage(page[0].seq, safeLimit);
        for (const m of lookback) {
          if (isRealTurnId(m.turnId)) lastRealTurn = m.turnId;
        }
      }
      const args: Parameters<typeof mapSessionMessageToProtocol>[0][] = [];
      for (const m of page) {
        if (m.role === 'system') continue; // system prompt 手机不展示
        if (isRealTurnId(m.turnId)) lastRealTurn = m.turnId;
        args.push({
          seq: m.seq,
          timestamp: m.timestamp,
          role: m.role,
          content: m.content,
          turnId: isRealTurnId(m.turnId) ? m.turnId : (lastRealTurn || m.turnId || ''),
          raw: m.raw,
        });
      }
      return buildHistoryPage(args, mapSessionMessageToProtocol, sessionId);
    }

    const all: any[] = [...ctx.getAll()];
    /* 取 seq < beforeSeq 的最近 limit 条; role=system 是 system prompt, mobile 不展示 */
    const filtered = all.filter((m) => m.seq < safeBeforeSeq && m.role !== 'system');
    /* turn_id 归轮 (carry-forward): 运行时给 assistant 消息塞的 turnId 常是空串, 跨轮
     * 恒定 → 手机按 turn_id 归轮会覆盖上一轮。一轮的 id 落在开轮的 user 消息上
     * (chat-<ts>), 后续 assistant/tool 消息沿用最近一个真 id。必须在【整段 filtered】
     * 上 carry-forward 再切片, 否则翻页时页首 assistant 找不到本页内的 user 会丢 id。 */
    let lastRealTurn = '';
    const withTurn = filtered.map((m) => {
      if (isRealTurnId(m.turnId)) lastRealTurn = m.turnId;
      const turnId = isRealTurnId(m.turnId) ? m.turnId : (lastRealTurn || m.turnId || '');
      return { m, turnId };
    });
    const slice = withTurn.slice(-safeLimit);
    return buildHistoryPage(slice.map(({ m, turnId }) => ({
      seq: m.seq,
      timestamp: m.timestamp,
      role: m.role,
      content: m.content,
      turnId,
      raw: m.raw,
    })), mapSessionMessageToProtocol, sessionId);
  } catch (e: any) {
    bridgeLog('history', `getSessionHistory failed session=${sessionId.slice(0, 16)}: ${e?.message}`);
    throw new Error(`history unavailable: ${e?.message ?? 'unknown'}`);
  }
}

/** Mobile 新建 session — workspace 默认用 Desktop focused 项目; 显式传 workspacePath
 *  时 (workspace 切换场景) 用指定的. modelId 从同 workspace 最近 session 继承,
 *  没有 fallback hardcoded id, 否则 NeoxCloud routing 找不到 provider 直接 404.
 *  agentMode: phone 三模式 (assistant|work|code) 透传, 桌面 sidebar/timeline 按模式渲染. */
async function createSession(
  name?: string,
  workspacePath?: string,
  agentMode?: 'assistant' | 'work' | 'code' | 'pilot',
  requestedModelId?: string,
): Promise<any> {
  const safeName = optionalBoundedString(name, MAX_SESSION_NAME_LEN) ?? '新会话';
  const safeWorkspacePath = workspacePath
    ? requireBoundedString(workspacePath, 'workspace_path', MAX_WORKSPACE_PATH_LEN)
    : undefined;
  const { getMobileBridgeProjectManager } = await import('./index.js');
  const pm = getMobileBridgeProjectManager();
  if (!pm) {
    throw new RpcError(RpcErrorCode.INTERNAL_ERROR, 'projectManager not ready');
  }
  const storeMod = await import('@neoxlabs/core/platform/sessionStore.js');
  const store = (storeMod as any).sessionStore;
  /* 没有打开的项目窗口时打开最近用过的工作区 (单一模式下常态), 见 newSessionWorkspace.ts */
  const scope: any = await resolveNewSessionScope(pm, store, safeWorkspacePath);
  if (!scope || !scope.workspacePath) {
    throw new RpcError(
      RpcErrorCode.INTERNAL_ERROR,
      safeWorkspacePath
        ? `电脑上打不开这个项目: ${safeWorkspacePath}`
        : '电脑上还没有用过任何项目, 先在电脑上打开一个项目',
    );
  }
  /* 用哪个模型: 手机指定 → 同 workspace 继承 → 订阅第一条 → BYOK 第一条.
   * 决策全在 newSessionModel.ts (这个文件已经到棘轮上限, 不能再堆)。 */
  const modelId = await resolveNewSessionModelId(
    { requestedModelId, workspacePath: scope.workspacePath },
    {
      normalizeModelId,
      listSessionsSlim: (wp) => store.listSessionsSlim(wp),
      log: (msg) => bridgeLog('createSession', msg),
    },
  );
  if (!modelId) {
    throw new RpcError(
      RpcErrorCode.INTERNAL_ERROR,
      '当前 Desktop 没有任何可用 model — 请先在 Desktop 配置 provider/订阅',
    );
  }
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await store.createSession({
    sessionId,
    workspacePath: scope.workspacePath,
    modelId,
    name: safeName,
    ...(agentMode ? { agentMode } : {}),
  });
  bridgeLog('createSession', `id=${sessionId.slice(0,16)} modelId=${modelId} ws=${scope.workspacePath}`);
  /* 通知 Desktop renderer 刷新 session list, 否则用户 mobile 新建的 session 在桌面 sidebar
   * 看不到, 直到下次 boot 重拉. */
  const { notifyDesktopSessionsChanged } = await import('./index.js');
  notifyDesktopSessionsChanged();
  return {
    id: created.id,
    title: created.name ?? created.id,
    workspace_name: created.workspacePath
      ? created.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
      : '',
    created_at: created.createdAt ?? 0,
    updated_at: created.updatedAt ?? 0,
    total_tokens: 0,
  };
}
