import { describe, expect, it, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import * as net from 'node:net';

const logs: string[] = [];
vi.mock('../log.js', () => ({
  bridgeLog: (tag: string, msg: string) => { logs.push(`${tag} ${msg}`); },
}));

import { CloudRelayClient, type CloudRelayConfig } from '../cloudRelayClient.js';

const DESKTOP_ID = 'same-machine-device-id';

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

/** 复刻 cloud-relay 的 hub: (user, device) 只留一条 WS, 新连接踢掉旧连接。 */
async function startRelay(port = 0) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const byDevice = new Map<string, ServerSocket>();
  let registrations = 0;
  wss.on('connection', (s, req) => {
    const deviceId = String(req.headers['x-neox-device-id'] ?? '');
    registrations += 1;
    const old = byDevice.get(deviceId);
    if (old) {
      try { old.close(1000, 'displaced_by_new_conn'); } catch { /* ignore */ }
    }
    byDevice.set(deviceId, s);
    s.on('close', () => { if (byDevice.get(deviceId) === s) byDevice.delete(deviceId); });
  });
  cleanups.push(() => new Promise<void>((r) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => r());
  }));
  return {
    port: (wss.address() as net.AddressInfo).port,
    get registrations() { return registrations; },
    /** 服务端主动断 (重启 / 网络问题) —— 不是 displaced 那条路径。 */
    kick(reason = 'server_restart'): void {
      for (const c of wss.clients) {
        try { c.close(1000, reason); } catch { /* ignore */ }
      }
    },
    /** 模拟"同机另一个实例"拨进来 —— 直接开一条同 device_id 的裸连接。 */
    dialForeignConn(): WebSocket {
      const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/relay/api/v1/relay`, {
        headers: { 'X-Neox-Device-Id': DESKTOP_ID, 'X-Neox-Device-Type': 'desktop' },
      });
      cleanups.push(() => { try { ws.terminate(); } catch { /* ignore */ } });
      return ws;
    },
  };
}

function makeClient(port: number, over: Partial<CloudRelayConfig> = {}): CloudRelayClient {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dials = () => logs.filter((l) => l.includes('dialing')).length;

describe('CloudRelayClient — 被顶号 (displaced_by_new_conn)', () => {
  it('被顶号后不按 1s 快档重拨, 把通道让给对方', async () => {
    const relay = await startRelay();
    const client = makeClient(relay.port);
    await client.connect();
    await sleep(200);

    relay.dialForeignConn();
    await sleep(1500);
    expect(client.isConnected()).toBe(false);
    expect(logs.some((l) => l.includes('displaced by another conn'))).toBe(true);

    /* 关键: 5 秒内不许再拨 —— 旧行为是 1.1s 后就拨, 于是两边每 2 秒互顶一次。 */
    const afterDisplace = dials();
    await sleep(5000);
    expect(dials()).toBe(afterDisplace);
  }, 15000);

  it('普通断线仍然快档重拨 (别矫枉过正)', async () => {
    const relay = await startRelay();
    const client = makeClient(relay.port);
    await client.connect();
    await sleep(200);

    relay.kick();
    /* 直接用裸连接踢掉: 走"非 displaced"的断线路径 */
    await sleep(2500);
    expect(logs.filter((l) => l.includes('dialing')).length).toBeGreaterThanOrEqual(2);
    expect(client.isConnected()).toBe(true);
  }, 15000);

  it('并发 connect() 只拨一条 (两条并发 dial 会自己顶自己)', async () => {
    const relay = await startRelay();
    const client = makeClient(relay.port);
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    await sleep(500);
    expect(relay.registrations).toBe(1);
    expect(client.isConnected()).toBe(true);
  }, 15000);

  it('两个同 device_id 客户端互顶后收敛到单一持有者', async () => {
    const relay = await startRelay();
    const a = makeClient(relay.port);
    const b = makeClient(relay.port);
    await Promise.all([a.connect(), b.connect()]);
    /* 初始那一轮必然互顶 (两边几乎同时拨) —— 之后必须有一方退让并稳定下来 */
    await sleep(6000);
    const live = [a, b].filter((c) => c.isConnected());
    expect(live.length).toBe(1);
    const stable = relay.registrations;
    await sleep(3000);
    expect(relay.registrations).toBe(stable);
    expect(logs.some((l) => l.includes('displaced by another conn'))).toBe(true);
  }, 20000);
});
