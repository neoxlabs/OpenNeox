/**
 * policy.ts —— tier → SandboxPolicy 映射 + 密钥护栏。
 *
 * 纯函数, 无 IO。给定工作区根 + home + tier, 产出四轴策略。
 * 密钥护栏 (readOnlyWithin) 在所有 tier 恒挂 (除 trusted): 防 agent 偷改 BYOK 密钥/git 历史/沙盒逃逸。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SandboxPolicy, SandboxTier } from './types.js';

/** 需要写入的常见缓存/配置目录 (在 home 下), 让 npm/pip/cargo 等能跑。 */
function packageCacheWriteRoots(home: string): string[] {
  return [
    path.posix.join(home, '.npm'),
    path.posix.join(home, '.cache'),
    path.posix.join(home, '.cargo', 'registry'),
    path.posix.join(home, '.pnpm-store'),
    path.posix.join(home, 'Library', 'Caches'),        // macOS 缓存
  ];
}

/**
 * 密钥护栏 —— 写档下恒为只读的敏感子路径。
 * 即便工作区落在 home 下 (Life 模式 ~/Documents/Neox/...), 这些也偷不到/改不了。
 *
 * - .git: 防改 git 历史 + 防植入 hooks/config (core.fsmonitor 是已知沙盒逃逸手法)。
 * - ~/.ssh ~/.aws ~/.config/gh: 云/git 凭据。
 * - ~/.neox ~/.config/neox: Neox 自己的 config.json (BYOK 密钥密文)。
 * - ~/.config/neox 下 auth.enc / config.json 尤其敏感。
 */
export function secretGuards(workspaceRoot: string, home: string): string[] {
  return [
    // git 历史 + hooks/config (core.fsmonitor 逃逸)
    path.posix.join(workspaceRoot, '.git'),
    // 云 / SSH / GPG 凭据
    path.posix.join(home, '.ssh'),
    path.posix.join(home, '.aws'),
    path.posix.join(home, '.gnupg'),
    path.posix.join(home, '.config', 'gh'),
    path.posix.join(home, '.config', 'gcloud'),
    path.posix.join(home, '.kube'),
    path.posix.join(home, '.docker', 'config.json'),
    // 包管理器 / registry token (常被忽略但含明文 token)
    path.posix.join(home, '.npmrc'),
    path.posix.join(home, '.pypirc'),
    path.posix.join(home, '.netrc'),
    path.posix.join(home, '.git-credentials'),
    path.posix.join(home, '.config', 'pip'),
    // Neox 自己的密钥/配置 (BYOK 密文 + auth.enc)
    /* 字面量: neox-sandbox 不依赖 neox-kernel, 引不到 NEOX_HOME_DIRNAME。
     * 必须与 kernel/platform/neoxHome.ts 一致 (见那里的说明)。
     * 保持 path.posix.join —— 沙箱策略里的路径是 posix 形式, 别换成 path.join。 */
    /* 标准版的 auth.enc 和 config.json 位于 `.neox`，因此该目录始终保持只读。 */
    path.posix.join(home, '.neox'),
    /* .neox-lite 继续留着: 极简版同机共存, 而且 3.5.3~3.6.7 那一周误写进去的数据
     * 在 migrateLiteHomeToStandard 搬完之前还在那儿。留一个字符串的成本是零。 */
    path.posix.join(home, '.neox-lite'),
    path.posix.join(home, '.config', 'neox'),
  ];
}

export interface TierContext {
  workspaceRoot: string;
  home: string;
  tmpDir: string;
  /** 额外可写路径 (用户 --add-dir)。 */
  extraWriteRoots?: string[];
  /** 关掉密钥护栏 (不推荐; 仅用户显式)。 */
  disableSecretGuards?: boolean;
}

/** tier → 完整 SandboxPolicy。这是逻辑档位落到四轴的唯一入口。 */
export function tierToPolicy(tier: SandboxTier, ctx: TierContext): SandboxPolicy {
  const { workspaceRoot, home, tmpDir } = ctx;
  const guards = ctx.disableSecretGuards ? [] : secretGuards(workspaceRoot, home);

  switch (tier) {
    case 'read-only':
      return {
        fs: { read: 'all', writeRoots: [], readOnlyWithin: [] },
        net: 'none',
        proc: { exec: true },
      };

    case 'workspace-write':
      return {
        fs: {
          read: 'all',
          writeRoots: [
            workspaceRoot,
            tmpDir,
            '/private/tmp',
            ...packageCacheWriteRoots(home),
            ...(ctx.extraWriteRoots ?? []),
          ],
          readOnlyWithin: guards,
        },
        net: 'none',
        proc: { exec: true },
      };

    case 'workspace-net':
      return {
        fs: {
          read: 'all',
          writeRoots: [
            workspaceRoot,
            tmpDir,
            '/private/tmp',
            ...packageCacheWriteRoots(home),
            ...(ctx.extraWriteRoots ?? []),
          ],
          readOnlyWithin: guards,
        },
        net: 'all',
        proc: { exec: true },
      };

    case 'trusted':
      // 完全放开 = 不沙盒。backend 会走 'none' 直跑。这里给个全放策略作占位。
      return {
        fs: { read: 'all', writeRoots: ['/'], readOnlyWithin: [] },
        net: 'all',
        proc: { exec: true },
      };
  }
}

/** trusted = 不需要 OS 沙盒 (直跑)。 */
export function tierNeedsSandbox(tier: SandboxTier): boolean {
  return tier !== 'trusted';
}

/**
 * 解析符号链接到真实路径 —— macOS Seatbelt/bwrap 按 canonical 路径匹配。
 * 关键: /var → /private/var、/tmp → /private/tmp 都是软链, 不 realpath 会导致
 * "工作区在 /var/folders/... 却写不进" (subpath 不匹配真实 /private/var/...)。
 * 路径不存在时 (如尚未创建的 .git) 逐级上溯到存在的祖先再拼回。
 */
export function canonicalize(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    /* 不存在, 上溯 */
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(canonicalize(parent), path.basename(p));
}

/** 对 policy 内所有 fs 路径做 canonical 化 (在 IO 边界调, 不污染纯 tierToPolicy)。 */
export function canonicalizePolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    ...policy,
    fs: {
      read:
        policy.fs.read === 'all'
          ? 'all'
          : { roots: policy.fs.read.roots.map(canonicalize) },
      writeRoots: policy.fs.writeRoots.map(canonicalize),
      readOnlyWithin: policy.fs.readOnlyWithin.map(canonicalize),
    },
  };
}

/** 去重并移除已被更宽 root 覆盖的子路径；策略路径统一按 POSIX 形式规范化。 */
export function normalizeRoots(roots: string[]): string[] {
  const cleaned = Array.from(new Set(roots.filter(Boolean).map((r) => path.posix.resolve(r))));
  // 若 A 是 B 的子路径, 去掉 A (B 更宽已覆盖)。
  return cleaned.filter((a) => {
    return !cleaned.some((b) => b !== a && (a === b || a.startsWith(b + path.posix.sep)));
  });
}
