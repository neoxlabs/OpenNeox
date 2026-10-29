/**
 * Update Command
 * Handles CLI self-update functionality
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, renameSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';
import { VERSION } from '@neoxlabs/kernel/version.js';
import { CONFIG_DIR } from '@neoxlabs/platform/utils/config.js';
import { decideUpdate, currentPlatformArch, type SignedLatest } from '../security/releaseVerify.js';
import { L } from '../i18n/index.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

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
      ? `${L('当前用户/目录所有者', 'Current user / directory owner')}：${ownerSummary}`
      : L('无法自动读取目录所有者信息。', 'Could not read the directory owner.');

    return [
      L('检测到全局安装目录权限不足。', 'No write permission on the global install directory.'),
      `${L('目录', 'Directory')}：${targetPath}`,
      ownershipLine,
      `${L('请先执行', 'Run first')}：sudo chown -R $(whoami) ${shellQuote(targetPath)}`,
      `${L('然后执行', 'Then')}：npm install -g ${PACKAGE_NAME}@latest`,
      L('或重试 /update。', 'Or retry /update.'),
    ].join('\n');
  }

  return [
    L('检测到全局安装目录权限不足。', 'No write permission on the global install directory.'),
    `${L('请先执行', 'Run first')}：sudo chown -R $(whoami) $(npm root -g)`,
    `${L('然后执行', 'Then')}：npm install -g ${PACKAGE_NAME}@latest`,
    L('或重试 /update。', 'Or retry /update.'),
  ].join('\n');
}

function renderUpdateFailureDetails(error: unknown): string {
  const text = getErrorText(error).toLowerCase();
  let message = L('更新过程发生错误。', 'The update failed.');

  if (isPermissionError(error)) {
    message = L('权限不足，无法完成安装。', 'Not enough permission to install.');
  } else if (text.includes('timeout') || text.includes('timed out') || text.includes('enotfound')) {
    message = L('网络异常，暂时无法完成更新。', 'Network problem — the update can’t finish right now.');
  }

  const hint = isPermissionError(error) ? `\n${getPermissionFixHint(error)}` : '';
  return `${message}${hint}\n${L('可稍后再次执行 /update。', 'Try /update again later.')}`;
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
  /* 没有官方下载源的发行版 (开源版) 只看 npm, 不去问 dl.neox-dev.com */
  if (!DISTRIBUTION.autoUpdate) {
    try { return await getLatestVersionFromRegistry(); } catch { return await getLatestVersionFromCli(); }
  }
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
  /* 官方下载源上是商业版的单文件程序, 开源版不能拿它替换自己 */
  if (!DISTRIBUTION.autoUpdate) return null;
  const platformArch = `${process.platform}-${process.arch}`;
  const dlUrl = `${getDownloadBase()}/${version}/${platformArch}.tar.gz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // HEAD 探活, 避免下 tarball 才发现 404
    const head = await fetch(dlUrl, { method: 'HEAD', signal: controller.signal });
    return head.ok ? dlUrl : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function selfUpdateCompiledBinary(ctx: UpdateCommandContext | undefined, latestVersion: string): Promise<boolean> {
  const targetPath = process.execPath; // 当前运行的独立 binary 绝对路径
  if (!targetPath || !existsSync(targetPath)) return false;

  emitUpdateMessage(ctx, L('开始自动更新', 'Updating'), L(`正在下载 ${latestVersion} 版本…`, `Downloading ${latestVersion}…`));

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
      emitUpdateMessage(ctx, L('更新已阻止', 'Update blocked'), L(`安全校验未通过: ${verdict.reason}。已放弃此次更新, 未改动本地程序。`, `Integrity check failed: ${verdict.reason}. Update abandoned; nothing was changed.`));
      return true; // 已明确处置 (拒绝投毒包), 不再走"手动更新"回落
    }
    if (process.env.CLI_DEBUG === '1') {
      emitUpdateMessage(ctx, L('完整性校验', 'Integrity check'), `${verdict.reason} (${currentPlatformArch()})`);
    }
    writeFileSync(tgzPath, buf);

    // 2) 用系统 tar 解出 package/neox(.exe) (macOS/Linux 自带 tar, Windows 10 起自带 tar.exe)
    const exeName = process.platform === 'win32' ? 'neox.exe' : 'neox';
    execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir, `package/${exeName}`], {
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const newBin = path.join(tmpDir, 'package', exeName);
    if (!existsSync(newBin)) return false;
    chmodSync(newBin, 0o755);

    emitUpdateMessage(ctx, L('正在安装更新', 'Installing'), L('替换可执行文件…', 'Replacing the executable…'));

    // 3) 先把现 binary 改名挪开 (可回滚), 再把新 binary 移到原路径.
    //    挪开的名字带时间戳: Windows 上上一次挪开的那份可能还在被别的 neox 进程跑着, 删不掉也不能重名覆盖。
    const dir = path.dirname(targetPath);
    const stem = path.basename(targetPath);
    for (const f of readdirSync(dir)) {
      if (f === `${stem}.bak` || f.startsWith(`${stem}.old-`)) {
        try { rmSync(path.join(dir, f), { force: true }); } catch { /* 还在跑, 下次再删 */ }
      }
    }
    const backup = path.join(dir, `${stem}.old-${Date.now()}`);
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
    } catch { /* Windows: 当前进程还在用, 下次更新时清 */ }
    /* npm 下载器 (apps/cli/npm-launcher) 看这个文件决定要不要重下; 不更新它, 下次 npm 升级会按旧版本号判断 */
    try {
      if (existsSync(path.join(dir, 'neox.version'))) writeFileSync(path.join(dir, 'neox.version'), `${latestVersion}\n`);
    } catch { /* ignore */ }

    emitUpdateMessage(ctx, L('更新完成', 'Updated'), L(`已升级到 ${latestVersion}，请退出并重新运行 neox 即可生效。`, `Updated to ${latestVersion} — quit and run neox again to use it.`));
    return true;
  } catch (error) {
    if (isPermissionError(error)) {
      emitUpdateMessage(
        ctx,
        L('更新需要权限', 'Update needs permission'),
        L(`无权写入 ${targetPath}。请用有权限的方式重试 (例如 sudo)，或重新下载覆盖安装。`, `Can’t write ${targetPath}. Retry with permission (e.g. sudo) or reinstall from a fresh download.`)
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
    emitUpdateMessage(ctx, L('需要确认后更新', 'Confirm to update'), L('启动检查仅提示新版本，不会自动升级。请执行 /update 手动确认。', 'The startup check only tells you about new versions. Run /update to install.'));
    return false;
  }

  const question = L(`检测到新版本 ${latestVersion}，是否立即升级？`, `Version ${latestVersion} is out — update now?`);
  const choices = [
    { label: L('现在升级', 'Upgrade now'), value: 'yes' },
    { label: L('以后再说', 'Later'), value: 'no' },
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
    emitUpdateMessage(ctx, L('更新检查', 'Checking for updates'), L('正在获取最新版本信息...', 'Fetching the latest version…'));
  }

  const currentVersion = getCurrentVersion();
  const latestVersion = await withDelayedHint(
    () => getLatestVersion(),
    1200,
    () => source === 'manual' && emitUpdateMessage(ctx, L('检查仍在进行', 'Still checking'), L('网络较慢，请稍候...', 'Slow network, hang on…'))
  );

  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison <= 0) {
    if (source === 'manual') {
      emitUpdateMessage(ctx, L('已是最新版本', 'Up to date'), `${L('当前版本', 'Version')}：${currentVersion}`);
    }
    return false;
  }

  emitUpdateMessage(ctx, L('发现新版本', 'Update available'), L(`${currentVersion} → ${latestVersion} · 运行 /update 升级`, `${currentVersion} → ${latestVersion} · run /update`));

  if (source === 'startup') {
    return true;
  }

  const shouldInstall = promptInstall ? await askInstallConfirm(ctx, latestVersion, source) : true;
  if (!shouldInstall) {
    emitUpdateMessage(ctx, L('已跳过更新', 'Update skipped'), L('可随时通过 /update 再次执行更新。', 'Run /update any time.'));
    return true;
  }

  // 独立二进制版本: npm 无法替换正在运行的 binary → 走自更新 (下平台 tarball 原子替换可执行文件).
  if (isCompiledBinary()) {
    const ok = await selfUpdateCompiledBinary(ctx, latestVersion);
    if (ok) return true;
    // 自更新没成 (Windows / 网络 / tarball 缺失) → 回落明确的手动提示
    emitUpdateMessage(
      ctx,
      L('需手动更新', 'Manual update needed'),
      L(`自动更新未成功。请重新下载 ${latestVersion} 版本的 Neox 可执行文件覆盖安装。`, `The automatic update didn’t work. Download Neox ${latestVersion} and install it over this one.`)
    );
    return true;
  }

  emitUpdateMessage(ctx, L('开始安装更新', 'Installing update'), L('正在后台安装，请稍候...', 'Installing in the background…'));
  await withDelayedHint(
    () => installLatestVersion(ctx),
    1500,
    () => emitUpdateMessage(ctx, L('安装仍在进行', 'Still installing'), L('下载与安装耗时较长，请继续等待', 'This is taking a while, hang on'))
  );
  emitUpdateMessage(ctx, L('更新完成', 'Updated'), L('请重启 Neox 以使用新版本。', 'Restart Neox to use the new version.'));
  return true;
}

export async function handleUpdateCommand(ctx?: UpdateCommandContext): Promise<number> {
  if (!DISTRIBUTION.autoUpdate) {
    emitUpdateMessage(ctx, L('这个版本不自动更新', 'This build does not self-update'), L(
      '从源码构建的话 git pull 后重新构建; 安装包到项目的 GitHub Releases 下载新版。',
      'If you built from source, git pull and rebuild; for installers, download the new version from the project\'s GitHub Releases.',
    ));
    return 0;
  }
  if (!ctx?.promptSelect) {
    try {
      await checkAndMaybeUpdate(ctx, 'manual', false);
      return 0;
    } catch (error) {
      emitUpdateMessage(ctx, L('更新失败', 'Update failed'), renderUpdateFailureDetails(error));
      return 1;
    }
  }

  while (true) {
    const autoEnabled = isAutoCheckEnabled();
    const selected = await ctx.promptSelect(
      L('更新设置', 'Updates'),
      [
        { label: `${L('自动检查更新', 'Check on startup')} — ${autoEnabled ? L('已开', 'on') : L('已关', 'off')}`, value: 'toggle', description: L('回车切换', 'enter to toggle') },
        { label: L('现在检查', 'Check now'), value: 'check-now' },
      ],
      'check-now'
    );

    if (selected === 'back') {
      return 0;
    }

    if (selected === 'toggle') {
      const next = !autoEnabled;
      setAutoCheckEnabled(next);
      emitUpdateMessage(ctx, L('自动检查更新已更新', 'Startup check updated'), next
        ? L('已开启：每次启动都会检查新版本。', 'On: checks for a new version at every start.')
        : L('已关闭：不会在启动时自动检查。', 'Off: no check at startup.'));
      continue;
    }

    if (selected === 'check-now') {
      try {
        await checkAndMaybeUpdate(ctx, 'manual', true);
      } catch (error) {
        emitUpdateMessage(ctx, L('更新失败', 'Update failed'), renderUpdateFailureDetails(error));
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
  if (!DISTRIBUTION.autoUpdate) return;
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
      emitUpdateMessage(ctx, L('自动检查更新失败', 'Startup update check failed'), reason);
    }
    // startup path must stay non-blocking
  }
}
