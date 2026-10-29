
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as os from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface RoutingConfig {
  version: number;
  enabled: boolean;
  gatewayBase: string;
  routableProtocols: string[];
}

export const DEFAULT_GATEWAY_BASE = 'https://gateway.neox-dev.com/n1';
export const DEFAULT_ROUTABLE_PROTOCOLS = [
  'openai', 'openai-responses', 'kimi', 'deepseek', 'minimax', 'qwen', 'glm', 'doubao', 'anthropic', 'anthropic-openai',
];

export function defaultRoutingFilePath(): string {
  return join(os.homedir(), NEOX_HOME_DIRNAME, 'routing.json');
}

/** 跨进程文件锁 — O_EXCL 创建, 30s 陈旧抢占, 最多等 5s。与 config.json 的锁同款语义。 */
function withRoutingLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const STALE_MS = 30_000;
  const WAIT_MS = 5_000;
  const start = Date.now();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch {
      /* 锁已存在: 陈旧则抢占, 否则轮询等待 */
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_MS) { try { unlinkSync(lockPath); } catch { /* race */ } continue; }
      } catch { /* 锁刚被释放, 重试 */ }
      if (Date.now() - start > WAIT_MS) break; /* 等超时: 放弃锁直接写 (best-effort, 不阻塞登录) */
      /* 短暂自旋等待 (无 async, 同步上下文) */
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readExisting(path: string): Partial<RoutingConfig> & Record<string, unknown> {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { /* 损坏 → 当空 */ }
  return {};
}

export function writeRoutingConfig(patch: Partial<RoutingConfig>, opts: { path?: string } = {}): void {
  const path = opts.path || defaultRoutingFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  withRoutingLock(path, () => {
    const cur = readExisting(path);
    const next: RoutingConfig = {
      version: 2,
      enabled: patch.enabled ?? (typeof cur.enabled === 'boolean' ? cur.enabled : true),
      gatewayBase: (patch.gatewayBase ?? (typeof cur.gatewayBase === 'string' ? cur.gatewayBase : DEFAULT_GATEWAY_BASE))
        .replace(/\/+$/, '')
        .replace(/^https:\/\/neox-dev\.com(?:\/n1)?$/, DEFAULT_GATEWAY_BASE),
      routableProtocols: patch.routableProtocols ?? (Array.isArray(cur.routableProtocols) ? cur.routableProtocols as string[] : DEFAULT_ROUTABLE_PROTOCOLS),
    };
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    try { if (process.platform !== 'win32') chmodSync(tmp, 0o600); } catch { /* ignore */ }
    renameSync(tmp, path);
  });
}

/** 关路由 (登出): enabled=false, 同样只动非机密字段。 */
export function disableRoutingConfig(opts: { path?: string } = {}): void {
  const path = opts.path || defaultRoutingFilePath();
  if (!existsSync(path)) return;
  writeRoutingConfig({ enabled: false }, { path });
}
