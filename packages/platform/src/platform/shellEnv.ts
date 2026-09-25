/**
 * Shell environment loader (shared)
 *
 * Provides async preload and sync fallback with caching.
 * Used by CLI tools and Electron terminal service.
 */

import { execa, execaSync } from 'execa';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isWSL } from './platformDetect.js';

let cachedShellEnv: Record<string, string> | null = null;
let preloadInFlight: Promise<void> | null = null;

export interface ShellEnvPreloadOptions {
  /** Max time to wait for shell env preload before falling back */
  maxWaitMs?: number;
  /** Run preload in background and return immediately */
  background?: boolean;
}

const SELF_LAUNCH_ENV = [
  /^NODE_ENV$/,
  /^NODE_OPTIONS$/,
  /^VITE_/,
  /^npm_/,
  /^ELECTRON_RUN_AS_NODE$/,
];

function stripSelfLaunchEnv(baseEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (SELF_LAUNCH_ENV.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

function mergeShellEnv(
  shellEnv: Record<string, string>,
  rawBaseEnv: Record<string, string>
): Record<string, string> {
  const baseEnv = stripSelfLaunchEnv(rawBaseEnv);
  return {
    ...shellEnv,
    ...baseEnv,
    // Ensure important path variables come from the login shell
    PATH: shellEnv.PATH || baseEnv.PATH || '',
    JAVA_HOME: shellEnv.JAVA_HOME || baseEnv.JAVA_HOME || '',
    MAVEN_HOME: shellEnv.MAVEN_HOME || baseEnv.MAVEN_HOME || '',
    M2_HOME: shellEnv.M2_HOME || baseEnv.M2_HOME || '',
    NODE_PATH: shellEnv.NODE_PATH || baseEnv.NODE_PATH || '',
    GOPATH: shellEnv.GOPATH || baseEnv.GOPATH || '',
    CARGO_HOME: shellEnv.CARGO_HOME || baseEnv.CARGO_HOME || '',
    RUSTUP_HOME: shellEnv.RUSTUP_HOME || baseEnv.RUSTUP_HOME || '',
    PYENV_ROOT: shellEnv.PYENV_ROOT || baseEnv.PYENV_ROOT || '',
    CONDA_PREFIX: shellEnv.CONDA_PREFIX || baseEnv.CONDA_PREFIX || '',
  };
}

const INTERACTIVE_LOGIN_ARGS = ['-lic', 'env'];
const LOGIN_ONLY_ARGS = ['-lc', 'env'];

const DETACH_FROM_TTY = process.platform !== 'win32';

async function runShellEnvCapture(
  shell: string,
  args: string[],
  timeoutMs: number,
): Promise<Record<string, string> | null> {
  try {
    const result = await execa(shell, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      reject: false,
      /* 交互式 shell 绝不能等 stdin; stderr 丢掉 —— rc 在无 tty 下的抱怨不是我们的事 */
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      detached: DETACH_FROM_TTY,
    });
    if (!result.stdout) return null;
    const parsed = parseShellEnv(result.stdout);
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** PATH 取并集 (前者优先, 后者独有的追加在后), 其余变量以交互式那份为准。 */
function mergeCaptures(
  interactive: Record<string, string> | null,
  loginOnly: Record<string, string> | null,
  baseEnv: Record<string, string>,
): Record<string, string> | null {
  const primary = interactive ?? loginOnly;
  if (!primary) return null;
  const other = interactive ? loginOnly : null;
  if (other) {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const p of `${primary.PATH ?? ''}:${other.PATH ?? ''}`.split(':')) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      parts.push(p);
    }
    if (parts.length > 0) primary.PATH = parts.join(':');
  }
  return mergeShellEnv(primary, baseEnv);
}

function parseShellEnv(output: string): Record<string, string> {
  const shellEnv: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      const key = line.substring(0, eqIndex);
      const value = line.substring(eqIndex + 1);
      shellEnv[key] = value;
    }
  }
  return shellEnv;
}


