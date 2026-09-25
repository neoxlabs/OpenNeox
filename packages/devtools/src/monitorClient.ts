/**
 * MonitorClient —— 进程外监控客户端。
 *
 * 连产品 server 本来就开着的 WSGateway(ws://127.0.0.1:<port>/ws), 被动订阅全量
 * 事件流。**对产品零改动**:一个不发 chat 的客户端, WSGateway 的 forwardEventToClients
 * 会把所有 session 的事件都推给它(subscribedSession 为空 → 收 '*')。
 *
 * 这是最干净的解耦路径:监控逻辑 100% 在 devtools 包, 产品里没有一行监控代码。
 */

import { WebSocket } from 'ws';
import type { ServerEndpoint, WSServerMessage } from './types.js';
import { MonitorAggregator } from './aggregator.js';
import { buildWsUrl } from './discovery.js';

export interface MonitorClientOptions {
  endpoint: ServerEndpoint;
  aggregator: MonitorAggregator;
  deviceId?: string;
  /** 周期性拉 status(activeSessions / delivery 等), ms。0 = 不拉 */
  statusPollMs?: number;
  /** 重连退避上限 ms */
  maxReconnectMs?: number;
  onLog?: (msg: string) => void;
}

export class MonitorClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1000;
  private statusTimer?: ReturnType<typeof setInterval>;
  private readonly deviceId: string;

  constructor(private readonly opts: MonitorClientOptions) {
    this.deviceId = opts.deviceId || `neox-devtools-${process.pid}`;
    opts.aggregator.setEndpoint(opts.endpoint);
    opts.aggregator.setMode('subscription');
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = undefined; }
    try { this.ws?.close(1000, 'devtools stop'); } catch { /* ignore */ }
    this.ws = null;
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }

  private connect(): void {
    if (this.closed) return;
    const url = buildWsUrl(this.opts.endpoint, this.deviceId);
    this.log(`connecting ${url.replace(/token=[^&]+/, 'token=***')}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1000;
      this.opts.aggregator.setConnected(true);
      this.log('connected');
      // 主动问一次 status(拿 activeSessions / runMode)
      this.send({ type: 'status', id: `status-${Date.now()}` });
      const pollMs = this.opts.statusPollMs ?? 5000;
      if (pollMs > 0) {
        this.statusTimer = setInterval(() => this.send({ type: 'status', id: `status-${Date.now()}` }), pollMs);
        if (typeof this.statusTimer?.unref === 'function') this.statusTimer.unref();
      }
    });

    ws.on('message', (raw) => {
      let msg: WSServerMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    ws.on('close', (code) => {
      this.opts.aggregator.setConnected(false);
      if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = undefined; }
      if (this.closed) return;
      this.log(`disconnected (code=${code}), reconnecting in ${this.reconnectDelay}ms`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log(`ws error: ${(err as Error).message}`);
      // close 事件会随后触发重连
    });
  }

  private scheduleReconnect(): void {
    const max = this.opts.maxReconnectMs ?? 15000;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(max, this.reconnectDelay * 2);
    const t = setTimeout(() => this.connect(), delay);
    if (typeof t?.unref === 'function') t.unref();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  private handleMessage(msg: WSServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.log(`welcome: epoch=${msg.info?.epoch} activeSessions=${(msg.info?.activeSessions || []).length}`);
        break;

      case 'event':
        if (msg.event) {
          this.opts.aggregator.record({
            sessionId: msg.event.sessionId,
            eventType: msg.event.eventType,
            data: msg.event.data,
            timestamp: msg.event.timestamp || Date.now(),
          });
        }
        break;

      case 'status':
        // status 里有 activeSessions —— 给 aggregator 补充未通过事件感知到的 session
        if (msg.status?.activeSessions) {
          for (const sid of msg.status.activeSessions) {
            this.opts.aggregator.record({ sessionId: sid, eventType: 'status', data: { status: 'thinking' }, timestamp: Date.now() });
          }
        }
        break;

      case 'error':
        this.log(`server error: ${msg.error}`);
        break;
    }
  }
}
