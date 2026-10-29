import { describe, expect, it, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

const logs: string[] = [];
vi.mock('../log.js', () => ({
  bridgeLog: (tag: string, msg: string) => { logs.push(`${tag} ${msg}`); },
}));

import { CloudRelayClient, type CloudRelayConfig } from '../cloudRelayClient.js';
import {
  encryptAesGcm,
  decryptAesGcm,
  randomNonce,
  makeEnvelope,
} from '@neoxlabs/core/relay-transport/index.js';

const DESKTOP_ID = 'desktop-under-test';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  logs.length = 0;
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as net.AddressInfo;
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

async function startRelay(port = 0, opts: { autoPong?: boolean } = {}) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1', autoPong: opts.autoPong ?? true });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const conns: ServerSocket[] = [];
  const waiters: Array<(s: ServerSocket) => void> = [];
  wss.on('connection', (s) => {
    conns.push(s);
    const w = waiters.shift();
    if (w) w(s);
  });
  const nextConn = (timeoutMs = 4000) => new Promise<ServerSocket>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no connection in time')), timeoutMs);
    waiters.push((s) => { clearTimeout(t); resolve(s); });
  });
  cleanups.push(() => new Promise<void>((r) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => r());
  }));
  return { wss, conns, nextConn, port: (wss.address() as net.AddressInfo).port };
}

function makeClient(port: number, over: Partial<CloudRelayConfig>): CloudRelayClient {
  const client = new CloudRelayClient({
    serverBaseUrl: `http://127.0.0.1:${port}`,
    bearerJwt: 'jwt',
    desktopDeviceId: DESKTOP_ID,
    getMobileKey: () => null,
    dispatch: async () => null,
    ...over,
  });
  cleanups.push(() => client.dispose());
  return client;
}

function encryptedEnvelopeFrom(peer: string, key: Buffer, msg: object): string {
  const nonce = randomNonce();
  const ciphertext = encryptAesGcm(key, nonce, Buffer.from(JSON.stringify(msg), 'utf8'));
  return JSON.stringify(makeEnvelope({ toDeviceId: DESKTOP_ID, fromDeviceId: peer, nonce, ciphertext }));
}

function nextMessage(s: ServerSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no message in time')), timeoutMs);
    s.once('message', (d) => { clearTimeout(t); resolve(d.toString()); });
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('CloudRelayClient — key 现查', () => {
  it('连上之后才配对进来的手机, 消息照样被处理并加密回包', async () => {
    const relay = await startRelay();
    const keys = new Map<string, Buffer>();
    const dispatched: Array<{ method?: string; from: string }> = [];
    const client = makeClient(relay.port, {
      getMobileKey: (id) => keys.get(id) ?? null,
      dispatch: async (msg, from) => {
        dispatched.push({ method: msg.method, from });
        return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
      },
    });
    const connP = relay.nextConn();
    await client.connect();
    const server = await connP;

    /* 连接建立之后才"账号自动配对"进来 —— 旧实现的快照里永远没有它 */
    const phone = 'phone-paired-later';
    const key = crypto.randomBytes(32);
    keys.set(phone, key);

    const replyP = nextMessage(server);
    server.send(encryptedEnvelopeFrom(phone, key, { jsonrpc: '2.0', id: 1, method: 'session.list' }));
    const reply = JSON.parse(await replyP);
    expect(dispatched).toEqual([{ method: 'session.list', from: phone }]);
    expect(reply.to_device_id).toBe(phone);
    const plain = decryptAesGcm(key, Buffer.from(reply.nonce, 'base64'), Buffer.from(reply.ciphertext, 'base64'));
    expect(JSON.parse(plain.toString('utf8'))).toMatchObject({ id: 1, result: { ok: true } });
  });

  it('不认识的 peer 先按需补配对再查一次, 补上了就正常处理', async () => {
    const relay = await startRelay();
    const keys = new Map<string, Buffer>();
    const phone = 'phone-registered-just-now';
    const key = crypto.randomBytes(32);
    const unknownCalls: string[] = [];
    let dispatchedFrom: string | null = null;
    const client = makeClient(relay.port, {
      getMobileKey: (id) => keys.get(id) ?? null,
      onUnknownPeer: async (id) => { unknownCalls.push(id); keys.set(phone, key); return true; },
      dispatch: async (_msg, from) => { dispatchedFrom = from; return null; },
    });
    const connP = relay.nextConn();
    await client.connect();
    const server = await connP;

    server.send(encryptedEnvelopeFrom(phone, key, { jsonrpc: '2.0', method: 'ping' }));
    await waitFor(() => dispatchedFrom !== null);
    expect(unknownCalls).toEqual([phone]);
    expect(dispatchedFrom).toBe(phone);
  });

  it('补配对后仍不认识 → 不 dispatch, 日志带完整 peer id', async () => {
    const relay = await startRelay();
    const dispatch = vi.fn(async () => null);
    const peer = 'stranger-device-id-with-a-long-suffix-0123456789';
    const client = makeClient(relay.port, {
      onUnknownPeer: async () => true,
      dispatch,
    });
    const connP = relay.nextConn();
    await client.connect();
    const server = await connP;

    server.send(encryptedEnvelopeFrom(peer, crypto.randomBytes(32), { jsonrpc: '2.0', method: 'x' }));
    await waitFor(() => logs.some((l) => l.includes('DROP: unknown peer')));
    expect(dispatch).not.toHaveBeenCalled();
    expect(logs.find((l) => l.includes('DROP: unknown peer'))).toContain(peer);
  });
});

describe('CloudRelayClient — 首连失败 / dispose', () => {
  it('首连失败后自己重连上 (调用方保留引用即可拿到真实状态)', async () => {
    const port = await freePort();
    const client = makeClient(port, {});
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.isConnected()).toBe(false);

    const relay = await startRelay(port);
    await relay.nextConn(4000);
    await waitFor(() => client.isConnected(), 2000);
  });

  it('dispose 之后不再重连', async () => {
    const port = await freePort();
    const client = makeClient(port, {});
    await expect(client.connect()).rejects.toBeTruthy();
    await client.dispose();

    const relay = await startRelay(port);
    await new Promise((r) => setTimeout(r, 2000));
    expect(relay.conns.length).toBe(0);
  });

  it('refreshToken 期间被 dispose, 不会在停掉之后又拨出连接', async () => {
    const relay = await startRelay();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const client = makeClient(relay.port, {
      refreshToken: async () => { await gate; return 'fresh'; },
    });
    const p = client.connect();
    await client.dispose();
    release();
    await p;
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.conns.length).toBe(0);
  });
});

