/**
 * Neox 客户端发往 cloud gateway 时统一带的 User-Agent.
 *
 *   不带 UA 的话, axios 默认就是 "axios/X.Y.Z" — 在 /usage 流水里跟 OS 完全隔绝,
 *   用户根本看不出"是 Mac 还是 Windows 的客户端发的". 自带 UA 后:
 *
 *     Neox-Desktop/0.1.0 (macOS; arm64; Electron/33.0.0)
 *     Neox-CLI/0.1.0     (Linux;  x64;  Node/22.16.0)
 *
 *   web 那边 deviceLabel() 解析这个格式给最终用户显:
 *     Neox 客户端 · macOS / Neox CLI · Linux 等.
 *
 *   不存敏感信息 — 只是公开 OS + arch + runtime, 跟普通浏览器 UA 同等暴露面.
 */

import os from 'os';
import { VERSION } from '../version.js';

function platformLabel(): string {
  switch (process.platform) {
    case 'darwin':  return 'macOS';
    case 'win32':   return 'Windows';
    case 'linux':   return 'Linux';
    case 'android': return 'Android';
    case 'freebsd': return 'FreeBSD';
    case 'openbsd': return 'OpenBSD';
    default:        return process.platform;
  }
}

let cachedUserAgent: string | null = null;

export function getNeoxUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  const isElectron = !!(process.versions as Record<string, string | undefined>).electron;
  const product = isElectron ? 'Neox-Desktop' : 'Neox-CLI';
  const electronV = (process.versions as Record<string, string | undefined>).electron;
  const runtime = isElectron && electronV
    ? `Electron/${electronV}`
    : `Node/${process.versions.node}`;
  cachedUserAgent = `${product}/${VERSION} (${platformLabel()}; ${os.arch()}; ${runtime})`;
  return cachedUserAgent;
}
