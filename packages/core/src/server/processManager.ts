/**
 * Server Process Manager
 *
 * 两种模式：
 * - 临时模式：CLI fork 子进程，CLI 退出时 server 跟着退出
 * - Daemon 模式：独立后台进程，CLI 退出不影响 server
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readPidFile, getServerBuildHash, removePidFile } from './pidFile.js';
import { getDefaultServerPort } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { computeIdentityEpoch } from '@neoxlabs/platform/platform/identityCredential.js';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const isWin = process.platform === 'win32';

/** 父进程 globalThis 里的设备指纹 (openai.ts setNeoxDeviceFp 写的)。读不到返空串, 由 daemon 自算兜底。 */
function getNeoxDeviceFpSafe(): string {
  try {
    return String((globalThis as any).__NEOX_DEVICE_FP__ ?? '').trim();
  } catch {
    return '';
  }
}

function withLocalhostNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = `${env.NO_PROXY || ''},${env.no_proxy || ''}`;
  const hasLocal = /(^|[,\s])(127\.0\.0\.1|localhost|::1|\*)([,\s]|$)/i.test(existing);
  if (hasLocal) return env;
  const merged = [env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

/**
 * 跨平台进程终止
 * Windows 不支持 SIGTERM/SIGKILL，使用 taskkill 代替
 */
function killProcess(pid: number, force = false): void {
  if (isWin) {
    try {
      execSync(`taskkill /PID ${pid} ${force ? '/F' : ''} /T`, { stdio: 'ignore' });
    } catch (err: any) { cliLogger.debug('PROCESS', `taskkill pid=${pid} failed (may be dead): ${err?.message}`); }
  } else {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (err: any) { cliLogger.debug('PROCESS', `kill pid=${pid} failed (may be dead): ${err?.message}`); }
  }
}

const DEFAULT_PORT = getDefaultServerPort();
const HEALTH_TIMEOUT = 3000;
const STARTUP_TIMEOUT = isWin ? 45000 : 20000;
const NEOX_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME);
const LOG_FILE = path.join(NEOX_DIR, 'server.log');
const DAEMON_LOG_MAX_BYTES = 20 * 1024 * 1024;
const DAEMON_LOG_MAX_BACKUPS = 3;

// ============================================================================
// 端口检测
// ============================================================================

async function isPortAvailableOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  // server 可能绑定任意地址，必须确保端口在所有接口上都可用
  const [localAvailable, allAvailable] = await Promise.all([
    isPortAvailableOnHost(port, '127.0.0.1'),
    isPortAvailableOnHost(port, '0.0.0.0'),
  ]);
  return localAvailable && allAvailable;
}

async function findFreePort(startPort: number = DEFAULT_PORT): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No free port found');
}

// ============================================================================
// 健康检查
// ============================================================================

async function checkHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch (err: any) {
    cliLogger.debug('PROCESS', `Health check port=${port} failed: ${err?.message}`);
    return false;
  }
}

// ============================================================================
// 公开 API
// ============================================================================

export interface ServerConnection {
  port: number;
  baseUrl: string;
  /** 如果是本次启动的，返回子进程引用 */
  process?: ChildProcess;
  /** 是否是复用已有 server */
  reused: boolean;
  /**
   * Server 当前 Bearer token. 由 server 主进程生成并写进 pid file,
   * client 通过 pid file 回灌, 之后所有 HTTP/SSE 调用都要带这个 header.
   * 极端情况(pid file 还没写出来 / 解析失败) 会是空字符串, client 自己降级处理.
   */
  authToken: string;
  /** 方案 C: 该连接所属身份纪元 (= userId/'anon'), pid 文件按 workdir+身份 编号, shutdown 时据此找对文件。 */
  identityEpoch?: string;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  workDir?: string;
  uptime?: number;
  logFile: string;
}

// ============================================================================
// ensureServer — 优先复用 daemon，否则 fork 临时 server
// ============================================================================

