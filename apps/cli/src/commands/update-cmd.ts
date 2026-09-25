/**
 * Update Command
 * Handles CLI self-update functionality
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { CONFIG_DIR } from '@neoxlabs/platform/utils/config.js';
import { decideUpdate, currentPlatformArch, type SignedLatest } from '../security/releaseVerify.js';

const PACKAGE_NAME = '@neoxlabs/cli';
const UPDATE_CHECK_STATE_FILE = path.join(CONFIG_DIR, 'update-check.json');

const DEFAULT_DOWNLOAD_BASE = 'https://dl.neox-dev.com/cli';
function getDownloadBase(): string {
  const raw = (process.env.NEOX_CLI_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE).trim();
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

interface UpdateCheckState {
  autoCheckEnabled?: boolean;
}

interface UpdateCommandContext {
  logInfo?: (message: string, details?: string) => void;
  promptSelect?: (
    question: string,
    choices: Array<{ label: string; value: string; description?: string }>,
    defaultValue?: string
  ) => Promise<string>;
}

function emitUpdateMessage(ctx: UpdateCommandContext | undefined, message: string, details?: string): void {
  if (ctx?.logInfo) {
    ctx.logInfo(message, details);
    return;
  }

  cliPrintln('');
  cliPrintln(colors.highlight(`  ${message}`));
  if (details) {
    cliPrintln(colors.dim(`  ${details}`));
  }
  cliPrintln('');
}

function getErrorText(error: unknown): string {
  return String((error as any)?.message || error || '');
}

function isPermissionError(error: unknown): boolean {
  const text = getErrorText(error).toLowerCase();
  return text.includes('eacces') || text.includes('eperm') || text.includes('permission denied');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractInstallPathFromError(error: unknown): string | undefined {
  const text = getErrorText(error);
  const quotedMatch = text.match(/path:\s*'([^']+)'/i);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();

  const plainMatch = text.match(/npm\s+error\s+path\s+([^\s]+)/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();

  return undefined;
}

function safeExec(command: string, timeout = 3000): string {
  return execSync(command, {
    encoding: 'utf-8',
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function safeExecFile(command: string, args: string[], timeout = 3000): string {
  return execSync([command, ...args.map((item) => shellQuote(item))].join(' '), {
    encoding: 'utf-8',
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function getOwnershipSummary(targetPath: string): string | undefined {
  try {
    const currentUser = safeExec('whoami');
    const owner = safeExecFile('stat', ['-f', '%Su', targetPath]);
    if (!currentUser || !owner) return undefined;
    return `${currentUser}/${owner}`;
  } catch {
    return undefined;
  }
}

function getPermissionFixHint(error: unknown): string {
  const installPath = extractInstallPathFromError(error);

  let targetPath = installPath ? path.dirname(installPath) : '';
  if (!targetPath) {
    try {
      targetPath = safeExec('npm root -g');
    } catch {
      targetPath = '';
    }
  }

  if (targetPath) {
    const ownerSummary = getOwnershipSummary(targetPath);
    const ownershipLine = ownerSummary
      ? `当前用户/目录所有者：${ownerSummary}`
      : '无法自动读取目录所有者信息。';

    return [
      '检测到全局安装目录权限不足。',
      `目录：${targetPath}`,
      ownershipLine,
      `请先执行：sudo chown -R $(whoami) ${shellQuote(targetPath)}`,
      `然后执行：npm install -g ${PACKAGE_NAME}@latest`,
      '或重试 /update。',
    ].join('\n');
  }

  return [
    '检测到全局安装目录权限不足。',
    '请先执行：sudo chown -R $(whoami) $(npm root -g)',
    `然后执行：npm install -g ${PACKAGE_NAME}@latest`,
    '或重试 /update。',
  ].join('\n');
}

function renderUpdateFailureDetails(error: unknown): string {
  const text = getErrorText(error).toLowerCase();
  let message = '更新过程发生错误。';

  if (isPermissionError(error)) {
    message = '权限不足，无法完成安装。';
  } else if (text.includes('timeout') || text.includes('timed out') || text.includes('enotfound')) {
    message = '网络异常，暂时无法完成更新。';
  }

  const hint = isPermissionError(error) ? `\n${getPermissionFixHint(error)}` : '';
  return `${message}${hint}\n可稍后再次执行 /update。`;
}

function readUpdateCheckState(): UpdateCheckState {
  try {
    if (!existsSync(UPDATE_CHECK_STATE_FILE)) return {};
    const raw = readFileSync(UPDATE_CHECK_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      autoCheckEnabled: typeof parsed?.autoCheckEnabled === 'boolean' ? parsed.autoCheckEnabled : undefined,
    };
  } catch {
    return {};
  }
}

function writeUpdateCheckState(state: UpdateCheckState): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(UPDATE_CHECK_STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch {
    // best effort
  }
}

function isAutoCheckEnabled(): boolean {
  const state = readUpdateCheckState();
  return state.autoCheckEnabled !== false;
}

function setAutoCheckEnabled(enabled: boolean): void {
  const state = readUpdateCheckState();
  state.autoCheckEnabled = enabled;
  writeUpdateCheckState(state);
}

function getCurrentVersion(): string {
  return VERSION;
}

function normalizeRegistryUrl(input: string | undefined): string {
  const fallback = 'https://registry.npmjs.org';
  const raw = (input || fallback).trim();
  if (!raw) return fallback;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * 主源: dl.neox-dev.com/cli/latest.json — 自家 R2, 快 + 不依赖 npm 生态.
 *   格式: { version, updatedAt, platforms, digests?, signature?, signatureKeyId? }
 *   (发布脚本 r2-upload-cli.mjs 生成; digests/signature 供自更新防投毒校验)
 */