describe('CloudRelayClient — 客户端心跳', () => {
  it('收不到 pong 就断开并重连, 不等服务端 90s 读超时', async () => {
    /* autoPong:false = 模拟半开的死链: TCP 还在, 对端已经不回任何东西 */
    const relay = await startRelay(0, { autoPong: false });
    const states: boolean[] = [];
    const client = makeClient(relay.port, { heartbeat: { intervalMs: 50, pongTimeoutMs: 200 } });
    client.onConnectionStateChange((c) => states.push(c));
    const firstP = relay.nextConn();
    await client.connect();
    await firstP;
    const secondP = relay.nextConn(4000);
    await waitFor(() => states.includes(false), 2000);
    expect(logs.some((l) => l.includes('heartbeat: no pong'))).toBe(true);
    await secondP;
    await waitFor(() => client.isConnected(), 2000);
  });

  it('正常回 pong 的连接不会被心跳误杀', async () => {
    const relay = await startRelay();
    const states: boolean[] = [];
    const client = makeClient(relay.port, { heartbeat: { intervalMs: 50, pongTimeoutMs: 200 } });
    client.onConnectionStateChange((c) => states.push(c));
    const firstP = relay.nextConn();
    await client.connect();
    await firstP;
    await new Promise((r) => setTimeout(r, 800));
    expect(states).toEqual([true]);
    expect(relay.conns.length).toBe(1);
  });
});

describe('CloudRelayClient — 唤醒重拨', () => {
  it('断开后 wakeNow 立刻重拨, 不等退避', async () => {
    const relay = await startRelay();
    const client = makeClient(relay.port, {});
    const firstP = relay.nextConn();
    await client.connect();
    const first = await firstP;

    /* 服务端把它踢掉 —— 客户端进退避 (第一档就已经是 1s+jitter) */
    const secondP = relay.nextConn();
    first.close();
    await waitFor(() => client.isConnected() === false);

    const t0 = Date.now();
    client.wakeNow('test');
    await secondP;
    await waitFor(() => client.isConnected() === true);
    /* 关键: 不是"最终连上了", 而是**马上**连上了 */
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('已经连着时 wakeNow 不另起一条连接', async () => {
    const relay = await startRelay();
    const client = makeClient(relay.port, {});
    const firstP = relay.nextConn();
    await client.connect();
    await firstP;
    await waitFor(() => client.isConnected() === true);

    client.wakeNow('test');
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.conns.length).toBe(1);
    expect(client.isConnected()).toBe(true);
  });
});
