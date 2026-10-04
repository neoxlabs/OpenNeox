/**
 * CLI Backend Logger - CLI 专用日志
 *
 * 基于 NeoxLoggerEngine 的 CLI 实例。
 * - 文件名: cli-YYYY-MM-DD.log
 * - 启用条件: CLI_DEBUG=1 或 --debug
 * - 日志位置: ~/.neox/logs/
 *
 * Electron 请使用 neoxLogger（neox-app-*.log）
 *
 *  注意：100+ 文件 import { cliLogger }，此模块保持完全向后兼容
 */

import { NeoxLoggerEngine } from './neoxLogger.js';
export type { LogLevel } from './neoxLogger.js';

// ==================== CLI 日志单例 ====================
// CLI 模式: cli-YYYY-MM-DD.log, 由 CLI_DEBUG=1 控制

function shouldEnableCliLog(): boolean {
  if (process.env.CLI_DEBUG === '1' || process.env.CLI_DEBUG_CONSOLE === '1') {
    return true;
  }
  return process.argv.includes('--debug') || process.argv.includes('--debug-console');
}

export const cliLogger = new NeoxLoggerEngine({
  filePrefix: 'cli',
  enabled: shouldEnableCliLog(),
});

// ==================== 工具函数（保持不变） ====================

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'api_key',
  'apikey',
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
]);

/* 凭证字段始终脱敏，与 maskSensitive 是否允许显示完整请求体无关。请求体中的非凭证字段
 * 可按调试开关保留原值，Authorization、API key 以及 URL 查询参数中的密钥不能写入日志。 */
export function maskCredential(raw: string): string {
  if (!raw) return raw;
  const prefix = raw.startsWith('Bearer ') ? 'Bearer ' : '';
  const token = prefix ? raw.slice(prefix.length) : raw;
  if (token.length <= 12) return `${prefix}[REDACTED]`;
  return `${prefix}${token.slice(0, 6)}…[REDACTED]…${token.slice(-4)}`;
}

const SENSITIVE_QUERY_KEYS = new Set(['key', 'api_key', 'apikey', 'access_token', 'token']);

/** 遮掉 URL query 里的凭证 (Gemini 的 `?key=` 就走这条)。解析失败就原样返回。 */
export function maskUrlSecrets(url: string): string {
  try {
    const u = new URL(url);
    let touched = false;
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
        /* URL 里用纯 ASCII 的遮蔽形态: searchParams 会把 `…` 和 `[]` 百分号编码成
         * %E2%80%A6%5BREDACTED%5D 那种鬼样子, 一眼看不出是被遮了还是 key 本来就长这样。 */
        const v = u.searchParams.get(k) || '';
        u.searchParams.set(k, v.length > 12 ? `${v.slice(0, 6)}.REDACTED.${v.slice(-4)}` : 'REDACTED');
        touched = true;
      }
    }
    return touched ? u.toString() : url;
  } catch {
    return url;
  }
}

function safeStringifyPayload(payload: any, maskSensitive: boolean): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(payload, (key, value) => {
      if (maskSensitive && key) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_PAYLOAD_KEYS.has(lowerKey)) {
          return '[REDACTED]';
        }
      }
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (typeof value === 'function') {
        return '[Function]';
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({ error: '[Unserializable payload]' });
  }
}

/**
 * 生成可复制的 curl 命令用于调试 LLM 请求
 * @param url 请求 URL
 * @param headers 请求头
 * @param payload 请求体
 * @param maskSensitive 是否遮蔽**请求体字段**（默认 true）。
 *        注意: 凭证 (Authorization / x-api-key / URL 上的 ?key=) 不受此参数控制,
 *        永远遮蔽 —— 见上面 maskCredential 的说明。
 */
export function generateCurlCommand(
  url: string,
  headers: Record<string, string>,
  payload: any,
  maskSensitive: boolean = true
): string {
  const lines: string[] = ['curl -X POST \\'];

  // 添加 URL（query 里的 key 一律遮）
  lines.push(`  '${maskUrlSecrets(url)}' \\`);

  // 添加 headers
  const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-api-key', 'x-goog-api-key', 'api-key']);
  for (const [key, value] of Object.entries(headers)) {
    const headerValue = CREDENTIAL_HEADERS.has(key.toLowerCase()) ? maskCredential(value) : value;
    lines.push(`  -H '${key}: ${headerValue}' \\`);
  }

  // 添加 payload - 不截断，完整输出以便复制测试（敏感字段会被遮蔽）
  const payloadStr = safeStringifyPayload(payload, maskSensitive);
  lines.push(`  -d '${escapeShellString(payloadStr)}'`);

  return lines.join('\n');
}

/**
 * 转义 shell 字符串中的特殊字符
 */