async function fetchSignedLatest(): Promise<SignedLatest & { platforms?: Record<string, string> }> {
  const url = `${getDownloadBase()}/latest.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`dl.neox-dev.com returned ${response.status}`);
    const data = await response.json() as SignedLatest & { platforms?: Record<string, string> };
    if (!data?.version || typeof data.version !== 'string') {
      throw new Error('invalid version payload from download base');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getLatestVersionFromDownloadBase(): Promise<string> {
  const data = await fetchSignedLatest();

  const platforms = data.platforms;
  if (platforms && typeof platforms === 'object') {
    const mine = `${process.platform}-${process.arch}`;
    if (!platforms[mine]) {
      throw new Error(`latest.json ${data.version} has no artifact for ${mine}`);
    }
  }

  return data.version.trim();
}

async function getLatestVersionFromRegistry(): Promise<string> {
  const registry = normalizeRegistryUrl(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY);
  const encodedPackageName = encodeURIComponent(PACKAGE_NAME);
  const url = `${registry}/${encodedPackageName}/latest`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error('registry request failed');
    }

    const data = await response.json() as { version?: string };
    if (!data?.version || typeof data.version !== 'string') {
      throw new Error('invalid version payload');
    }

    return data.version.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function getLatestVersionFromCli(): Promise<string> {
  const result = execSync(`npm view ${PACKAGE_NAME} version`, {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = result.trim();
  if (!version) {
    throw new Error('empty version');
  }
  return version;
}

/**
 * 三级 fallback: dl.neox-dev.com (主源) → npm registry HTTP → npm view (CLI).
 * 主源 R2 快且不受 npmjs 生态波动影响; registry HTTP 作 R2 不可用 fallback;
 * npm view 作最后兜底 (对付企业代理注入了自定义 registry 的场景).
 */
async function getLatestVersion(): Promise<string> {
  try {
    return await getLatestVersionFromDownloadBase();
  } catch {
    try {
      return await getLatestVersionFromRegistry();
    } catch {
      return await getLatestVersionFromCli();
    }
  }
}

function parseVersionCore(version: string): [number, number, number] {
  const normalized = version.trim().replace(/^v/i, '');
  const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  const nums = normalized.match(/\d+/g) || [];
  const major = Number(nums[0] || 0);
  const minor = Number(nums[1] || 0);
  const patch = Number(nums[2] || 0);
  return [major, minor, patch];
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = parseVersionCore(v1);
  const parts2 = parseVersionCore(v2);

  for (let i = 0; i < 3; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}

async function withDelayedHint<T>(task: () => Promise<T>, delayMs: number, onDelayed: () => void): Promise<T> {
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) onDelayed();
  }, delayMs);

  try {
    return await task();
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

/**
 * 是否为独立二进制版本 (Bun --compile 单文件可执行)。
 * 这种版本运行在 Bun 上, npm install -g 只会装一份 npm 副本, 不会替换正在运行的 binary,
 * 所以不能谎报"更新完成" (言行一致)。npm 安装版运行在 Node 上, process.versions.bun 为空。
 */
function isCompiledBinary(): boolean {
  return !!(process.versions as Record<string, string | undefined>).bun;
}

async function getPlatformBinaryTarball(version: string): Promise<string | null> {
  const platformArch = `${process.platform}-${process.arch}`;

  // 主源: R2
  const dlUrl = `${getDownloadBase()}/${version}/${platformArch}.tar.gz`;
  try {
    // HEAD 探活, 避免下 tarball 才发现 404
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const head = await fetch(dlUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    if (head.ok) return dlUrl;
  } catch { /* 落到 npm fallback */ }

  // Fallback: npm registry
  const platformPkg = `@neoxlabs/cli-${platformArch}`;
  const registry = normalizeRegistryUrl(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY);
  const url = `${registry}/${encodeURIComponent(platformPkg)}/${version}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { dist?: { tarball?: string } };
    return data?.dist?.tarball || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 独立二进制自更新 (POSIX): 从 npm 平台包 tarball 下新 binary, 原子替换正在运行的可执行文件.
 *   · macOS/Linux 上可以替换正在运行进程的 binary 文件 (改的是 inode, 老进程继续跑老 inode),
 *     重启即用新版 — 这是真·自动升级, 不需要用户手动重下.
 *   · Windows 无法替换正在运行的 .exe → 返回 false, 由调用方回落手动提示.
 *   · 任意环节失败 (网络/权限/tarball 异常) 一律返回 false 回落手动提示, 绝不留半截坏 binary.
 * 返回 true = 已成功替换 (提示重启); false = 没成功 (调用方走手动提示).
 */
/**
 * Windows 自更新 — 运行中的 neox.exe 锁住文件, npm 在跑任何脚本【之前】就要拷贝它 → EBUSY,
 *   包内 preinstall/postinstall 救不了 (拷贝已经失败)。唯一可靠: 装之前先 kill 掉所有 neox.exe。
 *   做法: 弹一个【脱离的】cmd 助手 (不是 neox.exe, 不会被自己锁) → 等当前 neox 退出 →
 *   taskkill /IM neox.exe 杀掉 REPL + daemon 释放锁 → npm i -g。当前进程随后退出。
 */
function selfUpdateWindows(ctx: UpdateCommandContext | undefined, latestVersion: string): boolean {
  try {
    const steps = [
      'timeout /t 2 /nobreak >nul',
      'echo Upgrading Neox CLI...',
      'taskkill /F /IM neox.exe >nul 2>nul',
      `npm i -g ${PACKAGE_NAME}@latest`,
      'echo.',
      `echo Done (${latestVersion}). Re-run neox to use the new version.`,
      'pause >nul',
    ].join(' & ');
    const child = spawn('cmd.exe', ['/c', steps], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    emitUpdateMessage(
      ctx,
      '正在后台升级',
      '已弹出升级窗口 — neox 即将退出以释放文件锁 (Windows 运行中的 exe 锁着不能覆盖)。升级完成后重新运行 neox 即可。',
    );
    // 留点时间渲染消息, 然后退出当前进程释放 exe 锁; 助手 taskkill 兜底杀掉 daemon 等残留。
    setTimeout(() => { try { process.exit(0); } catch { /* ignore */ } }, 1200);
    return true;
  } catch {
    return false;
  }
}

async function selfUpdateCompiledBinary(ctx: UpdateCommandContext | undefined, latestVersion: string): Promise<boolean> {
  if (process.platform === 'win32') return selfUpdateWindows(ctx, latestVersion); // 运行中 exe 不可覆盖 → 脱离助手 kill+install

  const targetPath = process.execPath; // 当前运行的独立 binary 绝对路径
  if (!targetPath || !existsSync(targetPath)) return false;

  emitUpdateMessage(ctx, '开始自动更新', `正在下载 ${latestVersion} 版本…`);

  /* 拉签名清单 (digests + ed25519 signature); R2 主源不可用则 signedLatest=null,
   * 走 npm fallback tarball 时无摘要可校验 (decideUpdate 过渡期放行 / 强验签则拒)。 */
  let signedLatest: (SignedLatest & { platforms?: Record<string, string> }) | null = null;
  try {
    const latest = await fetchSignedLatest();
    if (latest.version.trim() === latestVersion.trim()) signedLatest = latest;
  } catch { /* R2 清单拿不到 → 下方无摘要校验 */ }

  const tarballUrl = await getPlatformBinaryTarball(latestVersion);
  if (!tarballUrl) return false;

  let tmpDir = '';
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'neox-selfupdate-'));
    const tgzPath = path.join(tmpDir, 'pkg.tgz');

    // 1) 下载 tarball
    const resp = await fetch(tarballUrl);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) return false; // 明显不对的小包, 别瞎替换

    const verdict = decideUpdate(
      signedLatest ?? { version: latestVersion },
      buf,
    );
    if (!verdict.allow) {
      emitUpdateMessage(ctx, '更新已阻止', `安全校验未通过: ${verdict.reason}。已放弃此次更新, 未改动本地程序。`);
      return true; // 已明确处置 (拒绝投毒包), 不再走"手动更新"回落
    }
    if (process.env.CLI_DEBUG === '1') {
      emitUpdateMessage(ctx, '完整性校验', `${verdict.reason} (${currentPlatformArch()})`);
    }
    writeFileSync(tgzPath, buf);

    // 2) 用系统 tar 解出 package/neox (binary 就在平台包根, files=['neox']; macOS/Linux 自带 tar)
    execSync(`tar -xzf ${shellQuote(tgzPath)} -C ${shellQuote(tmpDir)} package/neox`, {
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const newBin = path.join(tmpDir, 'package', 'neox');
    if (!existsSync(newBin)) return false;
    chmodSync(newBin, 0o755);

    emitUpdateMessage(ctx, '正在安装更新', '替换可执行文件…');

    // 3) 原子替换: 先把现 binary 备份成 .bak (可回滚), 再把新 binary 移到原路径.
    const backup = `${targetPath}.bak`;
    try {
      rmSync(backup, { force: true });
    } catch { /* ignore */ }
    renameSync(targetPath, backup); // 无写权限会 EACCES → 落到 catch 回落手动

    try {
      try {
        renameSync(newBin, targetPath); // 同盘 rename
      } catch {
        copyFileSync(newBin, targetPath); // 跨盘 (tmp 与 binary 不同分区) → 拷贝
        chmodSync(targetPath, 0o755);
      }
    } catch (moveErr) {
      // 移动新 binary 失败 → 回滚旧 binary, 保证可用
      try {
        renameSync(backup, targetPath);
      } catch { /* ignore */ }
      throw moveErr;
    }

    try {
      rmSync(backup, { force: true });
    } catch { /* ignore */ }

    emitUpdateMessage(ctx, '更新完成', `已升级到 ${latestVersion}，请退出并重新运行 neox 即可生效。`);
    return true;
  } catch (error) {
    if (isPermissionError(error)) {
      emitUpdateMessage(
        ctx,
        '更新需要权限',
        `无权写入 ${targetPath}。请用有权限的方式重试 (例如 sudo)，或重新下载覆盖安装。`
      );
      return true; // 已给出明确处置, 不再走默认手动提示
    }
    return false; // 其它失败 → 回落手动提示
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}

async function installLatestVersion(ctx?: UpdateCommandContext): Promise<void> {
  if (!ctx?.logInfo) {
    execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
      stdio: 'inherit',
      encoding: 'utf-8',
      timeout: 120000,
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `install exited with code ${code}`));
      }
    });
  });
}

