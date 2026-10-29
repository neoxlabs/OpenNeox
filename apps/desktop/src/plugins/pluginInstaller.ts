/**
 * Plugin Installer — 远程安装源实现
 *
 * 支持:
 *   - tarball:  http(s)://...{.tar.gz|.tgz|.tar}
 *   - git:       git+https://..., git@host:repo, 或以 .git 结尾的 https URL
 *   - package:  .neox-plugin (逐文件哈希 + 可选签名)
 *
 * 所有流程最终汇入 pluginManager.installFromPath(tmpDir),
 * 保证 validation / security scan / registry 一致.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { installFromPath, type InstallResult } from './pluginManager.js';
import type { PluginSource } from '@neoxlabs/platform/shared/plugin-types.js';

// ==================== 入口 ====================

export interface RemoteInstallOptions {
  /** 期望的 SHA-256 (hex 串). 提供时校验 tarball. */
  expectedSha256?: string;
  /** 用户配置 */
  userConfig?: Record<string, any>;
  /** 是否安装后立即启用 (默认 true) */
  enable?: boolean;
  /** 跳过安全扫描 (危险, 仅 dev / marketplace trusted) */
  skipScan?: boolean;
}

export async function installFromTarballUrl(
  url: string,
  options?: RemoteInstallOptions,
): Promise<InstallResult> {
  const warnings: string[] = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-plugin-'));
  try {
    const tarPath = path.join(tmpRoot, 'plugin.tar.gz');
    await downloadToFile(url, tarPath);

    // SHA-256 校验 (可选)
    if (options?.expectedSha256) {
      const actual = await sha256File(tarPath);
      if (actual !== options.expectedSha256.toLowerCase()) {
        return {
          success: false,
          errors: [`SHA-256 mismatch: expected ${options.expectedSha256}, got ${actual}`],
          warnings,
        };
      }
    }

    const extractDir = path.join(tmpRoot, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });
    await extractTarball(tarPath, extractDir);

    // tarball 通常有一个顶层目录; 定位真正含 plugin.json 的目录
    const pluginDir = await findPluginRoot(extractDir);
    if (!pluginDir) {
      return { success: false, errors: ['No plugin.json found in tarball'], warnings };
    }

    const source: PluginSource = { type: 'url', url };
    const res = await installFromPath(pluginDir, {
      source,
      enable: options?.enable,
      userConfig: options?.userConfig,
      skipScan: options?.skipScan,
    });
    return { ...res, warnings: [...warnings, ...res.warnings] };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installFromGitUrl(
  repoUrl: string,
  options?: RemoteInstallOptions & { ref?: string },
): Promise<InstallResult> {
  const warnings: string[] = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-plugin-git-'));
  try {
    const cloneDir = path.join(tmpRoot, 'repo');
    await gitClone(repoUrl, cloneDir, options?.ref);

    const pluginDir = await findPluginRoot(cloneDir);
    if (!pluginDir) {
      return { success: false, errors: ['No plugin.json found in repo'], warnings };
    }

    const source: PluginSource = { type: 'url', url: repoUrl };
    const res = await installFromPath(pluginDir, {
      source,
      enable: options?.enable,
      userConfig: options?.userConfig,
      skipScan: options?.skipScan,
    });
    return { ...res, warnings: [...warnings, ...res.warnings] };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/* 按市场目录安装 (查 registry → 再走上面的 tarball / git / package) 在
 * marketplace/marketplaceInstaller.ts —— 那是官方市场的一部分, 不随公开树导出。 */

/**
 * 统一 URL 分发器: 按 URL 形态选走 tarball / git 分支.
 */
export async function installFromRemoteUrl(
  url: string,
  options?: RemoteInstallOptions,
): Promise<InstallResult> {
  if (looksLikeGit(url)) {
    return installFromGitUrl(url, options);
  }
  /* .neox-plugin 是我们自己的分发格式, 带逐文件哈希清单 —— 走 packager 那条
   * 路径才会去校验它。当成普通 tarball 装等于把包里那份清单白写了。 */
  if (/\.neox-plugin(\?|$)/i.test(url)) {
    return installFromPackageUrl(url, options);
  }
  return installFromTarballUrl(url, options);
}

/** 下载 `.neox-plugin` 到临时文件, 交给带完整性校验的导入路径 */
export async function installFromPackageUrl(
  url: string,
  options?: RemoteInstallOptions,
): Promise<InstallResult> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-plugin-pkg-'));
  try {
    const file = path.join(tmpRoot, 'plugin.neox-plugin');
    await downloadToFile(url, file);

    if (options?.expectedSha256) {
      const actual = await sha256File(file);
      if (actual !== options.expectedSha256.toLowerCase()) {
        return {
          success: false,
          errors: [`SHA-256 mismatch: expected ${options.expectedSha256}, got ${actual}`],
          warnings: [],
        };
      }
    }

    const { installFromFile } = await import('./pluginPackager.js');
    const result = await installFromFile(file, {
      enable: options?.enable,
      userConfig: options?.userConfig,
      skipScan: options?.skipScan,
    });
    if (result.success && result.trust) {
      cliLogger.info('PLUGIN', `Installed from package (${result.trust}): ${url}`);
    }
    return result;
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ==================== Helpers ====================

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const arrayBuf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(arrayBuf));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function extractTarball(tarPath: string, destDir: string): Promise<void> {
  // 用系统 tar. macOS 自带 bsdtar, Linux 自带 GNU tar — 两者都支持 -xzf.
  // Windows 自 Win10 1803 起自带 tar.exe.
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed with code ${code}`));
    });
  });
}

async function gitClone(repoUrl: string, destDir: string, ref?: string): Promise<void> {
  // 用 simple-git 已有依赖. 不想引入 simple-git 的话 shell 出 git 也行.
  const { default: simpleGit } = await import('simple-git');
  const git = simpleGit();
  await git.clone(repoUrl, destDir, ref ? ['--branch', ref, '--depth', '1'] : ['--depth', '1']);
}

function looksLikeGit(url: string): boolean {
  if (url.endsWith('.git')) return true;
  if (url.startsWith('git@')) return true;
  if (url.startsWith('git+')) return true;
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i.test(url)) {
    // 仅当不是直链 tarball
    if (!/\.(tar\.gz|tgz|tar|zip)$/i.test(url)) return true;
  }
  return false;
}

async function findPluginRoot(startDir: string): Promise<string | null> {
  // plugin.json 最多向下找 2 层, 避免深度遍历 vendored 依赖
  const maxDepth = 2;

  async function visit(dir: string, depth: number): Promise<string | null> {
    try {
      await fs.access(path.join(dir, 'plugin.json'));
      return dir;
    } catch { /* not here */ }
    if (depth >= maxDepth) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const found = await visit(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return visit(startDir, 0);
}

// 暴露给测试
export const __testing = { looksLikeGit, findPluginRoot };
