import WebSocket from 'ws';
import * as crypto from 'node:crypto';
import { RelayLink, type RpcMessage } from '../relay-transport/index.js';
import { SessionEventTranslator } from './sessionEventTranslator.js';
import { FilePhoneHistoryStore } from './historyStore.js';
import type { CliPhonePeerFile } from './peerFile.js';

/** 中转单条上限 256KB (cloud-relay maxEnvelopeBytes), 留余量 */
const ENVELOPE_LIMIT = 240 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface CliSessionInfo {
  id: string;
  title: string;
  workspacePath: string;
  modelId?: string;
  createdAt?: number;
}

export interface CliPhoneEndpointOptions {
  /** NeoxCloud API 根 (中转在 /relay/api/v1/relay) */
  apiBaseUrl: string;
  /** 每次 (重) 连前取一个新鲜的登录令牌 */
  getAccessToken: () => Promise<string | null>;
  /** 当前登录账号 —— 只认这个账号配过的手机 */
  userId: string | null;
  peers: CliPhonePeerFile;
  getSession: () => CliSessionInfo;
  /** 手机发来一句话: CLI 当作用户在终端里输入 (正在跑就排队 / 插话) */
  onUserMessage: (text: string) => Promise<void> | void;
  /** 手机点停止 */
  onStop: () => Promise<void> | void;
  /** 手机回答 ask_user */
  onAskUserReply?: (requestId: string, answers: unknown) => void;
  /** 历史落盘位置 (传了才落盘)。CLI 传 ~/.neox/phone-remote/<session>.jsonl */
  historyFile?: string;
  log?: (msg: string) => void;
  onStateChange?: (state: 'connecting' | 'online' | 'offline', detail?: string) => void;
}