async function askInstallConfirm(ctx: UpdateCommandContext | undefined, latestVersion: string, source: 'manual' | 'startup'): Promise<boolean> {
  if (!ctx?.promptSelect) {
    emitUpdateMessage(ctx, '需要确认后更新', '启动检查仅提示新版本，不会自动升级。请执行 /update 手动确认。');
    return false;
  }

  const question = `检测到新版本 ${latestVersion}，是否立即升级？`;
  const choices = [
    { label: 'Upgrade now', value: 'yes' },
    { label: 'Later', value: 'no' },
  ];
  const defaultValue = source === 'startup' ? 'no' : 'yes';

  try {
    const selected = await ctx.promptSelect(question, choices, defaultValue);
    return selected === 'yes';
  } catch (error: any) {
    const text = String(error?.message || error || '').toLowerCase();
    if (text.includes('cancel')) {
      return false;
    }

    if (source === 'startup') {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const selected = await ctx.promptSelect(question, choices, defaultValue);
      return selected === 'yes';
    }

    throw error;
  }
}

async function checkAndMaybeUpdate(
  ctx: UpdateCommandContext | undefined,
  source: 'manual' | 'startup',
  promptInstall: boolean
): Promise<boolean> {
  if (source === 'manual') {
    emitUpdateMessage(ctx, '更新检查', '正在获取最新版本信息...');
  }

  const currentVersion = getCurrentVersion();
  const latestVersion = await withDelayedHint(
    () => getLatestVersion(),
    1200,
    () => source === 'manual' && emitUpdateMessage(ctx, '检查仍在进行', '网络较慢，请稍候...')
  );

  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison <= 0) {
    if (source === 'manual') {
      emitUpdateMessage(ctx, '已是最新版本', `当前版本：${currentVersion}`);
    }
    return false;
  }

  emitUpdateMessage(ctx, '发现新版本', `${currentVersion} → ${latestVersion} · 运行 /update 升级`);

  if (source === 'startup') {
    return true;
  }

  const shouldInstall = promptInstall ? await askInstallConfirm(ctx, latestVersion, source) : true;
  if (!shouldInstall) {
    emitUpdateMessage(ctx, '已跳过更新', '可随时通过 /update 再次执行更新。');
    return true;
  }

  // 独立二进制版本: npm 无法替换正在运行的 binary → 走自更新 (下平台 tarball 原子替换可执行文件).
  if (isCompiledBinary()) {
    const ok = await selfUpdateCompiledBinary(ctx, latestVersion);
    if (ok) return true;
    // 自更新没成 (Windows / 网络 / tarball 缺失) → 回落明确的手动提示
    emitUpdateMessage(
      ctx,
      '需手动更新',
      `自动更新未成功。请重新下载 ${latestVersion} 版本的 Neox 可执行文件覆盖安装。`
    );
    return true;
  }

  emitUpdateMessage(ctx, '开始安装更新', '正在后台安装，请稍候...');
  await withDelayedHint(
    () => installLatestVersion(ctx),
    1500,
    () => emitUpdateMessage(ctx, '安装仍在进行', '下载与安装耗时较长，请继续等待')
  );
  emitUpdateMessage(ctx, '更新完成', '请重启 Neox 以使用新版本。');
  return true;
}

