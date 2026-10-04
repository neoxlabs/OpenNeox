
import type { ServerEvent } from './eventBus.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ─── 核心接口 ───

export type TransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';

export interface TransportMessage {
  type: string;
  [key: string]: unknown;
}

export interface NeoxTransport {
  /** 传输标识（用于日志和调试） */
  readonly id: string;
  /** 传输类型 */
  readonly kind: 'sse' | 'websocket' | 'ipc';
  /** 绑定的设备 ID */
  readonly deviceId: string;

  // ─── 写 ───

  /** 发送单条消息 */
  write(message: TransportMessage): Promise<void>;
  /** 批量发送（用于历史回放等场景） */
  writeBatch(messages: TransportMessage[]): Promise<void>;
  /** 发送事件（ServerEvent → 传输格式） */
  writeEvent(event: ServerEvent): Promise<void>;

  // ─── 读 ───

  /** 注册数据回调 */
  setOnData(callback: (data: string) => void): void;
  /** 注册关闭回调 */
  setOnClose(callback: (closeCode?: number) => void): void;
  /** 注册连接成功回调 */
  setOnConnect(callback: () => void): void;

  // ─── 状态 ───

  /** 当前是否已连接 */
  isConnected(): boolean;
  /** 当前状态标签 */
  getState(): TransportState;
  /** 获取读流最后的 seq-num（用于 carryover） */
  getLastSequenceNum(): number;

  // ─── 投递 ───

  /** 单调递增的丢批计数器 */
  readonly droppedBatchCount: number;
  /** 上报投递状态 */
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void;
  /** 上报传输状态（如权限提示中） */
  reportState(state: Record<string, unknown>): void;

  // ─── 生命周期 ───

  /** 发起连接 */
  connect(): Promise<void>;
  /** 排空写队列后关闭 */
  flush(): Promise<void>;
  /** 立即关闭 */
  close(): void;

  // ─── 调试 ───

  getDebugInfo(): TransportDebugInfo;
}

export interface TransportDebugInfo {
  id: string;
  kind: string;
  deviceId: string;
  state: TransportState;
  lastSequenceNum: number;
  droppedBatchCount: number;
  connectedAt?: number;
  bytesSent?: number;
}

// ─── WebSocket Transport 实现 ───

export interface WSTransportOptions {
  deviceId: string;
  socket: { send: (data: string) => void; readyState: number; OPEN: number };
}

/**
 * WebSocket 传输实现
 * 包装已建立的 WebSocket 连接为 NeoxTransport 接口
 */
export class WebSocketTransport implements NeoxTransport {
  readonly id: string;
  readonly kind = 'websocket' as const;
  readonly deviceId: string;

  private socket: WSTransportOptions['socket'];
  private state: TransportState = 'connected';
  private lastSeqNum = 0;
  private _droppedBatchCount = 0;
  private connectedAt = Date.now();
  private bytesSent = 0;

  private onDataCb?: (data: string) => void;
  private onCloseCb?: (closeCode?: number) => void;
  private onConnectCb?: () => void;

  constructor(options: WSTransportOptions) {
    this.id = `ws-${options.deviceId}-${Date.now().toString(36)}`;
    this.deviceId = options.deviceId;
    this.socket = options.socket;
  }

  async write(message: TransportMessage): Promise<void> {
    if (this.socket.readyState !== this.socket.OPEN) {
      this._droppedBatchCount++;
      return;
    }
    const data = JSON.stringify(message);
    this.socket.send(data);
    this.bytesSent += data.length;
  }

  async writeBatch(messages: TransportMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.write(msg);
    }
  }

  async writeEvent(event: ServerEvent): Promise<void> {
    await this.write({
      type: 'event',
      sessionId: event.sessionId,
      eventType: event.type,
      data: event.data,
      seq: event.seq,
      timestamp: event.timestamp,
    });
    this.lastSeqNum = event.seq;
  }

  setOnData(callback: (data: string) => void): void {
    this.onDataCb = callback;
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCb = callback;
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCb = callback;
  }

  /** 外部调用：当 WebSocket 收到消息时 */
  handleMessage(data: string): void {
    this.onDataCb?.(data);
  }

  /** 外部调用：当 WebSocket 关闭时 */
  handleClose(code?: number): void {
    this.state = 'closed';
    this.onCloseCb?.(code);
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.socket.readyState === this.socket.OPEN;
  }

  getState(): TransportState {
    return this.state;
  }

  getLastSequenceNum(): number {
    return this.lastSeqNum;
  }

  get droppedBatchCount(): number {
    return this._droppedBatchCount;
  }

  reportDelivery(_eventId: string, _status: 'processing' | 'processed'): void {
    // WebSocket: ACK 通过消息通道发送（由上层处理）
  }

  reportState(state: Record<string, unknown>): void {
    this.write({ type: 'state_report', ...state }).catch(err => cliLogger.debug('TRANSPORT', `WS state report failed: ${err?.message}`));
  }

  async connect(): Promise<void> {
    // WebSocket 已在构造时连接
    this.state = 'connected';
    this.onConnectCb?.();
  }

  async flush(): Promise<void> {
    // WebSocket 消息立即发送，无需 flush
  }

  close(): void {
    this.state = 'closed';
  }

  getDebugInfo(): TransportDebugInfo {
    return {
      id: this.id,
      kind: this.kind,
      deviceId: this.deviceId,
      state: this.state,
      lastSequenceNum: this.lastSeqNum,
      droppedBatchCount: this._droppedBatchCount,
      connectedAt: this.connectedAt,
      bytesSent: this.bytesSent,
    };
  }
}

