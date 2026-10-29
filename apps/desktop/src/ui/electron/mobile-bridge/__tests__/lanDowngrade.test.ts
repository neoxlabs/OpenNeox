import { describe, expect, it, afterEach } from 'vitest';
import * as http from 'node:http';

/* 直接用 node:http 复刻 enableLan/disableLan 的重绑序列。
 * 不 import MobileBridgeServer 是因为它会拉起 ws/electron 依赖链和设备存储;
 * 这里要验的恰恰是**重绑这一步本身**成不成立 (同 port、地址真的变了)。 */
async function listenOn(server: http.Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error) => { server.removeListener('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(port, host, () => { server.removeListener('error', onErr); resolve(); });
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return addr.port;
}

function boundHost(server: http.Server): string {
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('not listening');
  return addr.address;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 1500);
    t.unref?.();
    server.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
  });
}

let live: http.Server | null = null;
afterEach(async () => { if (live) { await closeServer(live); live = null; } });

describe('0.0.0.0 → 127.0.0.1 真的收得回来', () => {
  it('升级后确实绑在 0.0.0.0, 降级后确实只剩 loopback', async () => {
    const server = http.createServer(() => {});
    live = server;

    const port = await listenOn(server, '127.0.0.1', 0);
    expect(boundHost(server)).toBe('127.0.0.1');

    /* enableLan(): 先关 loopback listener 再同 port 重绑 0.0.0.0 */
    await closeServer(server);
    await listenOn(server, '0.0.0.0', port);
    expect(boundHost(server)).toBe('0.0.0.0');

    /* disableLan(): 反过来走一遍 —— 这一步原来根本不存在 */
    await closeServer(server);
    const back = await listenOn(server, '127.0.0.1', port);
    expect(boundHost(server)).toBe('127.0.0.1');
    /* 端口保持不变: 用户马上又去配对时 enableLan() 同 port 重绑才能成 */
    expect(back).toBe(port);
  });

  it('降级之后局域网地址真的连不上了 —— 这才是这条 bug 的止损点', async () => {
    const server = http.createServer((_req, res) => { res.end('ok'); });
    live = server;
    const port = await listenOn(server, '0.0.0.0', 0);

    /* 绑 0.0.0.0 时, 用一个非 loopback 的本机 IP 也能连上 */
    const os = await import('node:os');
    const lanIp = Object.values(os.networkInterfaces()).flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    const reach = (host: string) => new Promise<boolean>((resolve) => {
      const req = http.get({ host, port, timeout: 1200, agent: false }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });

    if (lanIp) expect(await reach(lanIp), '绑 0.0.0.0 时局域网地址应可达').toBe(true);

    await closeServer(server);
    await listenOn(server, '127.0.0.1', port);

    expect(await reach('127.0.0.1'), '降级后本机仍应可达').toBe(true);
    if (lanIp) {
      const control = http.createServer((_q, r) => { r.end('ok'); });
      const controlPort = await listenOn(control, '127.0.0.1', 0);
      const controlReach = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: lanIp, port: controlPort, timeout: 1200, agent: false },
          (res) => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      await closeServer(control);

      if (controlReach) {
        /* 这台机器的 lanIp 被某种转发接管, 这条止损点在这里测不了 */
        expect(boundHost(server), '至少要确认服务确实降级绑回了 127.0.0.1').toBe('127.0.0.1');
      } else {
        expect(await reach(lanIp), '降级后局域网地址仍然可达 = 没收回来').toBe(false);
      }
    }
  });
});
