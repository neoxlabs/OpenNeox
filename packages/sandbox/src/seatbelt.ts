/**
 * seatbelt.ts —— macOS Seatbelt 后端。参数化 profile (注入安全)。
 *
 * 与旧 osSandbox 的关键差异:
 *  - 路径全走 `(param "KEY")` + `sandbox-exec -D KEY=path`, 绝不字符串插值 → 无 profile 注入。
 *  - 完整基座白名单 (seatbeltBasePolicy) → 正常命令不误伤。
 *  - 写档挖只读洞 `(require-not (subpath (param "RO_n")))` → .git/密钥即便在工作区下也写不了。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SEATBELT_BASE_POLICY } from './seatbeltBasePolicy.js';
import { normalizeRoots, canonicalizePolicy } from './policy.js';
import type { SandboxInvocation, SandboxPolicy, SandboxRun } from './types.js';

/** 组装完整 SBPL profile + 参数表。纯函数, 便于单测。 */
export function buildSeatbeltProfile(policy: SandboxPolicy): {
  profile: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const lines: string[] = [SEATBELT_BASE_POLICY];

  // ---- 读 ----
  if (policy.fs.read === 'all') {
    lines.push('; 读: 全放 (读无害, 程序需读系统库/证书/工作区)。');
    lines.push('(allow file-read*)');
  } else {
    const rds = normalizeRoots(policy.fs.read.roots);
    if (rds.length > 0) {
      lines.push('; 读: 限定 roots。');
      const subpaths = rds
        .map((_, i) => {
          const key = `RD${i}`;
          params[key] = rds[i];
          return `(subpath (param "${key}"))`;
        })
        .join(' ');
      lines.push(`(allow file-read* ${subpaths})`);
    }
  }

  // ---- 写 (可写 roots 交集去掉只读洞) ----
  const writeRoots = normalizeRoots(policy.fs.writeRoots);
  const readOnly = normalizeRoots(policy.fs.readOnlyWithin);
  if (writeRoots.length > 0) {
    lines.push('; 写: 可写 roots, 但挖掉密钥/git 只读洞。');
    const wrClauses = writeRoots
      .map((_, i) => {
        const key = `WR${i}`;
        params[key] = writeRoots[i];
        return `(subpath (param "${key}"))`;
      })
      .join(' ');
    const roClauses = readOnly
      .map((_, i) => {
        const key = `RO${i}`;
        params[key] = readOnly[i];
        return `(require-not (subpath (param "${key}")))`;
      })
      .join(' ');
    lines.push(
      `(allow file-write*\n  (require-all\n    (require-any ${wrClauses})${roClauses ? `\n    ${roClauses}` : ''}))`,
    );
  }

  // ---- 网络 ----
  switch (policy.net) {
    case 'none':
      lines.push('; 网络: 断 (deny-default 已覆盖, 不加 allow)。');
      break;
    case 'localhost':
      lines.push('; 网络: 仅 localhost。');
      lines.push('(allow network-outbound (remote ip "localhost:*"))');
      lines.push('(allow network-inbound (local ip "localhost:*"))');
      lines.push('(allow network-bind (local ip "localhost:*"))');
      break;
    case 'all':
      lines.push('; 网络: 全放。');
      lines.push('(allow network*)');
      break;
  }

  return { profile: lines.join('\n') + '\n', params };
}

/** 把 params 展开成 sandbox-exec 的 `-D KEY=VALUE` 参数序列。 */
export function paramsToArgs(params: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    out.push('-D', `${k}=${v}`);
  }
  return out;
}

/** 构造一次 Seatbelt 调用。写临时 profile 文件, 返回 spawn 规格 + cleanup。 */
export function buildSeatbeltInvocation(policy: SandboxPolicy, run: SandboxRun): SandboxInvocation {
  const { profile, params } = buildSeatbeltProfile(canonicalizePolicy(policy));
  const profilePath = path.join(
    os.tmpdir(),
    // pid 足够唯一 (Date.now 在本环境受限, 且 pid+随机后缀由调用序保证)。
    `neox-sb-${process.pid}-${profileCounter()}.sb`,
  );
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });

  const shell = run.shell || process.env.SHELL || '/bin/zsh';
  const args = [
    ...paramsToArgs(params),
    '-f',
    profilePath,
    shell,
    '-lc',
    run.command,
  ];

  return {
    program: '/usr/bin/sandbox-exec',
    args,
    backend: 'seatbelt',
    cleanup() {
      try {
        fs.unlinkSync(profilePath);
      } catch {
        /* 已删/不存在, 忽略 */
      }
    },
  };
}

// 单调计数器 —— 避免同一 pid 内并发命令 profile 撞名 (Date.now 在本环境不可用)。
let _c = 0;
function profileCounter(): number {
  _c = (_c + 1) % 1_000_000;
  return _c;
}
