
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { EventBus, ServerEvent } from './eventBus.js';
import type { RuntimeBridge } from './index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { BoundedUUIDSet } from './boundedUUIDSet.js';
import { FlushGate } from './flushGate.js';
import { DeliveryTracker } from './deliveryTracker.js';
import { WebSocketTransport, type NeoxTransport } from './transport.js';
import {
  isControlRequest,
  isControlResponse,
  handleControlRequest,
  ControlRequester,
  type ControlRequestHandlers,
} from './controlProtocol.js';
import type { SessionManager } from './sessionManager.js';

// ============================================================================
// Types
// ============================================================================

/** WS 客户端消息 */
export interface WSClientMessage {
  /** 消息类型 */
  type: 'chat' | 'abort' | 'status' | 'compact' | 'set_mode' | 'set_agent_mode' | 'delivery_ack' | 'control_request' | 'control_response';
  /** Session ID */
  sessionId?: string;
  /** 聊天内容 */
  prompt?: string;
  /** 模型 */
  modelName?: string;
  /** Provider */
  providerId?: string;
  /** 模式 */
  mode?: string;
  /** 消息唯一 ID (客户端生成，用于 ack) */
  id?: string;
  uuid?: string;
  lastSeqNum?: number;
  eventId?: string;
  deliveryStatus?: 'processing' | 'processed';
  request_id?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

/** WS 服务端消息 */
export interface WSServerMessage {
  type: 'event' | 'status' | 'error' | 'ack' | 'welcome' | 'control_request' | 'control_response';
  /** 回复哪条客户端消息 */
  replyTo?: string;
  /** SSE 事件数据（直接转发） */
  event?: any;
  /** 状态信息 */
  status?: any;
  /** 错误信息 */
  error?: string;
  /** 欢迎信息 */
  info?: any;
  seq?: number;
  request_id?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

interface ConnectedClient {
  ws: WebSocket;
  deviceId: string;
  connectedAt: number;
  lastActivity: number;
  /** 订阅的 session */
  subscribedSession?: string;
  transport: WebSocketTransport;
  postedUUIDs: BoundedUUIDSet;
  inboundUUIDs: BoundedUUIDSet;
  flushGate: FlushGate<WSServerMessage>;
  controlRequester: ControlRequester;
  epoch: number;
}

export interface WSGatewayOptions {
  /** WebSocket 端口（与 HTTP 分离时使用） */
  port?: number;
  /** 或者直接 attach 到现有 HTTP server */
  server?: HttpServer;
  /** 认证令牌（为空则跳过认证） */
  authToken?: string;
  /** RuntimeBridge（复用现有） */
  bridge: RuntimeBridge;
  /** EventBus（复用现有） */
  bus: EventBus;
  /** 心跳间隔 (ms) */
  heartbeatInterval?: number;
  sessionManager?: SessionManager;
}

// ============================================================================
// WSGateway
// ============================================================================

export class WSGateway {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private bridge: RuntimeBridge;
  private bus: EventBus;
  private authToken: string;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private deliveryTracker = new DeliveryTracker();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sessionManager?: SessionManager;

  constructor(private options: WSGatewayOptions) {
    this.bridge = options.bridge;
    this.bus = options.bus;
    this.authToken = options.authToken || '';
    this.sessionManager = options.sessionManager;
  }

  /**
   * 启动 WebSocket gateway
   */
  async start(): Promise<void> {
    const wssOptions: any = {};

    if (this.options.server) {
      wssOptions.server = this.options.server;
      wssOptions.path = '/ws';
    } else if (this.options.port) {
      wssOptions.port = this.options.port;
    } else {
      throw new Error('Must provide either server or port');
    }

    wssOptions.perMessageDeflate = false;

    this.wss = new WebSocketServer(wssOptions);

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('listening', () => {
      const addr = this.options.port ? `ws://0.0.0.0:${this.options.port}` : 'ws://<server>/ws';
      cliLogger.info('WS_GATEWAY', `WebSocket gateway ready: ${addr}`);
    });

    this.wss.on('error', (err) => {
      cliLogger.error('WS_GATEWAY', `Server error: ${err.message}`);
    });

    // 心跳
    const interval = this.options.heartbeatInterval ?? 30_000;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), interval);