function escapeShellString(str: string): string {
  // 转义单引号：将 ' 替换为 '\''
  return str.replace(/'/g, "'\\''" );
}

/**
 * 打印 LLM 请求的 curl 命令到日志
 * 只在 CLI_DEBUG=1 时生效
 */
export function logCurlCommand(
  url: string,
  headers: Record<string, string>,
  payload: any
): void {
  if (process.env.CLI_DEBUG !== '1') return;

  const curlCmd = generateCurlCommand(url, headers, payload);

  // 写入日志文件
  cliLogger.info('CURL', '=== LLM Request CURL Command ===');
  cliLogger.info('CURL', curlCmd);
  cliLogger.info('CURL', '=== End CURL Command ===');

  /* CLI_DEBUG_CONSOLE=1 时直写 stderr — 严禁走 console.*.
   *
   * 原因: console.log/error 是用户面向的友好输出通道, 会被:
   *   - patch-console (REPL 内 /usage 等命令的输出 capture) 偷走 → 污染命令输出
   *   - Ink alt-screen 吞掉 → 用户看不到
   * process.stderr.write 绕过 console hook, 直达终端 stderr, 不进任何 capture buffer.
   * 历史教训:  /usage 卡片里混进 [INPUT_HEALTH]/[APP] 行就是 console.log 被 capture. */
  if (process.env.CLI_DEBUG_CONSOLE === '1') {
    process.stderr.write('\n[CURL] === LLM Request CURL Command ===\n');
    process.stderr.write(curlCmd + '\n');
    process.stderr.write('[CURL] === End CURL Command ===\n\n');
  }
}

/**
 * CLI 健康监控器 - 用于诊断卡住问题
 * 定期检查事件循环和 stdin 状态
 */
class CLIHealthMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private lastHeartbeat: number = Date.now();
  private heartbeatCount: number = 0;
  private stdinPausedCount: number = 0;
  private enabled: boolean = false;
  private pid: number = process.pid;  // 记录进程 ID

  /**
   * 启动健康监控
   * @param intervalMs 检查间隔（毫秒），默认 5000ms
   */
  start(intervalMs: number = 5000): void {
    if (this.intervalId || process.env.CLI_DEBUG !== '1') {
      return;
    }

    //  只在 TTY 主进程中启动健康监控
    // 子进程的 stdin 通常不是 TTY
    if (!process.stdin.isTTY) {
      cliLogger.debug('HEALTH', `Skipping health monitor in non-TTY process (pid=${this.pid})`);
      return;
    }

    this.enabled = true;
    this.lastHeartbeat = Date.now();
    this.heartbeatCount = 0;
    this.stdinPausedCount = 0;

    cliLogger.info('HEALTH', `Health monitor started (interval: ${intervalMs}ms, pid=${this.pid})`);

    this.intervalId = setInterval(() => {
      this.checkHealth();
    }, intervalMs);

    // 不阻止进程退出
    this.intervalId.unref();
  }

  /**
   * 停止健康监控
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.enabled = false;
      cliLogger.info('HEALTH', 'Health monitor stopped');
    }
  }

  private stdinDestroyedCount: number = 0;

  /**
   * 执行健康检查
   */
  private checkHealth(): void {
    const now = Date.now();
    const elapsed = now - this.lastHeartbeat;
    this.lastHeartbeat = now;
    this.heartbeatCount++;

    // 检查 stdin 状态
    const stdinState = this.getStdinState();

    // 如果 stdin 被暂停，增加计数
    if (stdinState.isPaused) {
      this.stdinPausedCount++;
    } else {
      this.stdinPausedCount = 0;
    }

    //  关键修复：如果 stdin 被 destroyed，进程应该退出
    // 避免僵尸进程持续运行
    if (stdinState.destroyed) {
      this.stdinDestroyedCount++;
      if (this.stdinDestroyedCount >= 3) {
        cliLogger.warn('HEALTH', `[pid=${this.pid}] stdin destroyed for ${this.stdinDestroyedCount} checks, exiting to avoid zombie process`);
        this.stop();
        // 给一点时间让日志写入
        setTimeout(() => {
          process.exit(0);
        }, 100);
        return;
      }
    } else {
      this.stdinDestroyedCount = 0;
    }

    // 记录健康状态（包含 pid）
    cliLogger.debug('HEALTH', `[pid=${this.pid}] Heartbeat #${this.heartbeatCount}`, {
      elapsed: `${elapsed}ms`,
      stdin: stdinState,
      stdinPausedCount: this.stdinPausedCount,
    });

    // 如果 stdin 连续被暂停超过 3 次，发出警告
    if (this.stdinPausedCount >= 3) {
      cliLogger.warn('HEALTH', `[pid=${this.pid}] ⚠️ stdin has been paused for ${this.stdinPausedCount} consecutive checks!`, {
        stdin: stdinState,
      });
    }

    // 如果事件循环延迟超过预期间隔的 2 倍，发出警告
    if (elapsed > 10000) {
      cliLogger.warn('HEALTH', `[pid=${this.pid}] ⚠️ Event loop delay detected: ${elapsed}ms (expected ~5000ms)`);
    }
  }

  /**
   * 获取 stdin 状态
   */
  private getStdinState(): {
    isPaused: boolean;
    isTTY: boolean;
    isRaw: boolean;
    readable: boolean;
    destroyed: boolean;
  } {
    const stdin = process.stdin;
    return {
      isPaused: typeof stdin.isPaused === 'function' ? stdin.isPaused() : false,
      isTTY: !!stdin.isTTY,
      isRaw: !!(stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw,
      readable: stdin.readable,
      destroyed: stdin.destroyed,
    };
  }

  /**
   * 手动记录 stdin 状态（用于关键时刻）
   */
  logStdinState(tag: string): void {
    if (process.env.CLI_DEBUG !== '1') return;

    const state = this.getStdinState();
    cliLogger.debug('STDIN', `[${tag}] stdin state`, state);
  }

  /**
   * 记录 Ink 渲染状态
   */
  logInkState(tag: string, data: {
    instanceExists: boolean;
    logsCount: number;
    promptState: boolean;
    inputDisabled: boolean;
  }): void {
    if (process.env.CLI_DEBUG !== '1') return;

    cliLogger.debug('INK', `[${tag}]`, data);
  }
}

// 导出健康监控器单例
export const cliHealthMonitor = new CLIHealthMonitor();

/**
 * Debug 日志函数 - 用于替代直接的 console.log
 * - CLI_DEBUG=1: 只写入文件（~/.neox/logs/）
 * - CLI_DEBUG_CONSOLE=1: 同时直写 stderr (绕过 console.*)
 *
 * 使用方法: debugLog('TAG', 'message', { optional: 'data' })
 *
 *  架构不变式 (违反就会引入 bug, 别动):
 *   infra 诊断输出 **永远不能** 走 console.log/error/warn — 因为:
 *   1. patch-console (REPL 命令输出 capture) 会偷, 让诊断行混进命令输出
 *   2. Ink alt-screen 会吞, 用户看不到
 *   所以这里写 process.stderr.write 直达 TTY stderr, 不经过 console 钩子.
 *   console.* 是 "用户友好输出" 专用通道 — 留给命令的 friendly 文案.
 *
 *   诊断输出直接写入 stderr，避免被命令输出捕获或被 Ink alt-screen 隐藏；console.* 只用于
 *   面向用户的命令输出。
 */
export function debugLog(tag: string, message: string, data?: any): void {
  if (process.env.CLI_DEBUG !== '1') return;

  // 总是写入文件
  cliLogger.debug(tag, message, data);

  /* CLI_DEBUG_CONSOLE=1 时直写 stderr — 严禁走 console.*. 见上方架构不变式. */
  if (process.env.CLI_DEBUG_CONSOLE === '1') {
    const prefix = tag ? `[${tag}] ` : '';
    let dataStr = '';
    if (data !== undefined) {
      try { dataStr = ' ' + JSON.stringify(data); }
      catch { dataStr = ' [unserializable]'; }
    }
    process.stderr.write(`${prefix}${message}${dataStr}\n`);
  }
}

/**
 * 安装全局异常处理器
 * 捕获未处理的异常和 Promise rejection，写入日志
 * 同时处理 TTY 相关信号防止进程被挂起
 */
export function installCrashHandler(): void {
  process.on('uncaughtException', (error: Error) => {
    cliLogger.error('CRASH', 'Uncaught Exception', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });

    const errorCode = (error as Error & { code?: string }).code;

    // TTY 在终端断开/关闭时可能抛出 read/write EIO
    // 该错误通常是可恢复的，不应直接杀死进程
    if (errorCode === 'EIO' || error.message?.includes('EIO')) {
      cliLogger.warn('CRASH', 'Non-fatal TTY EIO suppressed, continuing...');
      return;
    }

    // 第三方库的非致命 WebSocket 错误不应杀死进程
    if (error.message?.includes('WebSocket is not open')) {
      cliLogger.warn('CRASH', 'Non-fatal WebSocket error suppressed, continuing...');
      return;
    }

    // 给日志时间写入
    setTimeout(() => process.exit(1), 100);
  });

  process.on('unhandledRejection', (reason: any) => {
    cliLogger.error('CRASH', 'Unhandled Rejection', {
      reason: reason instanceof Error ? {
        name: reason.name,
        message: reason.message,
        stack: reason.stack,
      } : reason,
    });
  });

  //  立即初始化信号管理器（必须同步，不能用异步 import）
  // SIGTTIN/SIGTTOU 必须在任何 stdin 操作前设置为 ignore
  // 否则长时间运行任务可能触发 "suspended (tty input)" 错误
  try {
    process.on('SIGTTIN', () => { /* ignored intentionally */ });
    process.on('SIGTTOU', () => { /* ignored intentionally */ });
    cliLogger.info('SIGNAL', 'TTY control signals (SIGTTIN/SIGTTOU) initialized in crashHandler');
  } catch (error: any) {
    // Windows doesn't support these signals
  }

  // 正常退出时关闭日志流
  process.on('exit', () => {
    cliLogger.close();
  });
}