export async function ensureServer(workDir: string, opts: { identityDir?: string } = {}): Promise<ServerConnection> {
  const identityDir = opts.identityDir || NEOX_DIR;
  const currentEpoch = computeIdentityEpoch(identityDir);
  // 1. 尝试复用已有 server — 按 workDir + 身份 查 PID 文件（支持多实例 + 身份隔离）
  const existing = readPidFile(workDir, currentEpoch);
  if (existing) {
    cliLogger.debug('BOOT', `ensureServer: found pid file, checking health on port ${existing.port}...`);
    const alive = await checkHealth(existing.port);
    if (alive) {
      const currentBuildHash = getServerBuildHash();
      const buildChanged = !!(currentBuildHash && existing.buildHash && currentBuildHash !== existing.buildHash);
      /* 身份纪元校验: 现在 pid 文件已按身份隔离, existing 必是同身份; 仍保留兜底 (老 daemon 无 epoch)。 */
      const identityChanged = existing.identityEpoch !== undefined && existing.identityEpoch !== currentEpoch;
      if (buildChanged || identityChanged) {
        cliLogger.info('PROCESS_MGR', `Server restart: ${buildChanged ? `binary changed (old=${existing.buildHash?.substring(0, 16)}, new=${currentBuildHash.substring(0, 16)})` : `identity changed (old=${existing.identityEpoch}, new=${currentEpoch})`}`);
        killProcess(existing.pid);
        // 等待旧进程退出
        const killStart = Date.now();
        while (Date.now() - killStart < 5000) {
          await new Promise(r => setTimeout(r, 300));
          try { process.kill(existing.pid, 0); } catch (err) { cliLogger.debug('PROCESS_MGR', `Non-critical: ${(err as any)?.message}`); break; }
        }
        cliLogger.info('PROCESS_MGR', 'Old server killed, starting new one');
      } else {
        cliLogger.info('PROCESS_MGR', `Reusing existing server on port ${existing.port}${(existing as any).daemon ? ' (daemon)' : ''}`);
        return {
          port: existing.port,
          baseUrl: `http://127.0.0.1:${existing.port}`,
          reused: true,
          authToken: existing.token ?? '',
          identityEpoch: currentEpoch,
        };
      }
    }
    removePidFile(workDir, currentEpoch);
    cliLogger.debug('BOOT', 'ensureServer: stale pid file, starting new server');
  }

  // 2. 启动临时 server（跟随 CLI 生命周期）
  // 端口探测和实际 listen 之间存在竞态，失败时自动换端口重试。
  let startPort = DEFAULT_PORT;
  const maxStartAttempts = 5;

  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    const port = await findFreePort(startPort);
    cliLogger.debug('BOOT', `ensureServer: starting server on port ${port}... (attempt ${attempt}/${maxStartAttempts})`);

    try {
      const serverProcess = await startServer(workDir, port, identityDir);
      // server 启动时把 token 写进了 pid file, 这里读回来 (同身份键)
      const fresh = readPidFile(workDir, currentEpoch);
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        process: serverProcess,
        reused: false,
        authToken: fresh?.token ?? '',
        identityEpoch: currentEpoch,
      };
    } catch (error: any) {
      const stillFree = await isPortAvailable(port);
      if (!stillFree && attempt < maxStartAttempts) {
        cliLogger.warn('PROCESS_MGR', `Port ${port} became unavailable during startup, retrying...`);
        startPort = port + 1;
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to start server after multiple port retries');
}

// ============================================================================
// Server 启动 — 默认 detached 模式，CLI 退出不影响 Server
// ============================================================================

function resolveServerSpawn(port: number, workDir: string, identityDir: string = NEOX_DIR): { args: string[]; serverModeEnv: Record<string, string>; describe: string } {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(thisDir, '..');
  const bundledEntry = path.resolve(distDir, '..', 'server', 'main.js');
  const adjacentEntry = path.join(distDir, 'server', 'main.js');
  /* --identity-dir 让 server 按本端身份现取网关凭据 (阶段2)。node 与编译版 (NEOX_WORKER=server) 都吃 serverArgs。 */
  const serverArgs = ['--port', String(port), '--workdir', workDir, '--daemon', '--identity-dir', identityDir];
  const onDisk = fs.existsSync(bundledEntry) ? bundledEntry : (fs.existsSync(adjacentEntry) ? adjacentEntry : null);
  if (onDisk) {
    return { args: [onDisk, ...serverArgs], serverModeEnv: {}, describe: `node ${onDisk}` };
  }
  return { args: serverArgs, serverModeEnv: { NEOX_WORKER: 'server' }, describe: `<self-binary> NEOX_WORKER=server` };
}

/** 读 daemon 日志末尾若干行 — server 启动失败时附在错误里, 让用户/我能看到真因 (原生模块崩等). */
function readDaemonLogTail(maxBytes = 1600): string {
  try {
    if (!fs.existsSync(LOG_FILE)) return '  (无 server.log)';
    const stat = fs.statSync(LOG_FILE);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf-8').trim().split('\n').slice(-12).join('\n');
      return text ? text.split('\n').map((l) => `  │ ${l}`).join('\n') : '  (日志为空)';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '  (读 server.log 失败)';
  }
}

async function startServer(workDir: string, port: number, identityDir: string = NEOX_DIR): Promise<ChildProcess> {
  const spawnSpec = resolveServerSpawn(port, workDir, identityDir);

  cliLogger.debug('BOOT', `startServer: ${spawnSpec.describe}`);
  cliLogger.info('PROCESS_MGR', `Starting server (spawn+health): ${spawnSpec.describe} --port ${port} --workdir ${workDir}`);

  ensureNeoxDir();
  rotateDaemonLogIfNeeded();
  // 在 Electron 主进程里, Chromium 的 IO thread / sandbox fd 清理逻辑会关闭
  // 它不认识的文件描述符, 时机不定, 导致 libuv posix_spawn 时 EBADF.
  // 开两个独立 fd (v1 修复) 仍无法避免, 因为 Chromium 会清掉任意 unknown fd.
  // 解法: 父进程完全用 stdio:'ignore', 通过 NEOX_LOG_FILE 环境变量把路径传给
  // 子进程, 子进程自己在启动时 open+redirect stdout/stderr.
  const EPHEMERAL_ENV_KEYS = ['NEOX_FORCE_APPROVAL_MODE'];
  const inheritedEnv = { ...process.env };
  for (const k of EPHEMERAL_ENV_KEYS) delete inheritedEnv[k];

  const childEnv = withLocalhostNoProxy({
    ...inheritedEnv,
    NEOX_DAEMON: '1',
    NEOX_WORKDIR: workDir,
    NEOX_LOG_FILE: LOG_FILE,
    /* 设备指纹随 spawn 下传 — daemon 里的 provider 要拿它签 X-Device-FP。父进程已经算过就直接给,
     * 免得子进程再算一遍 (算法同源, 值相同, 但父子同值这件事不该依赖"两处实现一直没走样")。
     * 父进程没设时留空, daemon 自己用 platform/deviceFingerprint 兜底算。 */
    ...(getNeoxDeviceFpSafe() ? { NEOX_DEVICE_FP: getNeoxDeviceFpSafe() } : {}),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...spawnSpec.serverModeEnv,
  });

  let spawnCwd = workDir;
  if (!workDir || !fs.existsSync(workDir)) {
    cliLogger.warn('PROCESS_MGR', `workDir 失效 (${workDir}) — server cwd 回退 ${NEOX_DIR} 防 spawn ENOENT`);
    spawnCwd = NEOX_DIR;
  }

  const child = spawn(process.execPath, spawnSpec.args, {
    detached: !isWin,
    stdio: 'ignore',
    env: childEnv,
    cwd: spawnCwd,
    windowsHide: true,
  });

  let childExit: { code: number | null; signal: string | null } | null = null;
  let childErr: Error | null = null;
  child.on('exit', (code, signal) => { childExit = { code, signal }; });
  child.on('error', (e: Error) => { childErr = e; });
  child.unref();

  const killSpawned = () => {
    if (!child.pid) return;
    if (!isWin) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 组没了 */ } }
    try { child.kill('SIGKILL'); } catch { /* 已死 */ }
  };

  const startTime = Date.now();
  while (Date.now() - startTime < STARTUP_TIMEOUT) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkHealth(port)) {
      cliLogger.info('PROCESS_MGR', `Server ready on port ${port} (detached, pid=${child.pid})`);
      return child;
    }
    /* as 快照: 这俩只在上面的 on('exit')/on('error') 回调里被赋值, TS 的线性 CFA 看不到回调
     * 会把它们窄化成 null → 读 .message 报 never. 用 as 重新放宽类型, 绕开误窄. */
    const errNow = childErr as Error | null;
    const exitNow = childExit as { code: number | null; signal: string | null } | null;
    if (errNow || exitNow) {
      const why = errNow ? `spawn error: ${errNow.message}` : `进程提前退出 (code=${exitNow!.code}, signal=${exitNow!.signal})`;
      cliLogger.error('BOOT', `startServer: server ${why}`);
      killSpawned();
      throw new Error(`Server 启动失败 — ${why}.\n  日志: ${LOG_FILE}\n${readDaemonLogTail()}`);
    }
  }

  cliLogger.error('BOOT', `startServer: TIMEOUT (${STARTUP_TIMEOUT}ms)`);
  killSpawned(); // 超时的 server 进程还活着 → 必须杀, 否则孤儿累积抢 db 雪崩
  throw new Error(`Server 启动超时 (${STARTUP_TIMEOUT}ms) — server 没在端口 ${port} 起来.\n  日志: ${LOG_FILE}\n${readDaemonLogTail()}`);
}