// ─── SSE Transport 实现 ───

export interface SSETransportOptions {
  deviceId: string;
  /** SSE 写入回调 */
  write: (eventName: string, data: string) => void;
  /** 初始 seq-num（断线续传 carryover） */
  initialSequenceNum?: number;
}

/**
 * SSE 传输实现
 * 单向写（server → client），读通过 HTTP POST 端点
 */
export class SSETransport implements NeoxTransport {
  readonly id: string;
  readonly kind = 'sse' as const;
  readonly deviceId: string;

  private sseWrite: SSETransportOptions['write'];
  private state: TransportState = 'connected';
  private lastSeqNum: number;
  private _droppedBatchCount = 0;
  private connectedAt = Date.now();
  private bytesSent = 0;

  private onDataCb?: (data: string) => void;
  private onCloseCb?: (closeCode?: number) => void;

  constructor(options: SSETransportOptions) {
    this.id = `sse-${options.deviceId}-${Date.now().toString(36)}`;
    this.deviceId = options.deviceId;
    this.sseWrite = options.write;
    this.lastSeqNum = options.initialSequenceNum ?? 0;
  }

  async write(message: TransportMessage): Promise<void> {
    try {
      const data = JSON.stringify(message);
      this.sseWrite(message.type as string, data);
      this.bytesSent += data.length;
    } catch (err: any) {
      cliLogger.debug('TRANSPORT', `SSE write failed: ${err?.message}`);
      this._droppedBatchCount++;
    }
  }

  async writeBatch(messages: TransportMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.write(msg);
    }
  }

  async writeEvent(event: ServerEvent): Promise<void> {
    const data = JSON.stringify({
      sessionId: event.sessionId,
      type: event.type,
      data: event.data,
      seq: event.seq,
      timestamp: event.timestamp,
    });
    try {
      this.sseWrite('event', data);
      this.bytesSent += data.length;
      this.lastSeqNum = event.seq;
    } catch (err: any) {
      cliLogger.debug('TRANSPORT', `SSE writeEvent failed: ${err?.message}`);
      this._droppedBatchCount++;
    }
  }

  setOnData(callback: (data: string) => void): void {
    this.onDataCb = callback;
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCb = callback;
  }

  setOnConnect(): void {
    // SSE 已在构造时连接
  }

  /** 外部调用：当 SSE 连接关闭时 */
  handleClose(code?: number): void {
    this.state = 'closed';
    this.onCloseCb?.(code);
  }

  /** 外部调用：POST 端点收到消息时 */
  handleInboundMessage(data: string): void {
    this.onDataCb?.(data);
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getState(): TransportState {
    return this.state;
  }

  getLastSequenceNum(): number {
    return this.lastSeqNum;
  }

  get droppedBatchCount(): number {
    return this._droppedBatchCount;
  }

  reportDelivery(eventId: string, status: 'processing' | 'processed'): void {
    this.write({ type: 'delivery_ack', eventId, status }).catch(err => cliLogger.debug('TRANSPORT', `SSE delivery ack failed: ${err?.message}`));
  }

  reportState(state: Record<string, unknown>): void {
    this.write({ type: 'state_report', ...state }).catch(err => cliLogger.debug('TRANSPORT', `SSE state report failed: ${err?.message}`));
  }

  async connect(): Promise<void> {
    this.state = 'connected';
  }

  async flush(): Promise<void> {
    // SSE 消息立即发送
  }

  close(): void {
    this.state = 'closed';
  }

  getDebugInfo(): TransportDebugInfo {
    return {
      id: this.id,
      kind: this.kind,
      deviceId: this.deviceId,
      state: this.state,
      lastSequenceNum: this.lastSeqNum,
      droppedBatchCount: this._droppedBatchCount,
      connectedAt: this.connectedAt,
      bytesSent: this.bytesSent,
    };
  }
}
