/**
 * linux.ts —— Linux 后端。bubblewrap 提供文件系统隔离，不可用时回落到 unshare。
 *
 * bubblewrap 先将根文件系统只读挂载，再为声明的可写 root 建立读写绑定；
 * 只读路径在后面重新覆盖，`net=none` 使用独立网络命名空间。
 */

import type { SandboxInvocation, SandboxPolicy, SandboxRun } from './types.js';
import { normalizeRoots, canonicalizePolicy } from './policy.js';

/** bubblewrap 参数构造 (纯函数, 便于单测)。 */
export function buildBwrapArgs(policy: SandboxPolicy, run: SandboxRun): string[] {
  const shell = run.shell || '/bin/sh';
  const args: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // 读: 整盘只读 bind (读 all)。限定 roots 档暂等同 all-read (bwrap 下细化读成本高, 读无害)。
  args.push('--ro-bind', '/', '/');

  // tmpfs 覆盖敏感挂载点 (可选强化, 暂略)。

  // 写: 每个可写 root 重新 --bind (读写)。
  const writeRoots = normalizeRoots(policy.fs.writeRoots);
  for (const r of writeRoots) {
    args.push('--bind', r, r);
  }

  // 只读洞: 在可写 root 之后 --ro-bind 覆盖回只读 (顺序靠后者生效)。
  const readOnly = normalizeRoots(policy.fs.readOnlyWithin);
  for (const r of readOnly) {
    // 仅当该只读路径存在时 bind, 否则 bwrap 报错。用 --ro-bind-try 容错。
    args.push('--ro-bind-try', r, r);
  }

  // 网络。
  if (policy.net === 'none') {
    args.push('--unshare-net');
  }
  // localhost: 仍 unshare-net 会断本地回环外; 简化为 none 时断、其余共享 host net。
  // (真 localhost-only 需 slirp/网命名空间 + lo, v2 再做。)

  args.push('--', shell, '-lc', run.command);
  return args;
}

export function buildBwrapInvocation(policy: SandboxPolicy, run: SandboxRun): SandboxInvocation {
  return {
    program: '/usr/bin/bwrap',
    args: buildBwrapArgs(canonicalizePolicy(policy), run),
    backend: 'bwrap',
    cleanup() {
      /* bwrap 无临时文件 */
    },
  };
}

/** unshare 回落 (bwrap 不可用时)。只能保证网络隔离, fs 限制弱 —— degraded 上屏。 */
export function buildUnshareInvocation(policy: SandboxPolicy, run: SandboxRun): SandboxInvocation {
  const shell = run.shell || '/bin/sh';
  const args = ['--mount'];
  if (policy.net === 'none') args.push('--net');
  args.push('--', shell, '-lc', run.command);
  return {
    program: '/usr/bin/unshare',
    args,
    backend: 'unshare',
    degraded: 'bwrap 不可用, 回落 unshare: 仅隔离网络, 文件写入未受限 (装 bubblewrap 可启用完整隔离)。',
    cleanup() {
      /* 无临时文件 */
    },
  };
}
