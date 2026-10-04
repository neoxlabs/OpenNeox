/**
 * NeoxLogger - 统一日志引擎
 *
 * 核心日志类，被 cliLogger 和 neoxLogger 共用。
 * - CLI 模式:     cliLogger  → cli-YYYY-MM-DD.log       (CLI_DEBUG=1 开启)
 * - Electron 模式: neoxLogger → neox-app-YYYY-MM-DD.log  (debug 开关控制，默认关)
 *
 * 日志位置: ~/.neox/logs/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { NEOX_HOME_DIRNAME } from '../platform/neoxHome.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/* 在模块加载时绑定原始 stderr 写入函数，绕过运行期对 process.stderr.write 的拦截。
 * 这样日志刷新不会再次进入拦截器并递归产生新的日志。 */
const ORIGINAL_STDERR_WRITE: (chunk: any) => boolean =
  process.stderr.write.bind(process.stderr);

const LOG_RETENTION_DAYS = 7;
const LOG_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const LOG_BATCH_SIZE = Math.max(16, Number.parseInt(process.env.CLI_LOG_BATCH_SIZE ?? '256', 10) || 256);
const LOG_MAX_QUEUE_SIZE = Math.max(1024, Number.parseInt(process.env.CLI_LOG_MAX_QUEUE ?? '20000', 10) || 20000);
const LOG_FLUSH_TIME_BUDGET_MS = Math.max(1, Number.parseInt(process.env.CLI_LOG_FLUSH_BUDGET_MS ?? '4', 10) || 4);
/* 单文件硬上限 — 物理护栏,挡住任何 logger 失控 (例如 TTY_SUPPRESS 死循环曾几秒写出 5G,
 * 16 分钟到 207 GiB).超限时关流 + 重命名为 .roll-<ts>.bak,下次 ensureStream 重建空文件.
 * 默认 100MB,可被 NEOX_LOG_FILE_MAX_MB 覆盖. */
const LOG_FILE_MAX_BYTES = Math.max(
  1024 * 1024,
  (Number.parseInt(process.env.NEOX_LOG_FILE_MAX_MB ?? '100', 10) || 100) * 1024 * 1024,
);
/**
 * ~/.neox/logs 下"认识"的文件 — 不匹配的会被 cleanupLogDirBestEffort 直接 rmSync。
 *
 *   白名单覆盖所有受支持的日志文件前缀和轮转文件。未知文件仍会被清理以限制垃圾堆积，
 *   已知的诊断日志和崩溃取证文件则始终保留到各自的保留策略处理它们。
 */
const KNOWN_LOG_FILE_REGEX = new RegExp(
  '^(' + [
    'cli-\\d{4}-\\d{2}-\\d{2}',
    'neox-app-\\d{4}-\\d{2}-\\d{2}',
    'assistant-debug',
    'explore-debug',
    'stall',
    'tool-trace',
    'ui-trace',
    'mobile-bridge',
    'workspace-watcher',
    'surface-discovery',
  ].join('|') + ')\\.log(\\.1|\\.old)?$',
  /* 两处容易漏掉、漏掉就出事的名字:
   *   · ui-trace  — CLI 界面层常开取证 (见 neox-cli/src/ink/uiTrace.ts), 不列进来开机即被删;
   *   · \.old     — toolTraceLog/uiTrace 轮转出来的上一代叫 `xxx.log.old`, 若只认
   *                 `.log` / `.log.1`, 上一代日志每次启动都会被清掉, 轮转形同虚设。 */
);

/** 崩溃取证 — 由 globalErrorHandling 自己按 CRASH_LOG_KEEP 滚动, 这里只负责别删它。 */
const CRASH_FILE_REGEX = /^crash-\d{8}-\d{6}\.json$/;

type PendingLogEntry = {
  level: LogLevel;
  tag: string;
  message: string;
  data?: any;
};

export interface NeoxLoggerOptions {
  /** 日志文件前缀，例如 'cli' → cli-.log */
  filePrefix: string;
  /** 是否初始启用 */
  enabled: boolean;
}

/**
 * 通用日志引擎 — 异步队列 + 批量落盘
 *
 * 使用方式:
 *   const logger = new NeoxLoggerEngine({ filePrefix: 'neox-app', enabled: false });
 *   logger.setEnabled(true);  // Electron debug 开关打开时调用
 *   logger.info('TAG', 'hello');
 */
