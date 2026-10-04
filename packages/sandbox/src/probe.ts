/**
 * probe.ts —— 探测当前平台可用的沙盒后端 (纯 IO, 无 neox 依赖)。
 */

import * as fs from 'node:fs';
import type { SandboxBackend } from './types.js';
import { canLoadKoffi, canUseRestrictedToken } from './windows.js';
import { canUseAppContainer } from './windowsAppContainer.js';

export interface BackendProbe {
  backend: SandboxBackend;
  available: boolean;
  reason?: string;
}

function canExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let _cached: BackendProbe | undefined;

/** 探测并缓存最佳后端。 */
export function probeBackend(): BackendProbe {
  if (_cached) return _cached;
  _cached = computeProbe();
  return _cached;
}

/** 测试用: 清缓存。 */
export function resetProbeCache(): void {
  _cached = undefined;
}

function computeProbe(): BackendProbe {
  if (process.platform === 'darwin') {
    if (canExec('/usr/bin/sandbox-exec')) {
      return { backend: 'seatbelt', available: true };
    }
    return { backend: 'none', available: false, reason: 'macOS 缺 sandbox-exec (异常)' };
  }
  if (process.platform === 'linux') {
    if (canExec('/usr/bin/bwrap')) {
      return { backend: 'bwrap', available: true };
    }
    if (canExec('/usr/bin/unshare')) {
      return {
        backend: 'unshare',
        available: true,
        reason: '无 bubblewrap, 回落 unshare (fs 限制弱)。装: apt install bubblewrap',
      };
    }
    return {
      backend: 'none',
      available: false,
      reason: 'Linux 缺 bwrap/unshare。装: apt install bubblewrap',
    };
  }
  if (process.platform === 'win32') {
    if (canUseAppContainer()) {
      return { backend: 'appcontainer', available: true };
    }
    if (canUseRestrictedToken()) {
      return {
        backend: 'restricted-token',
        available: true,
        reason: canLoadKoffi()
          ? 'AppContainer 不可用, 回落 Job Object (restricted-token)'
          : 'Win Job Object 包装已启用; 装可选依赖 koffi 可挂 AppContainer / 真 Job Object',
      };
    }
    return {
      backend: 'none',
      available: false,
      reason: 'win32 无可用沙盒 runner (appcontainer/restricted-token)',
    };
  }
  return {
    backend: 'none',
    available: false,
    reason: `${process.platform} 无内核沙盒 (仅 macOS/Linux/Win-appcontainer|restricted-token 支持)`,
  };
}
