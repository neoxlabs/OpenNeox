import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface SetupGlobalErrorHandlingOptions {
  isPackaged: boolean;
  showErrorBox: (title: string, content: string) => void;
  appVersion?: string;
}

const CRASH_LOG_DIR = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
const CRASH_LOG_KEEP = 20;

function writeCrashLog(
  kind: 'uncaughtException' | 'unhandledRejection',
  error: unknown,
  appVersion: string | undefined,
): void {
  try {
    fs.mkdirSync(CRASH_LOG_DIR, { recursive: true });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const payload = {
      kind,
      timestamp: now.toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      code: (error as NodeJS.ErrnoException | null)?.code,
      appVersion,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
    };
    fs.writeFileSync(
      path.join(CRASH_LOG_DIR, `crash-${stamp}.json`),
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
    /* 滚动清理 — 文件名时间戳字典序即时间序, 删最旧的 */
    const files = fs.readdirSync(CRASH_LOG_DIR)
      .filter(f => /^crash-\d{8}-\d{6}\.json$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - CRASH_LOG_KEEP))) {
      try { fs.unlinkSync(path.join(CRASH_LOG_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* 崩溃记录本身绝不能再抛 */ }
}

export function setupGlobalErrorHandling(options: SetupGlobalErrorHandlingOptions): void {
  const { isPackaged, showErrorBox, appVersion } = options;

  const IGNORABLE_NETWORK_ERRORS = new Set([
    'EPIPE', 'EADDRNOTAVAIL', 'EADDRINUSE', 'ENETUNREACH', 'ENETDOWN',
    'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  ]);
  process.on('uncaughtException', (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && IGNORABLE_NETWORK_ERRORS.has(code)) {
      /* 非致命网络抖动 — 只 log, 不弹窗, 不 exit, 也不落崩溃档案 (会把配额刷掉). */
      console.warn(`[uncaughtException:network] ${code}: ${error.message}`);
      return;
    }
    writeCrashLog('uncaughtException', error, appVersion);
    if (isPackaged) {
      try {
        showErrorBox('Uncaught Exception', error.message);
      } catch {
        // If dialog fails, silently ignore
      }
    } else {
      console.error('Uncaught Exception:', error);
    }
  });

  process.on('unhandledRejection', (reason: any) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
    console.error('[unhandledRejection]', msg);
    const code = (reason as NodeJS.ErrnoException | null)?.code;
    if (code && IGNORABLE_NETWORK_ERRORS.has(code)) return; /* 网络抖动不占崩溃档案配额 */
    writeCrashLog('unhandledRejection', reason, appVersion);
  });

  if (isPackaged) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const safeConsole = (fn: typeof console.log) => {
      return (...args: any[]) => {
        try {
          fn.apply(console, args);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'EPIPE') {
            throw error;
          }
        }
      };
    };

    console.log = safeConsole(originalLog);
    console.warn = safeConsole(originalWarn);
    console.error = safeConsole(originalError);
  }
}
