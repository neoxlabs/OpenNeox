import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import type { EventBus } from '../eventBus.js';
import type { DeviceManager } from '../middleware/device.js';
import type { ChannelRegistry } from '../../channels/registry.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { writePidFile, removePidFile } from '../pidFile.js';
import { computeIdentityEpoch } from '@neoxlabs/platform/platform/identityCredential.js';

interface StartServerLifecycleOptions {
  appFetch: any;
  port: number;
  hostname: string;
  workDir: string;
  daemon: boolean;
  /** 本端身份目录 (--identity-dir, 阶段4): 写进 pid file, 复用时核对身份纪元。 */
  identityDir?: string;
  /** Bearer token, 写入 pid file 供 client 回灌 */
  authToken: string;
  channelRegistry: ChannelRegistry;
  deviceManager: DeviceManager;
  bus: EventBus;
  onBeforeShutdown?: () => void | Promise<void>;
  onServerReady?: (httpServer: HttpServer) => void;
}

export function startServerLifecycle(options: StartServerLifecycleOptions): void {
  const {
    appFetch,
    port,
    hostname,
    workDir,
    daemon,
    identityDir,
    authToken,
    channelRegistry,
    deviceManager,
    bus,
    onBeforeShutdown,
  } = options;

  /* 身份纪元 (阶段4): 与 client(processManager) 用同一 computeIdentityEpoch 算, 保证可比对。
   * identityDir 缺省时 epoch='anon' (老 CLI / 无身份目录场景)。 */
  let identityEpoch = 'anon';
  try {
    if (identityDir) identityEpoch = computeIdentityEpoch(identityDir);
  } catch { /* 取不到身份 → anon */ }

  writePidFile({ pid: process.pid, port, workDir, startedAt: Date.now(), daemon, token: authToken, identityDir, identityEpoch });

  let shuttingDown = false;

  const cleanup = (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cliLogger.info('SERVER', `Shutting down (${reason})...`);
    const finish = () => {
      channelRegistry.stopAll().catch(err => cliLogger.debug('SERVER', `Channel stop failed: ${err?.message}`));
      removePidFile(workDir, identityEpoch);
      deviceManager.dispose();
      bus.dispose();
      process.exit(exitCode);
    };
    let finished = false;
    const finishOnce = () => { if (!finished) { finished = true; finish(); } };
    const hardTimeout = setTimeout(() => {
      cliLogger.warn('SERVER', 'shutdown cleanup 超过 4s, 强制退出');
      finishOnce();
    }, 4_000);
    hardTimeout.unref?.();
    void Promise.resolve(onBeforeShutdown?.())
      .catch(err => cliLogger.warn('SERVER', `onBeforeShutdown failed: ${err?.message ?? err}`))
      .finally(() => { clearTimeout(hardTimeout); finishOnce(); });
  };

  let rejectionCount = 0;
  let rejectionWindowStart = Date.now();
  const REJECTION_WINDOW_MS = 30_000; // 30s
  const REJECTION_CRASH_THRESHOLD = 5;

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));
  process.on('uncaughtException', (error) => {
    cliLogger.error('SERVER', 'Uncaught exception', { error });
    cleanup('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    // 对于长期运行的 daemon，瞬态的 Promise rejection（网络超时、
    // SSE 客户端断连等）是常见的，不应导致服务崩溃。
    cliLogger.error('SERVER', 'Unhandled rejection (non-fatal)', { error: reason });

    // 安全阀：短时间内大量 rejection 仍然 crash（防止死循环）
    const now = Date.now();
    if (now - rejectionWindowStart > REJECTION_WINDOW_MS) {
      rejectionCount = 0;
      rejectionWindowStart = now;
    }
    rejectionCount++;
    if (rejectionCount >= REJECTION_CRASH_THRESHOLD) {
      cliLogger.error('SERVER', `${REJECTION_CRASH_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS / 1000}s — crashing to avoid infinite loop`);
      cleanup('unhandledRejection-flood', 1);
    }
  });
  process.on('exit', () => {
    removePidFile(workDir, identityEpoch);
  });

  const server = serve({ fetch: appFetch, port, hostname }, (info) => {
    cliLogger.info('SERVER', `Neox Server listening on http://${hostname}:${info.port}`);
    if (process.send) {
      process.send({ type: 'ready', port: info.port });
    }
    if (options.onServerReady && server) {
      options.onServerReady(server as unknown as HttpServer);
    }
  });
}
