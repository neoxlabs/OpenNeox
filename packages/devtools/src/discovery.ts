/**
 * 服务发现 —— 从 ~/.neox 下的 pidfile 找出正在跑的 Neox server 的 port + token。
 *
 * 产品侧 server 启动时把 { pid, port, token, workDir } 写进:
 *   · ~/.neox/server.pid            (全局最近一个)
 *   · ~/.neox/server-<hash>.pid     (按 workdir+身份 scoped)
 *
 * devtools 只读这些文件来定位"连哪个 server"。纯读, 零产品改动。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ServerEndpoint } from './types.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const NEOX_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME);

interface PidInfoLike {
  pid?: number;
  port?: number;
  token?: string;
  workDir?: string;
  startedAt?: number;
}

function readJson(file: string): PidInfoLike | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as PidInfoLike;
  } catch {
    return null;
  }
}

function toEndpoint(info: PidInfoLike | null): ServerEndpoint | null {
  if (!info || !info.port) return null;
  return {
    host: '127.0.0.1',
    port: info.port,
    token: info.token,
    pid: info.pid,
    workDir: info.workDir,
    source: 'pidfile',
  };
}

/**
 * 发现所有可连的 server endpoint(去重, 按 startedAt 倒序)。
 * 扫 ~/.neox/server.pid + 所有 server-*.pid。
 */
export function discoverEndpoints(): ServerEndpoint[] {
  const seen = new Map<number, ServerEndpoint>();
  const candidates: PidInfoLike[] = [];

  const main = readJson(path.join(NEOX_DIR, 'server.pid'));
  if (main) candidates.push(main);

  try {
    for (const name of fs.readdirSync(NEOX_DIR)) {
      if (/^server-[0-9a-f]+\.pid$/.test(name)) {
        const info = readJson(path.join(NEOX_DIR, name));
        if (info) candidates.push(info);
      }
    }
  } catch {
    /* ~/.neox 不存在 → 没 server 在跑 */
  }

  for (const info of candidates) {
    const ep = toEndpoint(info);
    if (ep && ep.port && !seen.has(ep.port)) {
      seen.set(ep.port, ep);
    }
  }
  return [...seen.values()];
}

/**
 * 选一个 endpoint:
 *   · 指定 workDir → 优先匹配该 workspace 的 server
 *   · 否则取第一个(全局最近)
 */
export function discoverEndpoint(workDir?: string): ServerEndpoint | null {
  const all = discoverEndpoints();
  if (all.length === 0) return null;
  if (workDir) {
    const target = path.resolve(workDir);
    const match = all.find((e) => e.workDir && path.resolve(e.workDir) === target);
    if (match) return match;
  }
  return all[0];
}

/** 解析 `host:port` 形式的手动地址 */
export function parseManualTarget(target: string, token?: string): ServerEndpoint {
  const [host, portStr] = target.split(':');
  const port = parseInt(portStr, 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid --attach target "${target}", expected host:port`);
  }
  return { host, port, token, source: 'manual' };
}

/** 拼出 WS URL(带 token 与 device 标识) */
export function buildWsUrl(ep: ServerEndpoint, deviceId: string): string {
  const params = new URLSearchParams();
  params.set('device', deviceId);
  if (ep.token) params.set('token', ep.token);
  return `ws://${ep.host}:${ep.port}/ws?${params.toString()}`;
}
