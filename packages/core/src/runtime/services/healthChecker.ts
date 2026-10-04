/**
 * healthChecker — 给 bound 进程做周期 healthcheck.
 *
 *   触发: 进程 register + 绑 configId + config 有 healthcheck 字段时, 启动 5s 周期检测.
 *   退出: 进程 markCompleted / configId 解绑 / 进程被 kill 时停.
 *
 *   三种探针:
 *     http:           target = 'http://host:port/path', 200-399 通过, 其他 fail
 *     port:           target = '3000', TCP connect 通过即 healthy
 *     log_pattern:    target = regex, ring buffer 含命中即 healthy (一次性, 命中后不再探)
 *
 *   状态变化:
 *     从 unknown / failed → healthy → emit process:health-changed(true)
 *     从 healthy → failed → emit process:health-changed(false)
 *
 *   一个进程一个 interval, 跨进程独立. 进程退出自动清理 (依赖 ProcessManager 事件).
 */

import * as http from 'node:http';
import * as net from 'node:net';
import type { ProcessManager, TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';
import type { ServiceConfig } from './serviceConfigStore.js';

const POLL_INTERVAL_MS = 5_000;
const HTTP_TIMEOUT_MS = 2_000;
const TCP_TIMEOUT_MS = 1_500;

interface ProbeState {
  timer: ReturnType<typeof setInterval>;
  lastHealthy: boolean;
  /** log_pattern 命中后 latched, 不再探 (避免误回退到 false) */
  latched: boolean;
}

const PROBES = new Map<number, ProbeState>();

export function startHealthCheck(
  pm: ProcessManager,
  pid: number,
  config: ServiceConfig,
): void {
  if (!config.healthcheck) return;
  if (PROBES.has(pid)) return; /* 已在跑 */

  const probe = async () => {
    const proc = pm.get(pid);
    if (!proc || proc.status !== 'running') {
      stopHealthCheck(pid);
      return;
    }
    const ok = await runProbe(proc, config);
    const state = PROBES.get(pid);
    if (!state) return;
    if (ok && config.healthcheck!.kind === 'log_pattern') {
      state.latched = true;
    }
    /* 写回 ProcessManager 字段 — UI 直接看 proc.healthy / proc.healthCheckedAt */
    pm.setHealthy(pid, ok);
    if (ok !== state.lastHealthy) {
      state.lastHealthy = ok;
      pm.emit('process:health-changed', proc, ok);
    }
    if (state.latched) {
      /* log_pattern 一旦命中, 不再轮询 — 节省 CPU */
      clearInterval(state.timer);
    }
  };

  const timer = setInterval(probe, POLL_INTERVAL_MS);
  PROBES.set(pid, { timer, lastHealthy: false, latched: false });
  /* 立即跑一次, 不等 5s 才出第一次结果 */
  void probe();
}

export function stopHealthCheck(pid: number): void {
  const state = PROBES.get(pid);
  if (!state) return;
  clearInterval(state.timer);
  PROBES.delete(pid);
}

async function runProbe(proc: TrackedProcess, config: ServiceConfig): Promise<boolean> {
  const hc = config.healthcheck!;
  switch (hc.kind) {
    case 'http': return probeHttp(hc.target, hc.timeoutMs ?? HTTP_TIMEOUT_MS);
    case 'port': {
      const portNum = parseInt(hc.target, 10);
      if (!Number.isFinite(portNum) || portNum <= 0) return false;
      return probeTcp(portNum, hc.timeoutMs ?? TCP_TIMEOUT_MS);
    }
    case 'log_pattern': return probeLogPattern(proc, hc.target);
  }
  return false;
}

function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const req = http.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        settle(status >= 200 && status < 400);
      });
      req.on('timeout', () => { req.destroy(); settle(false); });
      req.on('error', () => settle(false));
      req.end();
    } catch { settle(false); }
  });
}

function probeTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = new net.Socket();
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => settle(true));
    sock.once('timeout', () => settle(false));
    sock.once('error', () => settle(false));
    sock.connect(port, '127.0.0.1');
  });
}

function probeLogPattern(proc: TrackedProcess, pattern: string): boolean {
  try {
    const re = new RegExp(pattern);
    const buf = (proc.outputBuffer ?? []).join('\n');
    return re.test(buf);
  } catch {
    return false;
  }
}