export class NeoxLoggerEngine {
  private logDir: string;
  private enabled: boolean;
  private initialized: boolean = false;
  private writeStream: fs.WriteStream | null = null;
  private currentLogFile: string | null = null;
  private backpressured: boolean = false;
  private queue: PendingLogEntry[] = [];
  private flushScheduled: boolean = false;
  private flushing: boolean = false;
  private droppedDebugCount: number = 0;
  /* 当前 log 文件已写字节数 — flushQueue 每次 batch 写完后累加.
   * 超过 LOG_FILE_MAX_BYTES 时触发 rotate,防止任何 bug 把单文件写爆. */
  private currentFileBytes: number = 0;
  private readonly filePrefix: string;

  constructor(options: NeoxLoggerOptions) {
    this.filePrefix = options.filePrefix;
    this.enabled = options.enabled;
    this.logDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
    this.cleanupLogDirBestEffort();
  }

  // ==================== 内部方法 ====================

  private cleanupLogDirBestEffort(): void {
    try {
      if (!fs.existsSync(this.logDir)) return;

      const now = Date.now();
      const cutoffTime = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const entries = fs.readdirSync(this.logDir, { withFileTypes: true });
      const candidates: Array<{ name: string; fullPath: string; size: number; mtimeMs: number }> = [];

      for (const entry of entries) {
        const fullPath = path.join(this.logDir, entry.name);
        /* 子目录不再无条件递归删 — logs/diagnostics 是 uiHandlers 写诊断包的地方 */
        if (entry.isDirectory()) continue;
        if (!entry.isFile()) continue;

        /* crash-*.json 由 globalErrorHandling 自己滚动(保留最近 N 个), 且错误弹窗要用户
           反馈时附上它 — 这里只做保留期兜底, 不参与"陌生文件即删"。 */
        const isCrashFile = CRASH_FILE_REGEX.test(entry.name);
        if (!isCrashFile && !KNOWN_LOG_FILE_REGEX.test(entry.name)) {
          fs.rmSync(fullPath, { force: true });
          continue;
        }

        let stat: fs.Stats;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        if (stat.mtimeMs < cutoffTime) { fs.rmSync(fullPath, { force: true }); continue; }
        if (isCrashFile) continue; // 不进 candidates: 不受总体积淘汰影响, 崩溃取证优先保留
        candidates.push({ name: entry.name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let totalSize = 0;
      for (const item of candidates) {
        totalSize += item.size;
        if (totalSize > LOG_MAX_TOTAL_BYTES) fs.rmSync(item.fullPath, { force: true });
      }
    } catch {
      // best effort
    }
  }

  private init(): void {
    if (this.initialized) return;
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
      this.initialized = true;
    } catch {
      this.enabled = false;
    }
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${this.filePrefix}-${date}.log`);
  }

  private ensureStream(): fs.WriteStream | null {
    if (!this.enabled) return null;
    this.init();
    if (!this.initialized) return null;

    /* 单文件超限护栏 — 见 LOG_FILE_MAX_BYTES 注释.先 rotate 再走打开/复用流程. */
    if (this.currentLogFile && this.currentFileBytes >= LOG_FILE_MAX_BYTES) {
      this.rotateCurrentFile();
    }

    const logFile = this.getLogFilePath();
    if (this.currentLogFile !== logFile) {
      if (this.writeStream) this.writeStream.end();
      // 日志可能包含 token 或 API key 片段，只允许文件所有者读取。
      this.writeStream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
      this.writeStream.on('error', () => {
        this.enabled = false;
        this.currentLogFile = null;
        const stream = this.writeStream;
        this.writeStream = null;
        try { stream?.destroy(); } catch { /* ignore */ }
      });
      this.currentLogFile = logFile;
      /* 切换文件时同步实际大小 (进程重启后接续写已存在的日期文件;rotate 后是新空文件) */
      try { this.currentFileBytes = fs.statSync(logFile).size; }
      catch { this.currentFileBytes = 0; }
    }
    return this.writeStream;
  }

  /* 把当前日志文件 rename 成 .roll-<ts>.bak,关闭旧流,清空 currentLogFile 让下次 ensureStream 重建.
   * cleanupLogDirBestEffort 会按总量上限定期清掉 .bak 文件 (KNOWN_LOG_FILE_REGEX 不匹配 → 直接删). */
  private rotateCurrentFile(): void {
    if (!this.currentLogFile) return;
    const oldFile = this.currentLogFile;
    try { this.writeStream?.end(); } catch { /* ignore */ }
    this.writeStream = null;
    this.currentLogFile = null;
    this.currentFileBytes = 0;
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(oldFile, `${oldFile}.roll-${ts}.bak`);
    } catch { /* ignore — 文件可能已被外部 truncate/删 */ }
  }

  private formatLocalTime(): string {
    const now = new Date();
    const y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${y}-${M}-${d} ${h}:${m}:${s}.${ms}`;
  }

  private formatMessage(level: LogLevel, tag: string, message: string, data?: any): string {
    const timestamp = this.formatLocalTime();
    const levelStr = level.toUpperCase().padEnd(5);
    const tagStr = tag ? `[${tag}]` : '';
    let line = `${timestamp} ${levelStr} ${tagStr} ${message}`;

    if (data !== undefined) {
      try {
        line += ` ${this.safeStringify(data)}`;
      } catch {
        line += ' [Serialization Error]';
      }
    }
    return line + '\n';
  }

  /* · key-based redact: 防未来一次粗心调用把 headers/body 里的 secret 落盘.
   * 命中即用 [REDACTED] 代替; 名单基于所有客户端/服务端已用的 header 与常见 secret 字段. */
  private static readonly REDACT_KEYS = new Set<string>([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-sig', 'x-sig-ts', 'x-sig-nonce', 'x-client-version', 'x-sig-proto',
    'x-device-fp', 'x-machine-id', 'x-neox-key',
    'apikey', 'api_key', 'api-key', 'apiKey',
    'access_token', 'accessToken', 'refresh_token', 'refreshToken',
    'bearer', 'token', 'secret', 'nxk', 'anonkey', 'gatewaykey', 'gateway_key',
    'hmac', 'hmacroot', 'hmac_root', 'root_secret', 'rootsecret',
    'password', 'passwd', 'pwd', 'credential', 'credentials',
    'machineid', 'machine_id', 'fpblob', 'fp_blob',
    'clientsecret', 'client_secret',
    'privatekey', 'private_key', 'signkey', 'sign_key',
  ]);

  private static shouldRedactKey(key: string): boolean {
    if (!key) return false;
    const lower = key.toLowerCase();
    if (NeoxLoggerEngine.REDACT_KEYS.has(lower)) return true;
    /* 通配 — 含 secret/token/password 词根即 redact, 抓一次粗心 dump */
    return /(secret|token|password|apikey|api_key|bearer|nxk_|anonkey_)/i.test(lower);
  }

  private safeStringify(obj: any): string {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (key === 'parser' || key === 'socket' || key === '_httpMessage' || key === 'req' || key === 'res') return '[Omitted]';
      if (value && value.type === 'Buffer' && Array.isArray(value.data)) return '[Buffer]';
      if (typeof value === 'function') return '[Function]';
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      /* Redact 敏感字段: 值必须是 string/number/boolean 才 redact — 对象/数组保留结构不干扰调试. */
      if (
        NeoxLoggerEngine.shouldRedactKey(key)
        && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ) {
        const s = String(value);
        /* 空/占位/明显非 secret 值 (如 'true'/'false'/数字) 保留原值方便调试. */
        if (s.length === 0 || s === 'true' || s === 'false' || /^\d+$/.test(s)) return value;
        return '[REDACTED]';
      }
      return value;
    });
  }