    this.sweepTimer = setInterval(() => this.deliveryTracker.sweepTimeouts(), 60_000);

    // 订阅 EventBus，转发事件给 WS 客户端
    this.subscribeToBus();
  }

  /**
   * 停止
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const client of this.clients.values()) {
      client.controlRequester.cancelAll('Server shutting down');
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.deliveryTracker.clear();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          cliLogger.info('WS_GATEWAY', 'Gateway stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** 已连接的客户端数 */
  getClientCount(): number {
    return this.clients.size;
  }

  getDeliveryStats() {
    return this.deliveryTracker.getStats();
  }

  getTransportDebugInfo() {
    const info: Record<string, any> = {};
    this.clients.forEach((client, deviceId) => {
      info[deviceId] = client.transport.getDebugInfo();
    });
    return info;
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '/', `ws://localhost`);

    // 认证
    if (this.authToken) {
      const token = url.searchParams.get('token') || '';
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== this.authToken && bearer !== this.authToken) {
        cliLogger.warn('WS_GATEWAY', 'Auth failed');
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    const deviceId = url.searchParams.get('device')
      || req.headers['x-device-id'] as string
      || `ws-${Date.now().toString(36)}`;

    const lastSeqNum = parseInt(url.searchParams.get('last_seq') || '0', 10) || 0;

    // 替换同设备旧连接
    const existing = this.clients.get(deviceId);
    let epoch = 1;
    if (existing) {
      epoch = existing.epoch + 1;
      existing.controlRequester.cancelAll('Connection replaced');
      existing.ws.close(4002, 'Replaced');
    }

    const transport = new WebSocketTransport({ deviceId, socket: ws });

    const client: ConnectedClient = {
      ws,
      deviceId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      transport,
      postedUUIDs: new BoundedUUIDSet(2000),
      inboundUUIDs: new BoundedUUIDSet(2000),
      flushGate: new FlushGate<WSServerMessage>(),
      controlRequester: new ControlRequester(),
      epoch,
    };
    this.clients.set(deviceId, client);
    cliLogger.info('WS_GATEWAY', `Connected: ${deviceId} epoch=${epoch} (total: ${this.clients.size})`);

    if (lastSeqNum > 0 && client.subscribedSession) {
      this.replayMissedEvents(client, lastSeqNum);
    }

    // 欢迎消息（带 epoch + seq 信息）
    this.sendTo(deviceId, {
      type: 'welcome',
      info: {
        deviceId,
        epoch,
        currentSeq: this.bus.currentSeq,
        activeSessions: this.bridge.getActiveSessions(),
        runMode: this.bridge.getRunMode?.() ?? 'agentic',
        capabilities: ['seq_num', 'echo_dedup', 'flush_gate', 'control_protocol', 'delivery_ack'],
      },
    });

    // 消息处理
    ws.on('message', (data) => {
      client.lastActivity = Date.now();
      try {
        const msg: WSClientMessage = JSON.parse(data.toString());
        this.handleClientMessage(deviceId, msg);
      } catch (err: any) {
        cliLogger.debug('WS_GATEWAY', `Invalid JSON from device ${deviceId}: ${err?.message}`);
        this.sendTo(deviceId, { type: 'error', error: 'Invalid JSON' });
      }
    });

    ws.on('pong', () => { client.lastActivity = Date.now(); });

    ws.on('close', (code) => {
      client.controlRequester.cancelAll('Connection closed');
      transport.handleClose(code);
      this.clients.delete(deviceId);
      if (this.sessionManager) {
        this.sessionManager.removeDevice(deviceId);
      }
      cliLogger.info('WS_GATEWAY', `Disconnected: ${deviceId} code=${code} (total: ${this.clients.size})`);
    });

    ws.on('error', (err) => {
      cliLogger.error('WS_GATEWAY', `Client error (${deviceId}): ${err.message}`);
    });
  }

  // ==========================================================================
  // ==========================================================================