async function loadWindowsShellEnv(timeoutMs: number): Promise<Record<string, string> | null> {
  const candidates = [
    process.env.NEOX_WINDOWS_SHELL,
    'pwsh.exe',
    'powershell.exe',
  ].filter(Boolean) as string[];
  for (const exe of candidates) {
    try {
      const result = await execa(
        exe,
        ['-NoLogo', '-Command', 'Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'],
        { encoding: 'utf8', timeout: timeoutMs, reject: false, stdin: 'ignore', stderr: 'ignore' },
      );
      if (result.stdout && result.stdout.includes('=')) {
        const parsed = parseShellEnv(result.stdout);
        /* PATH 在 Windows 上大小写不敏感, PowerShell 回来的键是 `Path`;
         * 统一补一份 PATH, 否则下游按 env.PATH 取会落空。 */
        if (!parsed.PATH && parsed.Path) parsed.PATH = parsed.Path;
        if (Object.keys(parsed).length > 0) return parsed;
      }
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/**
 * Async preload to avoid blocking first call.
 */
export async function preloadShellEnv(options: ShellEnvPreloadOptions = {}): Promise<void> {
  if (cachedShellEnv) {
    return;
  }

  if (preloadInFlight) {
    await preloadInFlight;
    return;
  }

  const baseEnv = { ...process.env } as Record<string, string>;

  if (process.platform === 'win32') {
    /* 先用自身环境兜底, 保证任何情况下都有值可用; 捞成功再覆盖上去。 */
    cachedShellEnv = baseEnv;
    try {
      const winEnv = await loadWindowsShellEnv(options.maxWaitMs ?? 5000);
      if (winEnv) {
        cachedShellEnv = mergeShellEnv(winEnv, baseEnv);
        cliLogger.info('SHELL', `Windows 用户环境已加载 (PATH 长度 ${cachedShellEnv.PATH?.length ?? 0})`);
      } else {
        cliLogger.warn('SHELL', 'Windows 用户环境捞取失败 — 沿用进程自身环境, profile 里配的 PATH (mvn/nvm 等) 可能看不到');
      }
    } catch (err: any) {
      cliLogger.warn('SHELL', `Windows 用户环境捞取异常: ${err?.message ?? err}`);
    }
    return;
  }

  const wslOptimized = isWSL();
  const maxWaitMs = options.maxWaitMs ?? (wslOptimized ? 800 : 5000);
  const background = options.background ?? wslOptimized;

  const loadShellEnv = async (timeoutMs: number): Promise<Record<string, string> | null> => {
    try {
      const shell = process.env.SHELL || '/bin/zsh';

      cliLogger.debug('SHELL', 'Preloading shell environment asynchronously...');

      const [interactive, loginOnly] = await Promise.all([
        runShellEnvCapture(shell, INTERACTIVE_LOGIN_ARGS, timeoutMs),
        runShellEnvCapture(shell, LOGIN_ONLY_ARGS, Math.min(timeoutMs, 3000)),
      ]);

      const merged = mergeCaptures(interactive, loginOnly, baseEnv);
      if (merged) {
        cliLogger.debug('SHELL', 'Preloaded shell environment successfully', {
          pathLength: merged.PATH?.length,
        });
        return merged;
      }
    } catch (error) {
      cliLogger.warn('SHELL', 'Failed to preload shell environment', { error });
    }

    return null;
  };

  if (background) {
    cachedShellEnv = baseEnv;
    preloadInFlight = (async () => {
      const quickEnv = await loadShellEnv(maxWaitMs);
      if (quickEnv) {
        cachedShellEnv = quickEnv;
        return;
      }

      // Retry with a longer timeout in background
      const retryEnv = await loadShellEnv(5000);
      if (retryEnv) {
        cachedShellEnv = retryEnv;
      }
    })().finally(() => {
      preloadInFlight = null;
    });
    return;
  }

  preloadInFlight = (async () => {
    const env = await loadShellEnv(maxWaitMs);
    cachedShellEnv = env ?? baseEnv;
  })().finally(() => {
    preloadInFlight = null;
  });

  await preloadInFlight;
}

function withLiveNeoxEnv(env: Record<string, string>): Record<string, string> {
  let out: Record<string, string> | null = null;

  if (env.GIT_EDITOR === undefined && !process.env.GIT_EDITOR) {
    if (!out) out = { ...env };
    out.GIT_EDITOR = 'true';
  }

  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('NEOX_') && typeof v === 'string' && env[k] !== v) {
      if (!out) out = { ...env };
      out[k] = v;
    }
  }
  //    落进会话独立目录 (隔离 + 自清理), 而不是系统公共 tmp。
  const sessTmp = process.env.NEOX_SESSION_TMP;
  if (sessTmp && env.TMPDIR !== sessTmp) {
    if (!out) out = { ...env };
    out.TMPDIR = sessTmp;
    out.TMP = sessTmp;
    out.TEMP = sessTmp;
  }

  return out ?? env;
}

/**
 * Sync fallback when cache is missing.
 */
export function getShellEnv(): Record<string, string> {
  if (cachedShellEnv) {
    return withLiveNeoxEnv(cachedShellEnv);
  }

  if (process.env.CLI_DEBUG === '1') {
    cliLogger.warn(
      'SHELL',
      '⚠️ getShellEnv() cache miss - this should not happen! Call preloadShellEnv() during init.'
    );
  }

  const baseEnv = { ...process.env } as Record<string, string>;

  if (process.platform === 'win32') {
    /* sync 路径: 同样试着捞一次 (超时短), 失败就沿用自身环境。
     * 正常情况下 preloadShellEnv 已经在启动时填好缓存, 走不到这里。 */
    try {
      const exe = process.env.NEOX_WINDOWS_SHELL || 'powershell.exe';
      const result = execaSync(
        exe,
        ['-NoLogo', '-Command', 'Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'],
        { encoding: 'utf8', timeout: 1500, reject: false, stdin: 'ignore', stderr: 'ignore' },
      );
      if (result.stdout && result.stdout.includes('=')) {
        const parsed = parseShellEnv(result.stdout);
        if (!parsed.PATH && parsed.Path) parsed.PATH = parsed.Path;
        if (Object.keys(parsed).length > 0) {
          cachedShellEnv = mergeShellEnv(parsed, baseEnv);
          return withLiveNeoxEnv(cachedShellEnv);
        }
      }
    } catch { /* 落回自身环境 */ }
    cachedShellEnv = baseEnv;
    return withLiveNeoxEnv(cachedShellEnv);
  }

  if (preloadInFlight) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const quick = execaSync(shell, LOGIN_ONLY_ARGS, {
        encoding: 'utf8', timeout: 1500, reject: false, stdin: 'ignore', stderr: 'ignore', detached: DETACH_FROM_TTY,
      });
      if (quick.stdout) return withLiveNeoxEnv(mergeShellEnv(parseShellEnv(quick.stdout), baseEnv));
    } catch { /* 落回自身环境 */ }
    return withLiveNeoxEnv(baseEnv);
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execaSync(shell, INTERACTIVE_LOGIN_ARGS, {
      encoding: 'utf8',
      timeout: 4000,
      reject: false,
      stdin: 'ignore',
      stderr: 'ignore',
      detached: DETACH_FROM_TTY,
    });

    if (result.stdout) {
      const shellEnv = parseShellEnv(result.stdout);
      cachedShellEnv = mergeShellEnv(shellEnv, baseEnv);

      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('SHELL', 'Loaded shell environment (sync fallback), PATH length:', {
          pathLength: cachedShellEnv.PATH?.length,
        });
      }
    } else {
      cachedShellEnv = baseEnv;
    }
  } catch (error) {
    cliLogger.warn('SHELL', 'Failed to load shell environment', { error });
    cachedShellEnv = baseEnv;
  }

  return withLiveNeoxEnv(cachedShellEnv);
}

export function clearShellEnvCache(): void {
  cachedShellEnv = null;
}
