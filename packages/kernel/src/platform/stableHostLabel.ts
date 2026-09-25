/**
 * stableHostLabel.ts — 这台机器的**稳定**显示名。
 *
 * 任何要上报给服务端或显示在其他设备上的机器名都必须走这里，不能直接使用
 * `os.hostname()`；后者可能随 DHCP 或 mDNS 网络名变化。
 *
 * 稳定的来源:
 *   macOS   `scutil --get ComputerName` —— 用户自己在系统设置里起的名, 不随网络变
 *   Windows `%COMPUTERNAME%`
 *   Linux   `/etc/hostname`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';

let cached: string | null = null;

export function stableHostLabel(): string {
  if (cached) return cached;
  cached = compute();
  return cached;
}

function compute(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (out) return out;
    } else if (process.platform === 'win32') {
      const n = (process.env.COMPUTERNAME || '').trim();
      if (n) return n;
    } else {
      const n = readFileSync('/etc/hostname', 'utf-8').trim();
      if (n) return n;
    }
  } catch {
    /* 取不到就落到下面 */
  }
  /* 最后使用 os.hostname() 作为非空兜底，并去掉 .local 后缀。 */
  return os.hostname().replace(/\.local$/i, '') || 'Neox Device';
}