  private write(level: LogLevel, tag: string, message: string, data?: any): void {
    if (!this.enabled) return;

    if (this.backpressured && level === 'debug') {
      this.droppedDebugCount += 1;
      return;
    }

    if (this.queue.length >= LOG_MAX_QUEUE_SIZE) {
      if (level === 'debug') { this.droppedDebugCount += 1; return; }
      const debugIndex = this.queue.findIndex(item => item.level === 'debug');
      if (debugIndex >= 0) { this.queue.splice(debugIndex, 1); this.droppedDebugCount += 1; }
      else { this.queue.shift(); }
    }

    this.queue.push({ level, tag, message, data });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing || !this.enabled) return;
    this.flushScheduled = true;
    setImmediate(() => { this.flushScheduled = false; this.flushQueue(); });
  }

  private flushQueue(): void {
    if (this.flushing || !this.enabled) return;
    if (this.backpressured) { this.scheduleFlush(); return; }

    const stream = this.ensureStream();
    if (!stream) { this.queue.length = 0; this.droppedDebugCount = 0; return; }

    this.flushing = true;
    let batch = '';
    let processed = 0;
    const flushStart = Date.now();

    if (this.droppedDebugCount > 0) {
      batch += this.formatMessage('warn', 'LOGGER', `Dropped ${this.droppedDebugCount} debug logs due to queue pressure`);
      this.droppedDebugCount = 0;
    }

    while (this.queue.length > 0 && processed < LOG_BATCH_SIZE) {
      const entry = this.queue.shift();
      if (!entry) break;
      batch += this.formatMessage(entry.level, entry.tag, entry.message, entry.data);
      processed += 1;
      if (processed >= 32 && Date.now() - flushStart >= LOG_FLUSH_TIME_BUDGET_MS) break;
    }

    if (batch.length > 0) {
      if (process.env.CLI_DEBUG_CONSOLE === '1') {
        /* 必须用 ORIGINAL_STDERR_WRITE,见模块顶部注释 (TTY_SUPPRESS 死循环修复) */
        try { ORIGINAL_STDERR_WRITE(batch); } catch { /* ignore */ }
      }
      const ok = stream.write(batch);
      this.currentFileBytes += Buffer.byteLength(batch, 'utf8');
      if (!ok && !this.backpressured) {
        this.backpressured = true;
        stream.once('drain', () => { this.backpressured = false; this.scheduleFlush(); });
      }
    }

    this.flushing = false;
    if (this.queue.length > 0 && !this.backpressured) this.scheduleFlush();
  }

  // ==================== 公共 API ====================

  debug(tag: string, message: string, data?: any): void { this.write('debug', tag, message, data); }
  info(tag: string, message: string, data?: any): void { this.write('info', tag, message, data); }
  warn(tag: string, message: string, data?: any): void { this.write('warn', tag, message, data); }
  error(tag: string, message: string, data?: any): void { this.write('error', tag, message, data); }

  log(tag: string, ...args: any[]): void {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg;
      try { return this.safeStringify(arg); } catch { return String(arg); }
    }).join(' ');
    this.write('info', tag, message);
  }

  /** 启用/禁用日志 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 当前是否启用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 获取日志目录 */
  getLogDir(): string { return this.logDir; }

  /** 获取当前日志文件 */
  getCurrentLogFile(): string | null { return this.currentLogFile; }

  /** 关闭日志流（进程退出前调用） */
  close(): void {
    if (this.enabled && this.queue.length > 0) {
      const stream = this.ensureStream();
      if (stream) {
        if (this.droppedDebugCount > 0) {
          stream.write(this.formatMessage('warn', 'LOGGER', `Dropped ${this.droppedDebugCount} debug logs due to queue pressure`));
          this.droppedDebugCount = 0;
        }
        let batch = '';
        while (this.queue.length > 0) {
          const entry = this.queue.shift();
          if (!entry) break;
          batch += this.formatMessage(entry.level, entry.tag, entry.message, entry.data);
        }
        if (batch) stream.write(batch);
      }
    }
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
      this.currentLogFile = null;
    }
  }
}

// ==================== 单例：neoxLogger ====================
// Electron 专用日志，写入 ~/.neox/logs/neox-app-YYYY-MM-DD.log
// 使用: import { neoxLogger } from '../platform/neoxLogger.js';
//
// 启用条件（满足任一即启用）：
// 1. Electron main.ts 调用 neoxLogger.setEnabled(true)（主进程内）
// 2. 环境变量 NEOX_UI_MODE=1 + CLI_DEBUG=1（server 子进程继承）
//
//  为什么需要环境变量检测？
// Server 是 spawn 出的独立子进程，main.ts 的 setEnabled(true) 只影响 Electron 主进程。
// 子进程会继承 env vars，所以通过 NEOX_UI_MODE + CLI_DEBUG 自动启用。

function shouldEnableNeoxAppLog(): boolean {
  // Electron UI 模式 + debug 开关打开 → 启用（server子进程场景）
  if (process.env.NEOX_UI_MODE === '1' && process.env.CLI_DEBUG === '1') {
    return true;
  }
  return false;
}

export const neoxLogger = new NeoxLoggerEngine({
  filePrefix: 'neox-app',
  enabled: shouldEnableNeoxAppLog(),
});