export function stopServer(conn: ServerConnection): void {
  // Server 在下次 CLI 启动时会被 ensureServer 自动复用。
  // 仅在 buildHash 变化或用户执行 stopDaemon 时才终止。
  cliLogger.info('PROCESS_MGR', `CLI disconnecting from server (port=${conn.port}), server continues running`);
}

/**
 * shutdownSpawnedServer —— 仅在 **本进程启动的 server** 上生效, 把整个进程组杀掉.
 *
 * 与 stopServer 的区别:
 *   - stopServer 是 no-op: 保留 daemon 让下次 CLI/UI 复用 (对 CLI 场景合理)
 *   - shutdownSpawnedServer 是真正 kill: 适用于 Electron app 退出场景 ——
 *     用户 ⌘Q 后不应该还留着后台 daemon 占着 DB / 端口 / 内存.
 *
 * 只杀我们自己 spawn 的 (conn.process 非空 && reused=false). 如果 server 是
 * 通过 health check 复用的 (比如 CLI 先启动了同 workDir 的 daemon, 然后
 * Electron 连上去), 不会碰它, 避免影响并发运行的 CLI.
 *
 * detached:true spawn 会把子进程放到独立 process group, 用 `process.kill(-pid)`
 * 可以一次性杀掉整个组 (如果 server 又 fork 了孙子进程也一起带走).
 */
