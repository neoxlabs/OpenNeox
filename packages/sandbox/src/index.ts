/**
 * neox-sandbox 公共入口 —— 解耦沙盒核心。
 *
 * 唯一对外 API:
 *   - buildSandboxInvocation(policy, run, opts) → spawn 规格 (program/args/backend/cleanup/degraded)
 *   - tierToPolicy(tier, ctx) → SandboxPolicy   (逻辑档位 → 四轴)
 *   - probeBackend() → 当前平台后端能力
 *
 * 零 neox 依赖: 不 import config/runtime/logger。日志走 opts.logger (可选)。
 * 调用方 (shell adapter) 负责: tier 从哪来、spawn、结果格式化、UI。
 */

import { buildSeatbeltInvocation } from './seatbelt.js';
import { buildBwrapInvocation, buildUnshareInvocation } from './linux.js';
import { probeBackend } from './probe.js';
import { tierNeedsSandbox } from './policy.js';
import { buildPlatformDirectShell } from './directShell.js';
import { buildRestrictedTokenInvocation } from './windows.js';
import { buildAppContainerInvocation } from './windowsAppContainer.js';
import type {
  SandboxInvocation,
  SandboxLogger,
  SandboxOptions,
  SandboxPolicy,
  SandboxRun,
} from './types.js';

export * from './types.js';
export { tierToPolicy, secretGuards, tierNeedsSandbox, normalizeRoots } from './policy.js';
export type { TierContext } from './policy.js';
export { probeBackend, resetProbeCache } from './probe.js';
export type { BackendProbe } from './probe.js';
export { buildSeatbeltProfile } from './seatbelt.js';
export { buildBwrapArgs } from './linux.js';
export { buildPlatformDirectShell } from './directShell.js';
export type { DirectShellInvocation } from './directShell.js';
export {
  buildRestrictedTokenInvocation,
  canUseRestrictedToken,
  canLoadKoffi,
  resetRestrictedTokenProbe,
} from './windows.js';
export {
  buildAppContainerInvocation,
  canUseAppContainer,
  appContainerProfileName,
} from './windowsAppContainer.js';

/** 未沙盒直跑 (降级 / trusted) — 与 neox-core shellInvocation 共用 buildPlatformDirectShell。 */
function directInvocation(run: SandboxRun, degraded?: string): SandboxInvocation {
  const inv = buildPlatformDirectShell(run.command, { shell: run.shell });
  return {
    program: inv.program,
    args: inv.args,
    backend: 'none',
    degraded,
    cleanup() {},
  };
}

function tryRestrictedToken(
  policy: SandboxPolicy,
  run: SandboxRun,
  log: SandboxLogger,
  prefix?: string,
): SandboxInvocation {
  try {
    const inv = buildRestrictedTokenInvocation(policy, run);
    if (inv.degraded) log('warn', `restricted-token 降级说明: ${inv.degraded}`);
    if (prefix) {
      return {
        ...inv,
        degraded: [prefix, inv.degraded].filter(Boolean).join('；'),
      };
    }
    log('debug', `restricted-token: ${inv.args.length} args`);
    return inv;
  } catch (err: any) {
    log('warn', `restricted-token 构建失败, 降级直跑: ${err?.message ?? err}`);
    return directInvocation(
      run,
      [prefix, `restricted-token 失败: ${err?.message ?? err}`].filter(Boolean).join('；'),
    );
  }
}

/**
 * 核心: 把 policy + 命令 编译成可直接 spawn 的规格。
 * 自动挑后端 (可 opts.forceBackend 覆盖)。后端不可用 → 降级直跑 + degraded 原因。
 */
export function buildSandboxInvocation(
  policy: SandboxPolicy,
  run: SandboxRun,
  opts: SandboxOptions = {},
): SandboxInvocation {
  const log = opts.logger ?? (() => {});
  const probe = opts.forceBackend
    ? { backend: opts.forceBackend, available: opts.forceBackend !== 'none' }
    : probeBackend();

  if (!probe.available || probe.backend === 'none') {
    const reason = 'reason' in probe ? probe.reason : undefined;
    log('warn', `沙盒不可用, 降级直跑: ${reason ?? ''}`);
    return directInvocation(run, reason ?? '当前平台无内核沙盒');
  }

  switch (probe.backend) {
    case 'seatbelt': {
      const inv = buildSeatbeltInvocation(policy, run);
      log('debug', `seatbelt: ${inv.args.length} args`);
      return inv;
    }
    case 'bwrap':
      return buildBwrapInvocation(policy, run);
    case 'unshare':
      return buildUnshareInvocation(policy, run);
    case 'appcontainer': {
      try {
        const inv = buildAppContainerInvocation(policy, run);
        if (inv.degraded) log('warn', `appcontainer 说明: ${inv.degraded}`);
        log('debug', `appcontainer: ${inv.args.length} args`);
        return inv;
      } catch (err: any) {
        log('warn', `appcontainer 构建失败, 回落 restricted-token: ${err?.message ?? err}`);
        return tryRestrictedToken(
          policy,
          run,
          log,
          `appcontainer 失败: ${err?.message ?? err}`,
        );
      }
    }
    case 'restricted-token':
      return tryRestrictedToken(policy, run, log);
    default:
      return directInvocation(run);
  }
}

/** trusted 档快捷判断: 是否根本不需要沙盒。 */
export { tierNeedsSandbox as needsSandbox };