export class CliPhoneEndpoint {
  readonly endpointId = `cli:${crypto.randomBytes(6).toString('hex')}`;
  /** v1/v2 收发 (relay-transport/relayLink.ts) */
  private readonly link: RelayLink;
  private readonly startedAt = Date.now();
  readonly translator: SessionEventTranslator;
  private ws: WebSocket | null = null;
  private keys = new Map<string, Buffer>();
  private watchers = new Map<string, { phone: string; endpoint?: string }>();
  private disposed = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: CliPhoneEndpointOptions) {
    this.link = new RelayLink({ device: opts.peers.device_id, ep: this.endpointId });
    for (const p of opts.peers.peers) {
      if (p.owner_user_id && opts.userId && p.owner_user_id !== opts.userId) continue;
      try {
        const k = Buffer.from(p.key_b64, 'base64');
        if (k.length === 32) this.keys.set(p.device_id, k);
      } catch { /* 坏条目跳过 */ }
    }
    this.translator = new SessionEventTranslator(
      opts.getSession().id,
      (msg) => this.broadcast(msg),
      opts.historyFile ? new FilePhoneHistoryStore(opts.historyFile) : undefined,
    );
  }

  phoneCount(): number { return this.keys.size; }

  /** 终端里先答了 ask_user —— 通知手机把对应卡片翻成已答 (含答案) */
  askUserAnswered(requestId: string, answers: Record<string, string>): void {
    this.translator.askUserAnswered(requestId, answers);
  }

  start(): void {
    void this.dial();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(1000, 'cli_remote_off'); } catch { /* ignore */ }
    this.ws = null;
    this.opts.onStateChange?.('offline', 'stopped');
  }

  private log(m: string): void { this.opts.log?.(m); }

  private async dial(): Promise<void> {
    if (this.disposed) return;
    this.opts.onStateChange?.('connecting');
    const token = await this.opts.getAccessToken().catch(() => null);
    if (this.disposed) return;
    if (!token) {
      this.opts.onStateChange?.('offline', 'not_logged_in');
      return this.scheduleReconnect();
    }
    const base = this.opts.apiBaseUrl.replace(/\/+$/, '');
    const url = `${base.startsWith('https://') ? 'wss' : 'ws'}://${base.replace(/^https?:\/\//, '')}/relay/api/v1/relay`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Neox-Device-Id': this.opts.peers.device_id,
        'X-Neox-Device-Type': 'desktop',
        'X-Neox-Endpoint': this.endpointId,
      },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    ws.on('open', () => {
      this.link.onOpen();
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.watchers.clear();
      this.log(`relay online as ${this.endpointId}`);
      this.opts.onStateChange?.('online');
    });
    ws.on('message', (data) => { void this.onMessage(data as Buffer); });
    ws.on('unexpected-response', (_req, res) => {
      this.log(`relay handshake ${res.statusCode}`);
      this.opts.onStateChange?.('offline', `http_${res.statusCode}`);
    });
    ws.on('error', (e) => this.log(`relay error: ${e.message}`));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed) return;
      this.opts.onStateChange?.('offline', 'disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.dial(); }, delay);
  }

  private async onMessage(raw: Buffer): Promise<void> {
    const inc = this.link.receive(raw);
    if (!inc) return;
    if (inc.kind === 'control') {
      const parsed = inc.frame;
      /* 手机那条连接没了: 别再给它推 (推了中转也只是告诉我们它不在) */
      if ((parsed.type === 'device_offline' || parsed.type === 'endpoint_offline') && parsed.device_id) {
        this.watchers.delete(`${parsed.device_id}#${parsed.endpoint ?? ''}`);
      }
      return;
    }
    const key = this.keys.get(inc.from);
    if (!key) return;
    let msg: RpcMessage | null = null;
    try {
      msg = this.link.open(key, inc);
    } catch (e: any) {
      this.log(`decrypt failed from ${inc.from.slice(0, 12)}: ${e?.message}`);
      return;
    }
    if (!msg?.method) return;
    const peer = { phone: inc.from, endpoint: inc.fromEp || undefined };
    /* 只有打开了会话的才收推送 —— 手机列表页那条发现连接只问 session.list, 不该被事件流刷 */
    if (msg.method !== 'session.list' && msg.method !== 'model.list' && !msg.method.startsWith('workspace.')) {
      this.watchers.set(`${peer.phone}#${peer.endpoint ?? ''}`, peer);
    }
    let reply: RpcMessage | null;
    try {
      reply = await this.dispatch(msg);
    } catch (e: any) {
      reply = msg.id != null ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } } : null;
    }
    if (reply && msg.id != null) this.sendTo(peer, reply);
  }

  private async dispatch(msg: RpcMessage): Promise<RpcMessage | null> {
    const id = msg.id ?? null;
    const params = (msg.params ?? {}) as Record<string, any>;
    const ok = (result: unknown): RpcMessage => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string): RpcMessage => ({ jsonrpc: '2.0', id, error: { code, message } });
    const s = this.opts.getSession();
    const summary = () => ({
      id: s.id,
      title: s.title || 'CLI 会话',
      workspace_path: s.workspacePath,
      workspace_name: s.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? '',
      created_at: s.createdAt || this.startedAt,
      updated_at: Date.now(),
      mirror_policy: 'always',
      kind: 'chat',
      parent_session_id: null,
      run_status: this.translator.isRunning() ? 'running' : 'idle',
      /* 手机据此打「终端」标签, 并把后续请求发给这个入口 */
      source: 'cli',
      endpoint: this.endpointId,
      model_id: s.modelId,
    });

    switch (msg.method) {
      case 'session.list':
        return ok({ sessions: [summary()], total: 1, has_more: false, complete: true, limit: 1 });
      case 'session.get':
        return ok({ ...summary(), model_id: s.modelId, total_tokens: 0, current_context_tokens: 0 });
      case 'session.subscribe':
        return ok({
          ok: true,
          latest_seq: this.translator.latestSeq(),
          run_state: { status: this.translator.isRunning() ? 'running' : 'idle', turn_id: this.translator.status().turn_id, last_committed_seq: null, pending_tool_calls: [] },
          /* 问出去之后手机才打开 / 重连 —— 不给快照，卡就丢了 (手机靠这个重建卡片) */
          pending_actions: { approvals: [], ask_user: this.translator.pendingAskUsers() },
        });
      case 'session.status':
        return ok(this.translator.status());
      case 'session.history': {
        const before = Number(params.before_seq ?? Number.MAX_SAFE_INTEGER);
        const limit = Number(params.limit ?? 200);
        /* 一页里工具输出多了会超中转上限 —— 从旧的那头砍, 手机按最早那条的 seq 往前翻页 */
        let messages = this.translator.getHistory(before, limit);
        while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages), 'utf8') > ENVELOPE_LIMIT * 0.6) {
          messages = messages.slice(Math.ceil(messages.length / 2));
        }
        return ok({ messages, latest_seq: this.translator.latestSeq() });
      }
      case 'model.list':
        return ok({ models: s.modelId ? [{ id: s.modelId, name: s.modelId, provider: 'Neox', provider_id: 'cli' }] : [] });
      case 'workspace.list':
        return ok({ workspaces: [{ workspace_path: s.workspacePath, workspace_name: summary().workspace_name, recent_session_id: s.id }] });
      case 'workspace.list_recent':
        return ok({ workspaces: [] });
      case 'system.pong':
        return null;
      case 'session.input': {
        const kind = String(params.kind ?? '');
        const payload = (params.payload ?? {}) as Record<string, any>;
        if (kind === 'user_message' || kind === 'inject_message') {
          const text = String(payload.text ?? payload.content ?? '').trim();
          if (!text) return err(-32602, 'message text required (终端会话暂不收图片 / 文件)');
          await this.opts.onUserMessage(text);
          return ok({ ok: true });
        }
        const action = kind.startsWith('control:') ? kind.slice(8) : kind === 'control' ? String(payload.action ?? '') : '';
        if (action === 'stop' || action === 'cancel' || action === 'interrupt') {
          await this.opts.onStop();
          return ok({ ok: true });
        }
        if (action === 'ask_user_reply' && this.opts.onAskUserReply) {
          const requestId = String(payload.request_id ?? payload.requestId ?? '').trim();
          if (!requestId) return err(-32602, 'ask_user_reply requires request_id');
          this.translator.resolveAskUser(requestId);
          this.opts.onAskUserReply(requestId, payload.answers);
          return ok({ ok: true });
        }
        return err(-32601, `终端会话不支持: ${kind}${action ? `:${action}` : ''}`);
      }
      default:
        return err(-32601, `终端会话不支持: ${msg.method}`);
    }
  }

  private broadcast(msg: RpcMessage): void {
    for (const peer of this.watchers.values()) this.sendTo(peer, msg);
  }

  private sendTo(peer: { phone: string; endpoint?: string }, msg: RpcMessage): void {
    const ws = this.ws;
    const key = this.keys.get(peer.phone);
    if (!ws || ws.readyState !== WebSocket.OPEN || !key) return;
    const to = { device: peer.phone, ep: peer.endpoint };
    let parts = this.link.seal(key, to, msg);
    /* v1 单条超过中转上限会断整条连接: 请求的回包换成明确错误, 推送直接丢。v2 自动分片不受限 */
    if (typeof parts[0] === 'string' && Buffer.byteLength(parts[0], 'utf8') > ENVELOPE_LIMIT) {
      if (msg.id == null) return;
      parts = this.link.seal(key, to, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'payload too large for relay' } });
    }
    for (const p of parts) ws.send(p, { binary: typeof p !== 'string' });
  }
}
