/**
 * Windows restricted-token 阶段一：Job Object 包装器。
 *
 * spawn 规格 = node winJobRunner.mjs -- <cmd.exe /d /s /c ...>
 * runner 在有 koffi 时挂 Job Object；无 koffi 仍包装进程（可杀树），degraded 上屏说明。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SandboxInvocation, SandboxPolicy, SandboxRun } from './types.js';
import { buildPlatformDirectShell } from './directShell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function resolveWinJobRunnerPath(): string | null {
  const candidates = [
    path.join(__dirname, 'winJobRunner.mjs'),
    path.join(__dirname, 'winJobRunner.js'),
    path.resolve(__dirname, '../src/winJobRunner.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let _koffiOk: boolean | undefined;

export function canLoadKoffi(): boolean {
  if (_koffiOk !== undefined) return _koffiOk;
  try {
    require.resolve('koffi');
    _koffiOk = true;
  } catch {
    _koffiOk = false;
  }
  return _koffiOk;
}

/** Win 上 runner 存在即可启用后端（koffi 决定是否真 Job Object）。 */
export function canUseRestrictedToken(): boolean {
  return process.platform === 'win32' && !!resolveWinJobRunnerPath();
}

export function resetRestrictedTokenProbe(): void {
  _koffiOk = undefined;
}

export function buildRestrictedTokenInvocation(
  policy: SandboxPolicy,
  run: SandboxRun,
): SandboxInvocation {
  const runner = resolveWinJobRunnerPath();
  if (!runner) {
    throw new Error('winJobRunner not found');
  }
  const inner = buildPlatformDirectShell(run.command, { shell: run.shell });
  const maxProcs = policy.proc.exec ? 64 : 1;
  const hasKoffi = canLoadKoffi();
  return {
    program: process.execPath,
    args: [
      runner,
      `--cwd=${run.cwd}`,
      `--max-processes=${maxProcs}`,
      '--',
      inner.program,
      ...inner.args,
    ],
    backend: 'restricted-token',
    degraded: hasKoffi
      ? undefined
      : 'Job Object 需可选依赖 koffi；当前仅进程包装 (杀树), 非完整 Restricted Token',
    cleanup() {},
  };
}
