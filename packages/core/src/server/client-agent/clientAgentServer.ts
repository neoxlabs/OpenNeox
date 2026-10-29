/**
 * @deprecated 已迁移到 Main Server (src/server/) 统一架构。
 * 安全层（auth/rateLimit/device）已合并到 src/server/middleware/。
 * 此文件保留供参考，新代码请使用 Main Server + NeoxClient SDK。
 *
 * Client Agent Server (Legacy)
 * WebSocket 服务，允许外部设备连接并获得专属 Agent
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { HostContext } from './hostContext.js';
import { getHostToolNames } from './hostTools.js';
import type {
  ClientAgentServerConfig,
  ClientConnection,
  ConnectionState,
  DeviceInfo,
  Capability,
  ClientMessage,
  ServerMessage,
  HostEventType,
} from './protocol.js';

const DEFAULT_SERVER_CONFIG: ClientAgentServerConfig = {
  port: 7091,  // Client Agent 专用端口
  host: '0.0.0.0',
  token: '',
  maxClients: 10,
  maxConnectionsPerIp: 3,
  idleTimeout: 5 * 60 * 1000,
  heartbeatInterval: 30 * 1000,
  maxPortRetries: 10,
  rateLimit: {
    messages: 60,
    window: 60 * 1000,
  },
};

interface ClientState {
  id: string;
  ws: WebSocket;
  state: ConnectionState;
  device: DeviceInfo | null;
  capabilities: Capability[];
  agentId: string | null;
  subscriptions: Set<HostEventType>;
  connectedAt: number;
  lastActivity: number;
  ip: string;
  messageCount: number;
  messageWindowStart: number;
}

export interface RunRequest {
  text: string;
  voice?: boolean;
}

export interface RunResponse {
  ok: boolean;
  queued?: boolean;
  position?: number;
  error?: string;
}

export class ClientAgentServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientState>();
  private config: ClientAgentServerConfig;
  private hostContext: HostContext;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private version: string;
  private actualPort: number;
  private onRun?: (request: RunRequest) => Promise<RunResponse>;

  constructor(
    hostContext: HostContext,
    config: Partial<ClientAgentServerConfig> & { token: string; version?: string },
    onRun?: (request: RunRequest) => Promise<RunResponse>
  ) {
    this.hostContext = hostContext;
    this.config = { ...DEFAULT_SERVER_CONFIG, ...config };
    this.version = config.version || '1.0.0';
    this.actualPort = this.config.port;
    this.onRun = onRun;
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    if (this.wss) {
      return;
    }

    if (!this.config.token.trim()) {
      throw new Error('Remote server token is required');
    }
    this.config.token = this.config.token.trim();

    const maxRetries = this.config.maxPortRetries ?? 10;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const portToTry = this.config.port + attempt;

      try {
        await this.tryBindPort(portToTry);
        this.actualPort = portToTry;
        if (attempt > 0) {
          cliLogger.info('CLIENT_AGENT', `Port ${this.config.port} in use, using port ${portToTry} instead`);
        }
        cliLogger.info('CLIENT_AGENT', `Server started on ${this.config.host}:${this.actualPort}`);
        this.startHeartbeat();
        return;
      } catch (err: any) {
        lastError = err;
        if (err.code !== 'EADDRINUSE') {
          throw err;
        }
        // 关闭失败的服务器
        if (this.wss) {
          (this.wss as WebSocketServer).close();
          this.wss = null;
        }
      }
    }

    throw lastError || new Error(`Failed to bind to any port in range ${this.config.port}-${this.config.port + maxRetries - 1}`);
  }

  /**
   * 尝试绑定端口
   */
  private tryBindPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port,
        host: this.config.host,
      });

      const onError = (err: Error) => {
        reject(err);
      };

      this.wss.once('error', onError);

      this.wss.on('listening', () => {
        this.wss?.removeListener('error', onError);
        resolve();
      });

      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });
    });
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 关闭所有客户端连接
    for (const client of this.clients.values()) {
      this.sendMessage(client.ws, { type: 'close_ack' });
      client.ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this.wss = null;
          cliLogger.info('CLIENT_AGENT', 'Server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): { running: boolean; host: string; port: number; token: string; clients: number } {
    return {
      running: this.wss !== null,
      host: this.config.host || '0.0.0.0',
      port: this.actualPort,
      token: this.config.token,
      clients: this.clients.size,
    };
  }

  /**
   * 更新 Token
   */
  updateToken(token: string): void {
    this.config.token = token.trim();
  }

  private normalizeMessageData(data: RawData): string | null {
    if (typeof data === 'string') {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString();
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString();
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString();
    }
    return null;
  }

  /**
   * 处理新连接
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this.getClientIp(req);

    // 检查连接数限制
    if (this.clients.size >= this.config.maxClients!) {
      cliLogger.warn('CLIENT_AGENT', `Max clients reached, rejecting connection from ${ip}`);
      ws.close(1013, 'Max clients reached');
      return;
    }

    // 检查单 IP 连接数
    const ipConnections = Array.from(this.clients.values()).filter(c => c.ip === ip).length;
    if (ipConnections >= this.config.maxConnectionsPerIp!) {
      cliLogger.warn('CLIENT_AGENT', `Max connections per IP reached for ${ip}`);
      ws.close(1013, 'Max connections per IP reached');
      return;
    }

    const clientId = crypto.randomUUID();
    const client: ClientState = {
      id: clientId,
      ws,
      state: 'connected',
      device: null,
      capabilities: [],
      agentId: null,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      ip,
      messageCount: 0,
      messageWindowStart: Date.now(),
    };

    this.clients.set(clientId, client);
    cliLogger.info('CLIENT_AGENT', `Client connected: ${clientId} from ${ip}`);

    // 发送欢迎消息
    this.sendMessage(ws, {
      type: 'welcome',
      payload: {
        version: this.version,
        serverTime: Date.now(),
        features: ['chat', 'voice', 'host_introspection', 'event_subscription'],
      },
    });

    // 设置消息处理
    ws.on('message', (data) => {
      this.handleMessage(client, data);
    });

    ws.on('pong', () => {
      client.lastActivity = Date.now();
    });

    ws.on('close', () => {
      this.handleDisconnect(client);
    });

    ws.on('error', (error) => {
      cliLogger.error('CLIENT_AGENT', `Client error: ${clientId}`, error);
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(client: ClientState, data: RawData): Promise<void> {
    client.lastActivity = Date.now();

    // 速率限制检查
    if (!this.checkRateLimit(client)) {
      this.sendError(client.ws, 'RATE_LIMITED', 'Too many requests');
      return;
    }

    const text = this.normalizeMessageData(data);
    if (text === null) {
      this.sendError(client.ws, 'INVALID_MESSAGE', 'Unsupported message format');
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(text);
    } catch {
      this.sendError(client.ws, 'INVALID_MESSAGE', 'Invalid JSON');
      return;
    }

    cliLogger.debug('CLIENT_AGENT', `Message from ${client.id}: ${message.type}`);

    switch (message.type) {
      case 'auth':
        await this.handleAuth(client, message);
        break;

      case 'register':
        await this.handleRegister(client, message);
        break;

      case 'chat':
        await this.handleChat(client, message);
        break;

      case 'voice':
        await this.handleVoice(client, message);
        break;

      case 'subscribe':
        await this.handleSubscribe(client, message);
        break;

      case 'unsubscribe':
        await this.handleUnsubscribe(client, message);
        break;

      case 'ping':
        this.sendMessage(client.ws, {
          type: 'pong',
          ts: Date.now(),
          payload: { serverTime: Date.now() },
        });
        break;

      case 'close':
        this.sendMessage(client.ws, { type: 'close_ack' });
        client.ws.close();
        break;

      default:
        this.sendError(client.ws, 'INVALID_MESSAGE', `Unknown message type: ${(message as any).type}`);
    }
  }

  /**
   * 处理认证
   */
  private async handleAuth(client: ClientState, message: ClientMessage): Promise<void> {
    const { token } = message.payload as { token: string };

    if (token !== this.config.token) {
      client.state = 'error';
      this.sendMessage(client.ws, {
        type: 'auth_fail',
        payload: { reason: 'Invalid token' },
      });
      client.ws.close(1008, 'Authentication failed');
      return;
    }

    client.state = 'authenticated';
    this.sendMessage(client.ws, {
      type: 'auth_ok',
      payload: { clientId: client.id },
    });
  }

  /**
   * 处理设备注册
   */
  private async handleRegister(client: ClientState, message: ClientMessage): Promise<void> {
    if (client.state !== 'authenticated') {
      this.sendError(client.ws, 'AUTH_REQUIRED', 'Authentication required');
      return;
    }

    const { device, capabilities } = message.payload as {
      device: DeviceInfo;
      capabilities: Capability[];
    };

    client.device = device;
    client.capabilities = capabilities;
    client.agentId = `agent-${client.id}`;
    client.state = 'ready';

    cliLogger.info('CLIENT_AGENT', `Device registered: ${device.type} - ${device.name}`);

    // 发送 Agent 就绪
    this.sendMessage(client.ws, {
      type: 'agent_ready',
      payload: {
        agentId: client.agentId,
        tools: getHostToolNames(),
        model: 'lightweight', // TODO: 根据配置选择模型
      },
    });
  }

  /**
   * 处理文字输入 - 直接发送到主 CLI 执行
   */
  private async handleChat(client: ClientState, message: ClientMessage): Promise<void> {
    if (client.state !== 'ready') {
      this.sendError(client.ws, 'AUTH_REQUIRED', 'Registration required');
      return;
    }

    const { text } = message.payload as { text: string };
    const requestId = message.id || crypto.randomUUID();

    cliLogger.info('CLIENT_AGENT', `Chat from ${client.device?.name}: ${text.slice(0, 50)}...`);

    // Chat 模式：直接发送到主 CLI 执行
    if (this.onRun) {
      try {
        const result = await this.onRun({ text, voice: false });
        this.sendMessage(client.ws, {
          type: 'response',
          id: requestId,
          payload: {
            text: result.ok
              ? (result.queued ? `命令已加入队列，位置: ${result.position}` : '命令已发送')
              : (result.error || '命令发送失败'),
            queued: result.queued,
            position: result.position,
          },
        });
      } catch (error) {
        cliLogger.error('CLIENT_AGENT', 'Chat onRun failed', error);
        this.sendError(client.ws, 'INTERNAL_ERROR', 'Command execution failed', requestId);
      }
    } else {
      // 没有 onRun 回调，返回错误
      this.sendError(client.ws, 'HOST_UNAVAILABLE', 'CLI not available', requestId);
    }
  }

  /**
   * 处理语音输入
   */
  private async handleVoice(client: ClientState, message: ClientMessage): Promise<void> {
    if (client.state !== 'ready') {
      this.sendError(client.ws, 'AUTH_REQUIRED', 'Registration required');
      return;
    }

    const { text, audio } = message.payload as { text?: string; audio?: string };
    const requestId = message.id || crypto.randomUUID();

    const inputText = text;
    if (!inputText && audio) {
      this.sendError(client.ws, 'UNSUPPORTED', 'Audio input is not supported; send text');
      return;
    }

    if (!inputText) {
      this.sendError(client.ws, 'INVALID_MESSAGE', 'No text or audio provided');
      return;
    }

    cliLogger.info('CLIENT_AGENT', `Voice from ${client.device?.name}: ${inputText.slice(0, 50)}...`);

    await this.processAgentRequest(client, requestId, inputText);
  }

  /**
   * 处理 Agent 请求
   */
  private async processAgentRequest(client: ClientState, requestId: string, text: string): Promise<void> {
    cliLogger.debug('CLIENT_AGENT', `Processing request: ${requestId}, text: ${text.slice(0, 50)}`);

    try {
      // 简单的命令解析
      let responseText = '';

      if (text.includes('状态') || text.includes('status')) {
        const status = await this.hostContext.getStatus();
        responseText = status.isRunning
          ? `正在执行任务，模式: ${status.mode}，内存使用: ${Math.round(status.memoryUsage.pressure * 100)}%`
          : `空闲中，工作目录: ${status.workingDirectory}`;
      } else if (text.includes('进度') || text.includes('progress')) {
        const agents = await this.hostContext.getAgents();
        const running = agents.filter(a => a.status === 'running');
        responseText = running.length > 0
          ? `有 ${running.length} 个 Agent 正在运行`
          : '当前没有正在执行的任务';
      } else if (text.includes('中断') || text.includes('stop') || text.includes('interrupt')) {
        const result = await this.hostContext.interrupt('Voice command');
        responseText = result.interrupted ? '已中断当前任务' : '没有正在执行的任务';
      } else if (text.includes('系统') || text.includes('system')) {
        const system = await this.hostContext.getSystem();
        responseText = `平台: ${system.platform}, Git: ${system.gitBranch || '无'} (${system.gitStatus})`;
      } else {
        // 默认：回复收到消息
        responseText = `收到消息: "${text.slice(0, 100)}"，命令已加入队列`;
        // 异步发送命令，不阻塞响应
        this.hostContext.sendCommand(text).catch(err => {
          cliLogger.error('CLIENT_AGENT', 'sendCommand failed', err);
        });
      }

      cliLogger.debug('CLIENT_AGENT', `Sending response: ${responseText.slice(0, 50)}`);

      // 发送响应
      this.sendMessage(client.ws, {
        type: 'response',
        id: requestId,
        payload: {
          text: responseText,
        },
      });

      cliLogger.debug('CLIENT_AGENT', `Response sent for request: ${requestId}`);
    } catch (error) {
      cliLogger.error('CLIENT_AGENT', 'Agent request failed', error);
      this.sendError(client.ws, 'INTERNAL_ERROR', 'Request processing failed', requestId);
    }
  }

  /**
   * 处理事件订阅
   */
  private async handleSubscribe(client: ClientState, message: ClientMessage): Promise<void> {
    if (client.state !== 'ready') {
      this.sendError(client.ws, 'AUTH_REQUIRED', 'Registration required');
      return;
    }

    const { events } = message.payload as { events: HostEventType[] };

    events.forEach(e => client.subscriptions.add(e));

    // 注册到 HostContext
    this.hostContext.subscribe(client.id, events, (event) => {
      this.sendMessage(client.ws, {
        type: 'host_event',
        payload: {
          event: event.type,
          timestamp: Date.now(),
          data: event.data,
        },
      });
    });

    cliLogger.info('CLIENT_AGENT', `Client ${client.id} subscribed to: ${events.join(', ')}`);
  }

  /**
   * 处理取消订阅
   */
  private async handleUnsubscribe(client: ClientState, message: ClientMessage): Promise<void> {
    const { events } = message.payload as { events?: HostEventType[] };

    if (events) {
      events.forEach(e => client.subscriptions.delete(e));
      this.hostContext.unsubscribe(client.id, events);
    } else {
      client.subscriptions.clear();
      this.hostContext.unsubscribe(client.id);
    }
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(client: ClientState): void {
    cliLogger.info('CLIENT_AGENT', `Client disconnected: ${client.id}`);

    // 清理订阅
    this.hostContext.cleanupClient(client.id);

    // 移除客户端
    this.clients.delete(client.id);
  }

  /**
   * 发送消息
   */
  private sendMessage(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * 发送错误
   */
  private sendError(ws: WebSocket, code: string, message: string, id?: string): void {
    this.sendMessage(ws, {
      type: 'error',
      id,
      payload: { code, message },
    } as ServerMessage);
  }

  /**
   * 获取客户端 IP
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * 检查速率限制
   */
  private checkRateLimit(client: ClientState): boolean {
    const now = Date.now();
    const { messages, window } = this.config.rateLimit!;

    // 重置窗口
    if (now - client.messageWindowStart > window) {
      client.messageCount = 0;
      client.messageWindowStart = now;
    }

    client.messageCount++;
    return client.messageCount <= messages;
  }

  /**
   * 启动心跳检测
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const [id, client] of this.clients) {
        // 检查空闲超时
        if (now - client.lastActivity > this.config.idleTimeout!) {
          cliLogger.info('CLIENT_AGENT', `Client ${id} idle timeout`);
          client.ws.close(1000, 'Idle timeout');
          continue;
        }

        // 发送心跳
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * 广播消息给所有客户端
   */
  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.state === 'ready') {
        this.sendMessage(client.ws, message);
      }
    }
  }

  /**
   * 广播原始事件（兼容旧 RemoteServer 接口）
   */
  broadcastRaw(event: { type: string; ts: number; payload?: unknown }): void {
    for (const client of this.clients.values()) {
      if (client.state === 'ready' && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(event));
      }
    }
  }

  /**
   * 广播 Runtime 事件
   */
  broadcastRuntimeEvent(event: unknown): void {
    this.broadcastRaw({ type: 'runtime_event', ts: Date.now(), payload: event });
  }

  /**
   * 广播宿主事件
   */
  broadcastHostEvent(event: HostEventType, data: unknown): void {
    for (const client of this.clients.values()) {
      if (client.state === 'ready' &&
          (client.subscriptions.has('*') || client.subscriptions.has(event))) {
        this.sendMessage(client.ws, {
          type: 'host_event',
          payload: {
            event,
            timestamp: Date.now(),
            data,
          },
        });
      }
    }
  }
}

/**
 * 生成远程访问 Token
 */
export function generateRemoteToken(): string {
  return crypto.randomBytes(16).toString('hex');
}
