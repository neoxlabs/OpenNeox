/**
 * 选路 —— 真 SOCKS5 服务器 + 真 HTTP 代理, 端到端验证请求确实走了该走的路
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 钉三件事 (对应用户 定的立场: 跟随, 不替他决定):
 *   ① SOCKS 通道真的能用 —— undici 原生不支持 SOCKS, 旧实现里"只开 SOCKS 的用户"
 *      被判成无代理直连, 这条用例就是防它回来。
 *   ② 逐 scheme 独立: 用户只给 http 配了代理, https 槽空着, https 请求就该**直连**,
 *      反之亦然。旧实现 `httpsProxy || httpProxy` 会替用户把没开的通道补上。
 *   ③ 回环无条件直连 (本地 daemon / dev server 被塞进代理就是黑洞)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { request } from 'undici';
import { SystemProxyDispatcher } from '../proxy/dispatcher.js';
import { emptyProxyConfig, type SystemProxyConfig } from '../proxy/types.js';

/* ───────── 最小 SOCKS5 CONNECT 服务器 (只实现测试需要的部分) ───────── */
async function startSocks5(): Promise<{ port: number; connections: string[]; close: () => Promise<void> }> {
  const connections: string[] = [];
  const server = createTcpServer((client) => {
    let stage: 'greet' | 'request' | 'piping' = 'greet';
    client.on('data', (chunk) => {
      if (stage === 'greet') {
        client.write(Buffer.from([0x05, 0x00]));   /* 无需认证 */
        stage = 'request';
        return;
      }
      if (stage === 'request') {
        /* VER CMD RSV ATYP ADDR... PORT(2) */
        const atyp = chunk[3];
        let host = ''; let offset = 4;
        if (atyp === 0x01) { host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`; offset = 8; }
        else if (atyp === 0x03) { const len = chunk[4]; host = chunk.subarray(5, 5 + len).toString(); offset = 5 + len; }
        const port = chunk.readUInt16BE(offset);
        connections.push(`${host}:${port}`);
        const upstream = tcpConnect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'piping';
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => { client.destroy(); });
      }
    });
    client.on('error', () => { /* 测试里断连是正常的 */ });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { port, connections, close: () => new Promise((r) => server.close(() => r())) };
}

/* ───────── 最小 HTTP 正向代理 ─────────
 * undici 的 ProxyAgent 一律用 CONNECT 隧道 (对 http:// 目标也是), 所以这里实现 CONNECT,
 * 而不是绝对 URI 的 GET。 */
async function startHttpProxy(): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createHttpServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    requests.push(req.url ?? '');
    const [host, portRaw] = (req.url ?? '').split(':');
    const upstream = tcpConnect(Number(portRaw) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as { port: number }).port,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function startTarget(): Promise<{ port: number; hits: number; close: () => Promise<void> }> {
  const state = { hits: 0 };
  const server: Server = createHttpServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  /* 监听全部网卡: 用例要用一个**非回环**地址访问它, 否则会命中"回环无条件直连"规则 */
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  return {
    port: (server.address() as { port: number }).port,
    get hits() { return state.hits; },
    close: () => new Promise((r) => server.close(() => r())),
  } as { port: number; hits: number; close: () => Promise<void> };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
});

function cfgWith(patch: Partial<SystemProxyConfig>): SystemProxyConfig {
  return { ...emptyProxyConfig(), source: 'system', ...patch };
}

/* 目标 host 必须是**非回环**地址, 否则命中"回环无条件直连"规则, 测不出选路。
 * 十进制别名 (2130706433) 不行 —— WHATWG URL 会把它规范化回 127.0.0.1。
 * 所以取本机的局域网 IP; 没有网卡的环境 (纯 CI 容器) 跳过这几条。 */
function lanIPv4(): string | null {
  /* "第一个非回环网卡" 不够 —— 开着 VPN / 分流代理的机器上第一个往往是 utun,
   * 地址落在 198.18.0.0/15 (基准测试保留段, Clash/Surge 常用) 这类不可达段上,
   * 于是这几条用例在本机必红 (SocketError: other side closed), 看着像代理选路坏了,
   * 其实是测试挑错了地址。只认真实私有网段: 10/8, 172.16/12, 192.168/16。 */
  const isPrivate = (ip: string): boolean => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  };
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && isPrivate(ni.address)) return ni.address;
    }
  }
  return null;
}
const LAN = lanIPv4();
const itLan = LAN ? it : it.skip;

describe('选路 · SOCKS 通道', () => {
  itLan('只配 SOCKS 时, HTTP 请求经 SOCKS 隧道到达目标', async () => {
    const target = await startTarget(); cleanups.push(target.close);
    const socks = await startSocks5(); cleanups.push(socks.close);
    const dispatcher = new SystemProxyDispatcher(cfgWith({
      socks: { kind: 'socks5', host: '127.0.0.1', port: socks.port },
    }));
    const res = await request(`http://${LAN}:${target.port}/ping`, { dispatcher });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('ok');
    expect(socks.connections).toEqual([`${LAN}:${target.port}`]);
  });
});

describe('选路 · 逐 scheme 独立 (不替用户合成他没开的通道)', () => {
  itLan('http 槽配了代理 → http 请求走代理', async () => {
    const target = await startTarget(); cleanups.push(target.close);
    const proxy = await startHttpProxy(); cleanups.push(proxy.close);
    const dispatcher = new SystemProxyDispatcher(cfgWith({
      http: { kind: 'http', host: '127.0.0.1', port: proxy.port },
    }));
    const res = await request(`http://${LAN}:${target.port}/via-proxy`, { dispatcher });
    expect(res.statusCode).toBe(200);
    expect(proxy.requests).toHaveLength(1);
  });

  itLan('只配 https 槽 → http 请求【直连】, 不借用 https 的代理', async () => {
    const target = await startTarget(); cleanups.push(target.close);
    const proxy = await startHttpProxy(); cleanups.push(proxy.close);
    const dispatcher = new SystemProxyDispatcher(cfgWith({
      https: { kind: 'http', host: '127.0.0.1', port: proxy.port },
      http: null,
    }));
    const res = await request(`http://${LAN}:${target.port}/direct`, { dispatcher });
    expect(res.statusCode).toBe(200);
    expect(target.hits).toBe(1);
    expect(proxy.requests).toHaveLength(0);  /* ← 旧实现 (https||http 互相兜底) 会是 1 */
  });
});

describe('选路 · 回环无条件直连', () => {
  it('localhost/127.0.0.1 即使配了代理也不进代理', async () => {
    const target = await startTarget(); cleanups.push(target.close);
    const socks = await startSocks5(); cleanups.push(socks.close);
    const dispatcher = new SystemProxyDispatcher(cfgWith({
      socks: { kind: 'socks5', host: '127.0.0.1', port: socks.port },
      http: { kind: 'http', host: '127.0.0.1', port: 59999 },  /* 死端口: 一旦走代理必失败 */
    }));
    const res = await request(`http://127.0.0.1:${target.port}/health`, { dispatcher });
    expect(res.statusCode).toBe(200);
    expect(socks.connections).toHaveLength(0);
  });
});

describe('诊断 · explain()', () => {
  it('说得出每个 URL 走哪条路', async () => {
    const dispatcher = new SystemProxyDispatcher(cfgWith({
      http: { kind: 'http', host: '127.0.0.1', port: 7890 },
      socks: { kind: 'socks5', host: '127.0.0.1', port: 7891 },
      exceptions: ['*.internal.corp'],
    }));
    expect((await dispatcher.explain('http://example.com/')).via).toBe('http://127.0.0.1:7890');
    /* https 槽空 → 落到 SOCKS 全协议通道 (系统语义, 不是我们的兜底) */
    expect((await dispatcher.explain('https://example.com/')).via).toBe('socks5://127.0.0.1:7891');
    expect((await dispatcher.explain('https://git.internal.corp/')).via).toBe('direct');
    expect((await dispatcher.explain('http://127.0.0.1:4500/')).via).toBe('direct');
  });
});