export async function handleUpdateCommand(ctx?: UpdateCommandContext): Promise<number> {
  if (!ctx?.promptSelect) {
    try {
      await checkAndMaybeUpdate(ctx, 'manual', false);
      return 0;
    } catch (error) {
      emitUpdateMessage(ctx, '更新失败', renderUpdateFailureDetails(error));
      return 1;
    }
  }

  while (true) {
    const autoEnabled = isAutoCheckEnabled();
    const selected = await ctx.promptSelect(
      '更新设置',
      [
        { label: `自动检查更新 — ${autoEnabled ? '已开' : '已关'}`, value: 'toggle', description: '回车切换' },
        { label: '现在检查', value: 'check-now' },
      ],
      'check-now'
    );

    if (selected === 'back') {
      return 0;
    }

    if (selected === 'toggle') {
      const next = !autoEnabled;
      setAutoCheckEnabled(next);
      emitUpdateMessage(ctx, '自动检查更新已更新', next ? '已开启：每次启动都会检查新版本。' : '已关闭：不会在启动时自动检查。');
      continue;
    }

    if (selected === 'check-now') {
      try {
        await checkAndMaybeUpdate(ctx, 'manual', true);
      } catch (error) {
        emitUpdateMessage(ctx, '更新失败', renderUpdateFailureDetails(error));
      }
    }
  }
}

export async function checkForUpdates(silent = false): Promise<boolean> {
  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();
    const comparison = compareVersions(latestVersion, currentVersion);
    if (comparison > 0 && !silent) {
      cliPrintln('');
      cliPrintln(colors.highlight(`  New version available: ${colors.primary(currentVersion)} → ${colors.primary(latestVersion)}`));
      cliPrintln('');
    }
    return comparison > 0;
  } catch {
    return false;
  }
}

export async function checkForUpdatesOnStartup(ctx?: UpdateCommandContext): Promise<void> {
  if (process.env.NEOX_DISABLE_AUTO_UPDATE_CHECK === '1') {
    return;
  }
  if (!isAutoCheckEnabled()) {
    return;
  }

  try {
    await checkAndMaybeUpdate(ctx, 'startup', true);
  } catch (error: any) {
    if (process.env.CLI_DEBUG === '1') {
      const reason = error?.message || String(error);
      emitUpdateMessage(ctx, '自动检查更新失败', reason);
    }
    // startup path must stay non-blocking
  }
}