  private replayMissedEvents(client: ConnectedClient, fromSeq: number): void {
    if (!client.subscribedSession) return;

    const missed = this.bus.replayFrom(client.subscribedSession, fromSeq);
    if (missed.length === 0) return;

    cliLogger.info('WS_GATEWAY',
      `Replaying ${missed.length} events for ${client.deviceId} from seq=${fromSeq}`);

    client.flushGate.start();

    for (const event of missed) {
      const msg: WSServerMessage = {
        type: 'event',
        seq: event.seq,
        event: {
          sessionId: event.sessionId,
          eventType: event.type,
          data: event.data,
          seq: event.seq,
          timestamp: event.timestamp,
        },
      };
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
      }
    }

    const queued = client.flushGate.end();
    for (const msg of queued) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
      }
    }
  }

  // ==========================================================================
  // Message Handling — 桥接到现有 RuntimeBridge
  // ==========================================================================

  private async handleClientMessage(deviceId: string, msg: WSClientMessage): Promise<void> {
    const client = this.clients.get(deviceId);
    if (!client) return;

    if (msg.uuid) {
      if (client.postedUUIDs.has(msg.uuid)) return; // echo
      if (client.inboundUUIDs.has(msg.uuid)) return; // duplicate delivery
      client.inboundUUIDs.add(msg.uuid);
    }

    if (msg.type === 'control_request' && isControlRequest(msg)) {
      const handlers = this.buildControlHandlers(deviceId);
      const response = handleControlRequest(msg, handlers);
      this.sendTo(deviceId, response as unknown as WSServerMessage);
      return;
    }

    if (msg.type === 'control_response' && isControlResponse(msg)) {
      client.controlRequester.handleResponse(msg as any);
      return;
    }

    if (msg.type === 'delivery_ack' && msg.eventId && msg.deliveryStatus) {
      if (msg.deliveryStatus === 'processing') {
        this.deliveryTracker.markProcessing(msg.eventId);
      } else if (msg.deliveryStatus === 'processed') {
        this.deliveryTracker.markProcessed(msg.eventId);
      }
      return;
    }

    const sessionId = msg.sessionId || `ws-${deviceId}`;

    switch (msg.type) {
      case 'chat': {
        if (!msg.prompt) {
          this.sendTo(deviceId, { type: 'error', replyTo: msg.id, error: 'Missing prompt' });
          return;
        }

        // 订阅该 session 的事件
        client.subscribedSession = sessionId;

        if (this.sessionManager) {
          this.sessionManager.recordStat(sessionId, 'message');
          this.sessionManager.touch(sessionId);
        }

        // ACK
        this.sendTo(deviceId, {
          type: 'ack',
          replyTo: msg.id,
          status: { sessionId, state: 'processing' },
        });

        try {
          await this.bridge.chat(sessionId, {
            prompt: msg.prompt,
            modelName: msg.modelName,
            providerId: msg.providerId,
          });
        } catch (err) {
          this.sendTo(deviceId, {
            type: 'error',
            replyTo: msg.id,
            error: `Chat failed: ${(err as Error).message}`,
          });
        }
        break;
      }

      case 'abort': {
        this.bridge.abort(sessionId);
        this.sendTo(deviceId, {
          type: 'ack',
          replyTo: msg.id,
          status: { sessionId, state: 'aborted' },
        });
        break;
      }

      case 'status': {
        const activeSessions = this.bridge.getActiveSessions();
        const runMode = this.bridge.getRunMode?.() ?? 'agentic';
        this.sendTo(deviceId, {
          type: 'status',
          replyTo: msg.id,
          status: {
            activeSessions,
            runMode,
            clients: this.clients.size,
            currentSeq: this.bus.currentSeq,
            epoch: client.epoch,
            delivery: this.deliveryTracker.getStats(),
            sessions: this.sessionManager?.list() ?? [],
          },
        });
        break;
      }

      case 'compact': {
        try {
          await this.bridge.compactSession?.(sessionId);
          this.sendTo(deviceId, {
            type: 'ack',
            replyTo: msg.id,
            status: { sessionId, state: 'compacted' },
          });
        } catch (err) {
          this.sendTo(deviceId, {
            type: 'error',
            replyTo: msg.id,
            error: (err as Error).message,
          });
        }
        break;
      }

      case 'set_mode': {
        if (msg.mode) {
          this.bridge.setRunMode?.(msg.mode as any);
          this.sendTo(deviceId, {
            type: 'ack',
            replyTo: msg.id,
            status: { mode: msg.mode },
          });
        }
        break;
      }

      case 'set_agent_mode': {
        if (msg.mode) {
          const applied = this.bridge.setAgentMode?.(sessionId, String(msg.mode)) ?? 'code';
          this.sendTo(deviceId, {
            type: 'ack',
            replyTo: msg.id,
            status: { sessionId, agentMode: applied },
          });
        }
        break;
      }
    }
  }

  // ==========================================================================
  // ==========================================================================

  private buildControlHandlers(deviceId: string): ControlRequestHandlers {
    return {
      onInitialize: () => ({
        pid: process.pid,
        version: '1.0.0',
        capabilities: ['seq_num', 'echo_dedup', 'flush_gate', 'delivery_ack', 'epoch'],
      }),
      onSetModel: (model: string) => {
        // 委托给 RuntimeBridge
        try {
          // bridge 可能有 setModel 方法
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      onSetPermissionMode: (mode: string) => {
        try {
          const client = this.clients.get(deviceId);
          const sessionId = client?.subscribedSession || `ws-${deviceId}`;
          this.bridge.setApprovalMode?.(sessionId, mode as any);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      onInterrupt: (reason?: string) => {
        const client = this.clients.get(deviceId);
        if (client?.subscribedSession) {
          this.bridge.abort(client.subscribedSession);
        }
      },
      onSetMode: (mode: string) => {
        try {
          this.bridge.setRunMode?.(mode as any);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      onGetStatus: () => ({
        clients: this.clients.size,
        activeSessions: this.bridge.getActiveSessions(),
        runMode: this.bridge.getRunMode?.() ?? 'agentic',
        currentSeq: this.bus.currentSeq,
        delivery: this.deliveryTracker.getStats(),
      }),
    };
  }

  // ==========================================================================
  // EventBus → WS Clients
  // ==========================================================================

  private subscribeToBus(): void {
    const sub = this.bus.subscribe();

    (async () => {
      for await (const event of sub) {
        this.forwardEventToClients(event);
      }
    })().catch(err => {
      cliLogger.error('WS_GATEWAY', `EventBus subscription error: ${err.message}`);
    });
  }

  private forwardEventToClients(event: ServerEvent): void {
    const eventId = event.uuid || `seq-${event.seq}`;

    for (const client of this.clients.values()) {
      if (!client.subscribedSession || client.subscribedSession === event.sessionId) {
        if (client.ws.readyState === WebSocket.OPEN) {
          const msg: WSServerMessage = {
            type: 'event',
            seq: event.seq,
            event: {
              sessionId: event.sessionId,
              eventType: event.type,
              data: event.data,
              seq: event.seq,
              timestamp: event.timestamp,
            },
          };

          if (client.flushGate.enqueue(msg)) {
            continue; // 已入队，不立即发送
          }

          this.deliveryTracker.markReceived(eventId, event.sessionId);

          const dropsBefore = client.transport.droppedBatchCount;
          client.ws.send(JSON.stringify(msg));
          const dropsAfter = client.transport.droppedBatchCount;

          if (dropsAfter > dropsBefore) {
            cliLogger.warn('WS_GATEWAY',
              `${dropsAfter - dropsBefore} batch(es) dropped for ${client.deviceId}`);
            this.deliveryTracker.recordDroppedBatch(dropsAfter - dropsBefore);
          } else {
            this.deliveryTracker.markProcessing(eventId);
          }
        }
      }
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private sendTo(deviceId: string, msg: WSServerMessage): void {
    const client = this.clients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      if ((msg as any).uuid) {
        client.postedUUIDs.add((msg as any).uuid);
      }
      client.ws.send(JSON.stringify(msg));
    }
  }

  private checkHeartbeats(): void {
    const timeout = 90_000;
    const now = Date.now();
    for (const [deviceId, client] of this.clients) {
      if (now - client.lastActivity > timeout) {
        cliLogger.warn('WS_GATEWAY', `Heartbeat timeout: ${deviceId}`);
        client.controlRequester.cancelAll('Heartbeat timeout');
        client.ws.terminate();
        this.clients.delete(deviceId);
      } else if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 将 WS Gateway 附加到现有 Neox Server
 */
export async function attachWSGateway(options: WSGatewayOptions): Promise<WSGateway> {
  const gateway = new WSGateway(options);
  await gateway.start();
  return gateway;
}
