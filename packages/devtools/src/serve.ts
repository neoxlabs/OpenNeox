/**
 * devtools web 桥接服务。
 *
 *   发现/连上产品 server(WSGateway)→ 跑 MonitorAggregator → 把 MonitorState 通过
 *   SSE 推给浏览器, 同时托管 React 静态页(web/dist)。
 *
 * 浏览器侧零 node 依赖、不碰 token —— 只连本服务的 /api/stream。
 *
 * 用法: neox-devtools serve [--port 7399] [--attach host:port] [--token t] [--workdir dir]
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverEndpoint, parseManualTarget } from './discovery.js';
import { MonitorAggregator } from './aggregator.js';
import { MonitorClient } from './monitorClient.js';
import type { MonitorState, ServerEndpoint } from './types.js';

export interface ServeOptions {
  port?: number;
  attach?: string;
  token?: string;
  workdir?: string;
  /** SSE 推送间隔 ms */
  intervalMs?: number;
  onLog?: (msg: string) => void;
}

export interface DashboardServerOptions {
  /** 返回当前 MonitorState 的函数(外部桥接:aggregator.snapshot;深度模式:含控制平面的 snapshot) */
  snapshot: () => MonitorState;
  port?: number;
  intervalMs?: number;
  onLog?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function webDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/serve.ts(tsx 直跑)→ ../web/dist;若编译到 dist/ 则同样向上找 web/dist
  return path.resolve(here, '..', 'web', 'dist');
}

export function serve(opts: ServeOptions = {}): http.Server {
  const intervalMs = opts.intervalMs ?? 1000;
  const log = (m: string) => (opts.onLog ?? ((s) => console.log(`[devtools-serve] ${s}`)))(m);

  let endpoint: ServerEndpoint | null;
  if (opts.attach) endpoint = parseManualTarget(opts.attach, opts.token);
  else endpoint = discoverEndpoint(opts.workdir);

  const aggregator = new MonitorAggregator();
  if (endpoint) {
    const client = new MonitorClient({ endpoint, aggregator, statusPollMs: 5000, onLog: log });
    client.start();
    log(`bridging product server ${endpoint.host}:${endpoint.port}`);
  } else {
    log('no product server found — web will show "disconnected" until one starts');
  }

  return startDashboardServer({
    snapshot: () => aggregator.snapshot(),
    port: opts.port ?? 7399,
    intervalMs,
    onLog: opts.onLog,
  });
}

/**
 * 通用仪表盘服务 —— 给定一个 snapshot() 源, 起 HTTP(静态 React 页) + SSE(/api/stream)。
 * 外部桥接(serve)和 in-process 深度模式(attach)共用这一条出口。
 */
export function startDashboardServer(opts: DashboardServerOptions): http.Server {
  const port = opts.port ?? 7399;
  const intervalMs = opts.intervalMs ?? 1000;
  const log = (m: string) => (opts.onLog ?? ((s) => console.log(`[devtools-serve] ${s}`)))(m);

  const sseClients = new Set<http.ServerResponse>();

  // 发给浏览器前剥掉 token —— 浏览器渲染不需要凭据(纵深防御)
  const sanitized = (): MonitorState => {
    const snap = opts.snapshot();
    if (snap.endpoint) snap.endpoint = { ...snap.endpoint, token: undefined } as ServerEndpoint;
    return snap;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('\n');
      sseClients.add(res);
      res.write(`data: ${JSON.stringify(sanitized())}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(sanitized()));
      return;
    }

    serveStatic(url.pathname, res, log);
  });

  const timer = setInterval(() => {
    if (sseClients.size === 0) return;
    const frame = `data: ${JSON.stringify(sanitized())}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();

  server.on('error', (e: any) => log(`server error: ${e?.message ?? e}`));
  server.listen(port, '127.0.0.1', () => {
    log(`dashboard → http://127.0.0.1:${port}`);
  });

  return server;
}

function serveStatic(pathname: string, res: http.ServerResponse, log: (m: string) => void): void {
  const dist = webDistDir();
  if (!fs.existsSync(dist)) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>web/dist not built</h2><p>Run <code>npm run build</code> in packages/devtools/web first.</p>`);
    return;
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(dist, rel);
  // SPA fallback
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(dist, 'index.html');
  }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch (e: any) {
    res.writeHead(404); res.end('not found');
  }
}