export function shutdownSpawnedServer(conn: ServerConnection, workDir?: string, force = false): void {
  if (!force && (conn.reused || !conn.process?.pid)) {
    // 这个连接是复用的, 不是本进程启动的 —— 不碰. force=true 时强制杀 (用户手动触发"重启 server").
    return;
  }
  /* force 模式: 没 conn.process.pid (复用场景) 也要杀, 从 pid file 读 daemon pid */
  let pid = conn.process?.pid;
  if (!pid && force && workDir) {
    try {
      const info = readPidFile(workDir, conn.identityEpoch);
      if (info?.pid) pid = info.pid;
    } catch { /* ignore */ }
  }
  if (!pid) {
    cliLogger.debug('PROCESS_MGR', 'shutdownSpawnedServer: no pid resolvable, nothing to kill');
    if (workDir) { try { removePidFile(workDir, conn.identityEpoch); } catch { /* ignore */ } }
    return;
  }
  try {
    if (isWin) {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
    } else {
      // 先 SIGTERM 整个进程组, 给 server 一个 graceful shutdown 的机会
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      if (force) {
        /* force 模式: 1.5s 后兜底 SIGKILL, 确保 daemon 死透 */
        setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
          try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }, 1500).unref?.();
      }
    }
    cliLogger.info('PROCESS_MGR', `Shut down spawned server (pid=${pid}, port=${conn.port}, force=${force})`);
  } catch (err: any) {
    cliLogger.debug('PROCESS_MGR', `shutdownSpawnedServer pid=${pid}: ${err?.message}`);
  }
  // 同步清掉 pid 文件, 下次启动不会尝试复用一个已经被杀的 pid (同身份键)
  if (workDir) {
    try { removePidFile(workDir, conn.identityEpoch); } catch { /* ignore */ }
  }
}

