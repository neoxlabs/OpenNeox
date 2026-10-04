import fsSync from 'fs';
import path from 'path';

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ exitCode: number }>;

type VerifyResult = { ok: true } | { ok: false; reason: string };

const RIPGREP_VERIFY_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.NEOX_RIPGREP_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 1000) return Math.floor(fromEnv);
  return process.platform === 'win32' ? 12_000 : 6_000;
})();
function getProcessIoSnapshot() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    stdin: {
      destroyed: process.stdin.destroyed,
      isTTY: !!process.stdin.isTTY,
      paused: typeof process.stdin.isPaused === 'function' ? process.stdin.isPaused() : false,
    },
    stdout: {
      destroyed: process.stdout.destroyed,
      isTTY: !!process.stdout.isTTY,
      writable: process.stdout.writable,
    },
    stderr: {
      destroyed: process.stderr.destroyed,
      isTTY: !!process.stderr.isTTY,
      writable: process.stderr.writable,
    },
  };
}

export function createRipgrepResolver(params: {
  runCommand: RunCommand;
  getWorkspaceRoot: () => string;
  logInfo: (scope: string, message: string, data?: any) => void;
  logWarn: (scope: string, message: string, data?: any) => void;
}) {
  let cachedRipgrepAvailable: boolean | null = null;
  let cachedRipgrepPath: string | null = null;
  let negCacheTimestamp = 0;
  let negCacheMs = 30_000; //  瞬时失败用短负缓存(快速重试), 确定性失败用长(见 isRipgrepAvailable)
  let lastDetectionFailure = '';

  async function verifyRipgrepBinary(commandPath: string, cwd: string): Promise<VerifyResult> {
    try {
      if (commandPath !== 'rg') {
        if (!commandPath) {
          return { ok: false, reason: 'empty path' };
        }
        if (!fsSync.existsSync(commandPath)) {
          return { ok: false, reason: `path not found: ${commandPath}` };
        }
        /* Win 上 X_OK 跟 ACL/"只读"搅在一起, 一个能跑的 rg.exe 也会被判 not executable,
         * 后面 --version 才是真判据。Unix 仍查执行位, 免得把不能跑的文件当候选。 */
        if (process.platform !== 'win32') {
          try {
            fsSync.accessSync(commandPath, fsSync.constants.X_OK);
          } catch (accessErr: any) {
            return { ok: false, reason: `not executable: ${accessErr.message}` };
          }
        }
      }
      params.logInfo('SEARCH', 'Verifying ripgrep binary', { commandPath, cwd, io: getProcessIoSnapshot() });
      let result;
      try {
        result = await params.runCommand(commandPath, ['--version'], cwd, { timeoutMs: RIPGREP_VERIFY_TIMEOUT_MS });
      } catch (err: any) {
        /* 任意瞬时失败一律重试一次 (审计): Windows 桌面首次 rg verify 常因 command helper
         *   冷启动 / 杀软扫 4.5MB exe 超时(瞬时, 非 rg 真缺)。旧逻辑只对 helper startup hint 重试, 其它
         *   异常直接判失败 → search 被锁进慢速 JS 回退。改成任意异常都重试一次(rg 已 warm, 第二次基本必过);
         *   重试再抛才由外层 catch 判 ok:false。 */
        const errorText = String(err?.message || err);
        params.logWarn('SEARCH', `Ripgrep verify retry after transient error: ${errorText}`, { commandPath, cwd });
        result = await params.runCommand(commandPath, ['--version'], cwd, { timeoutMs: RIPGREP_VERIFY_TIMEOUT_MS });
      }
      if (result.exitCode !== 0) {
        const stderr = (result as any).stderr?.substring(0, 200) || '';
        return { ok: false, reason: `--version exited ${result.exitCode}${stderr ? `, stderr=${stderr}` : ''}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: `threw: ${err.message}` };
    }
  }

  function isRipgrepSpawnFailure(exitCode: number, errorMessage?: string): boolean {
    if (exitCode === -1) return true;
    const errorText = (errorMessage || '').toLowerCase();
    return (
      errorText.includes('ebadf') ||
      errorText.includes('enoent') ||
      errorText.includes('eacces') ||
      errorText.includes('spawn') ||
      errorText.includes('not found') ||
      errorText.includes('permission denied')
    );
  }

  async function getRipgrepPath(): Promise<string | null> {
    if (cachedRipgrepPath !== null) return cachedRipgrepPath;

    const workspaceRoot = params.getWorkspaceRoot();
    const failReasons: string[] = [];
    params.logInfo('SEARCH', `Detecting ripgrep... (cwd=${workspaceRoot})`);

    /* Packaged builds first use a sidecar rg beside execPath. Development
     * builds then use @vscode/ripgrep or the system binary. */
    try {
      const execDir = path.dirname(process.execPath);
      const sidecar = path.join(execDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
      if (fsSync.existsSync(sidecar)) {
        /* 把 sidecar 目录 prepend 进 PATH (审计)。
         *     定位: 这条 prepend **到不了** command helper 的子进程 —— runtimeCommandRunner
         *   注入的是启动时 preloadShellEnv() 抓的快照, 运行时改 process.env.PATH 会被丢弃。所以
         *   裸 'rg' 回退在打包版 Windows 上照样 ENOENT。真正的回退已改在 contentRipgrepCollector
         *   的 ripgrepFallbackCandidates 里直接用 sidecar 绝对路径; 这里保留 prepend 只为不走
         *   shellEnv 快照的直接 spawn 场景。 */
        try {
          const curPath = process.env.PATH || '';
          if (!curPath.split(path.delimiter).includes(execDir)) {
            process.env.PATH = execDir + path.delimiter + curPath;
            params.logInfo('SEARCH', `Prepended sidecar dir to PATH: ${execDir}`);
          }
        } catch { /* 非致命 */ }
        const r = await verifyRipgrepBinary(sidecar, workspaceRoot);
        if (r.ok) {
          cachedRipgrepPath = sidecar;
          params.logInfo('SEARCH', `Using sidecar ripgrep: ${sidecar}`);
          return cachedRipgrepPath;
        }
        failReasons.push(`sidecar(${sidecar}): ${r.reason}`);
      }
    } catch (e: any) {
      failReasons.push(`sidecar probe: ${e?.message ?? e}`);
    }

    try {
      const { rgPath } = await import('@vscode/ripgrep');
      params.logInfo('SEARCH', `Bundled ripgrep resolved: ${rgPath}`);

      //  Electron asar-unpacked 修正
      // @vscode/ripgrep 的 rgPath 可能指向 app.asar 内部（不可执行）
      // 需要改为指向 app.asar.unpacked 目录
      let resolvedPath = rgPath;
      if (resolvedPath.includes('app.asar') && !resolvedPath.includes('app.asar.unpacked')) {
        const unpackedPath = resolvedPath.replace('app.asar', 'app.asar.unpacked');
        if (fsSync.existsSync(unpackedPath)) {
          params.logInfo('SEARCH', `Rewrote asar path to unpacked: ${unpackedPath}`);
          resolvedPath = unpackedPath;
        }
      }

      //  Windows: rg 二进制可能是 rg.exe
      if (process.platform === 'win32' && !resolvedPath.endsWith('.exe')) {
        const exePath = resolvedPath + '.exe';
        if (fsSync.existsSync(exePath)) {
          resolvedPath = exePath;
        }
      }

      const bundledResult = await verifyRipgrepBinary(resolvedPath, workspaceRoot);
      if (bundledResult.ok) {
        cachedRipgrepPath = resolvedPath;
        params.logInfo('SEARCH', `Using bundled ripgrep: ${resolvedPath}`);
        return cachedRipgrepPath;
      }
      failReasons.push(`bundled(${resolvedPath}): ${bundledResult.reason}`);
      params.logWarn('SEARCH', `Bundled rg failed: ${bundledResult.reason}`, { rgPath: resolvedPath, workspaceRoot, io: getProcessIoSnapshot() });
    } catch (error: any) {
      failReasons.push(`bundled import: ${error.message}`);
      params.logWarn('SEARCH', `Bundled rg import failed: ${error.message}`, { workspaceRoot, io: getProcessIoSnapshot() });
    }

    params.logInfo('SEARCH', 'Trying system rg...');
    const systemResult = await verifyRipgrepBinary('rg', workspaceRoot);
    if (systemResult.ok) {
      cachedRipgrepPath = 'rg';
      params.logInfo('SEARCH', 'Using system ripgrep');
      return cachedRipgrepPath;
    }
    failReasons.push(`system rg: ${systemResult.reason}`);
    params.logWarn('SEARCH', `System rg failed: ${systemResult.reason}`, { workspaceRoot, io: getProcessIoSnapshot() });

    lastDetectionFailure = failReasons.join('; ');
    cachedRipgrepPath = null;
    return null;
  }

  async function isRipgrepAvailable(): Promise<boolean> {
    if (cachedRipgrepAvailable === true) return true;
    // 负缓存过期后允许重试 (瞬时失败短缓存, 确定性失败长缓存)
    if (cachedRipgrepAvailable === false && (Date.now() - negCacheTimestamp) < negCacheMs) return false;
    const rgPath = await getRipgrepPath();
    cachedRipgrepAvailable = rgPath !== null;
    if (cachedRipgrepAvailable) {
      lastDetectionFailure = '';
      params.logInfo('SEARCH', 'ripgrep available');
    } else {
      params.logWarn('SEARCH', 'ripgrep not available', { failure: lastDetectionFailure, io: getProcessIoSnapshot() });
      negCacheTimestamp = Date.now();
      /* Transient detection failures use a 2s negative cache; a confirmed
       * unavailable binary uses 30s so normal searches retry quickly. */
      const f = (lastDetectionFailure || '').toLowerCase();
      const transient = f.includes('timeout') || f.includes('startup') || f.includes('helper')
        || f.includes('spawn') || f.includes('ebadf') || f.includes('threw') || f.includes('eof');
      negCacheMs = transient ? 2_000 : 30_000;
    }
    return cachedRipgrepAvailable;
  }

  return {
    getRipgrepPath,
    isRipgrepAvailable,
    isRipgrepSpawnFailure,
    getLastDetectionFailure: () => lastDetectionFailure,
    setCachedRipgrepPath: (nextPath: string | null) => {
      cachedRipgrepPath = nextPath;
      if (nextPath !== null) {
        cachedRipgrepAvailable = true;
        lastDetectionFailure = '';
      }
    },
  };
}
