/**
 * Windows AppContainer 阶段二：真 FS 隔离（默认拒写 + writeRoots ACE）。
 *
 * spawn 规格 = node winAppContainerRunner.mjs --profile=... --write-root=... -- <cmd>
 * 需 koffi；不可用时 probe 回落 restricted-token。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxInvocation, SandboxPolicy, SandboxRun } from './types.js';
import { buildPlatformDirectShell } from './directShell.js';
import { canLoadKoffi } from './windows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function resolveWinAppContainerRunnerPath(): string | null {
  const candidates = [
    path.join(__dirname, 'winAppContainerRunner.mjs'),
    path.join(__dirname, 'winAppContainerRunner.js'),
    path.resolve(__dirname, '../src/winAppContainerRunner.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Win + koffi + runner → 可启用 AppContainer。 */
export function canUseAppContainer(): boolean {
  return process.platform === 'win32' && canLoadKoffi() && !!resolveWinAppContainerRunnerPath();
}

/**
 * AppContainer 名：最长 64，仅 [A-Za-z0-9._- ]。
 * 按 workspace 哈希复用 profile（ACE 持久化在 writeRoots 上，可接受）。
 */
export function appContainerProfileName(workspaceRoot: string): string {
  const hash = crypto.createHash('sha1').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 16);
  return `neox.ac.${hash}`;
}

function netFlag(net: SandboxPolicy['net']): string {
  if (net === 'all') return 'all';
  if (net === 'localhost') return 'localhost';
  return 'none';
}

export function buildAppContainerInvocation(
  policy: SandboxPolicy,
  run: SandboxRun,
): SandboxInvocation {
  const runner = resolveWinAppContainerRunnerPath();
  if (!runner) {
    throw new Error('winAppContainerRunner not found');
  }
  if (!canLoadKoffi()) {
    throw new Error('koffi required for appcontainer');
  }

  const inner = buildPlatformDirectShell(run.command, { shell: run.shell });
  const profile = appContainerProfileName(run.cwd);
  const args: string[] = [
    runner,
    `--profile=${profile}`,
    `--cwd=${run.cwd}`,
    `--net=${netFlag(policy.net)}`,
  ];
  for (const root of policy.fs.writeRoots) {
    if (!/^[A-Za-z]:[\\/]/.test(root) && !root.startsWith('\\\\')) continue;
    args.push(`--write-root=${root}`);
  }
  for (const deny of policy.fs.readOnlyWithin) {
    if (!/^[A-Za-z]:[\\/]/.test(deny) && !deny.startsWith('\\\\')) continue;
    args.push(`--deny-write=${deny}`);
  }
  args.push('--', inner.program, ...inner.args);

  const localhostNote =
    policy.net === 'localhost'
      ? 'AppContainer localhost≈PrivateNetwork 能力（细粒度域名代理见 v2 §3.1）'
      : undefined;

  return {
    program: process.execPath,
    args,
    backend: 'appcontainer',
    degraded: localhostNote,
    cleanup() {},
  };
}