// ============================================================================
// Daemon 模式 — 独立后台进程
// ============================================================================

function ensureNeoxDir(): void {
  if (!fs.existsSync(NEOX_DIR)) {
    fs.mkdirSync(NEOX_DIR, { recursive: true });
  }
}

function rotateDaemonLogIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return;
    }

    const stat = fs.statSync(LOG_FILE);
    if (stat.size < DAEMON_LOG_MAX_BYTES) {
      return;
    }

    for (let i = DAEMON_LOG_MAX_BACKUPS; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      if (!fs.existsSync(src)) {
        continue;
      }
      if (i === DAEMON_LOG_MAX_BACKUPS) {
        fs.rmSync(src, { force: true });
      } else {
        fs.renameSync(src, dst);
      }
    }

    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (err: any) {
    cliLogger.debug('PROCESS', `Log rotate failed: ${err?.message}`);
  }
}

/**
 * 启动 daemon — detached 进程，CLI 退出不影响
 */
export async function startDaemon(workDir: string, port?: number): Promise<{ pid: number; port: number }> {
  // 检查是否已有 daemon 在运行
  const status = await getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon already running (pid: ${status.pid}, port: ${status.port})`);
  }

  ensureNeoxDir();
  rotateDaemonLogIfNeeded();
  const actualPort = port ?? await findFreePort();

  const spawnSpec = resolveServerSpawn(actualPort, workDir);

  // 日志文件 — 同 startServer: 通过 NEOX_LOG_FILE 让子进程自己重定向, 避免 EBADF.
  // serverModeEnv: 编译版 binary 走 NEOX_WORKER=server 自分发 (见 resolveServerSpawn).
  const child = spawn(process.execPath, spawnSpec.args, {
    detached: !isWin,
    stdio: 'ignore',
    env: withLocalhostNoProxy({ ...process.env, NEOX_DAEMON: '1', NEOX_LOG_FILE: LOG_FILE, ...spawnSpec.serverModeEnv }),
    windowsHide: true,
  });

  // detach — 让子进程独立运行
  child.unref();

  const pid = child.pid!;

  // 等待 server 启动（轮询 health check）
  const startTime = Date.now();
  while (Date.now() - startTime < STARTUP_TIMEOUT) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkHealth(actualPort)) {
      return { pid, port: actualPort };
    }
  }

  // 超时，尝试清理
  killProcess(pid);
  throw new Error(`Daemon startup timeout (${STARTUP_TIMEOUT}ms)`);
}

/**
 * 停止 daemon
 */
export async function stopDaemon(): Promise<boolean> {
  const pidInfo = readPidFile();
  if (!pidInfo) return false;

  try {
    killProcess(pidInfo.pid);
    // 等待进程退出
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      await new Promise(r => setTimeout(r, 300));
      try {
        process.kill(pidInfo.pid, 0); // 检查进程是否存在
      } catch (err) {
        cliLogger.debug('PROCESS_MGR', `Non-critical: ${(err as any)?.message}`);
        return true; // 进程已退出 (expected ESRCH)
      }
    }
    // 强制 kill
    killProcess(pidInfo.pid, true);
    return true;
  } catch (err: any) {
    cliLogger.debug('PROCESS', `Daemon stop failed: ${err?.message}`);
    return false;
  }
}

/**
 * 获取 daemon 状态
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const pidInfo = readPidFile();
  if (!pidInfo) {
    return { running: false, logFile: LOG_FILE };
  }

  // 检查进程是否存活
  let processAlive = false;
  try {
    process.kill(pidInfo.pid, 0);
    processAlive = true;
  } catch (err: any) { cliLogger.debug('PROCESS', `Daemon status probe: pid=${pidInfo.pid} not alive`); }

  // 检查 HTTP 是否响应
  const healthy = processAlive && await checkHealth(pidInfo.port);

  return {
    running: healthy,
    pid: pidInfo.pid,
    port: pidInfo.port,
    workDir: pidInfo.workDir,
    uptime: healthy ? Math.floor((Date.now() - pidInfo.startedAt) / 1000) : undefined,
    logFile: LOG_FILE,
  };
}

/**
 * 获取日志文件路径
 */
export function getLogFile(): string {
  return LOG_FILE;
}
