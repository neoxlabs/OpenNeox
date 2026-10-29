/**
 * 统一信号管理器 - Signal Manager
 *
 * 职责：
 * 1. 集中管理所有进程信号的注册和清理
 * 2. 防止信号风暴（signal storm）
 * 3. 提供安全的 TTY 写入包装
 * 4. 确保信号处理的一致性和可维护性
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type SignalHandler = () => void | Promise<void>;

/**
 * 信号类型分类
 */
export enum SignalCategory {
  /** TTY 控制信号 - 必须 ignore 防止信号风暴 */
  TTY_CONTROL = 'tty_control',
  /** 终端断开信号 - 需要重连逻辑 */
  TERMINAL_DISCONNECT = 'terminal_disconnect',
  /** 进程控制信号 - 需要优雅退出 */
  PROCESS_CONTROL = 'process_control',
  /** 用户中断信号 - 需要特殊处理 */
  USER_INTERRUPT = 'user_interrupt',
  /** 自定义恢复信号 - 用于调试和恢复 */
  CUSTOM_RECOVERY = 'custom_recovery',
}

interface SignalConfig {
  signal: NodeJS.Signals;
  category: SignalCategory;
  handler: SignalHandler | 'ignore';
  description: string;
}

class SignalManagerClass {
  private handlers: Map<NodeJS.Signals, SignalHandler[]> = new Map();
  private initialized = false;
  private isInForeground = true;

  /**
   * 初始化信号管理器
   * 必须在 CLI 启动时调用一次
   */
  initialize(): void {
    if (this.initialized) {
      cliLogger.warn('SIGNAL', 'SignalManager already initialized');
      return;
    }

    cliLogger.info('SIGNAL', 'Initializing SignalManager');

    // 使用 'ignore' 告诉 OS 完全忽略信号，防止 libuv 重试循环
    this.setupTTYControlSignals();

    // 其他信号类型的初始化在需要时按需注册
    this.initialized = true;
  }

  /**
   * 设置 TTY 控制信号（防止信号风暴的关键）
   */
  private setupTTYControlSignals(): void {
    if (process.platform === 'win32') {
      cliLogger.debug('SIGNAL', 'Windows platform, skipping POSIX TTY signals');
      return;
    }

    try {
      const ignoreSignal = () => { /* intentionally ignored */ };
      process.on('SIGTTIN', ignoreSignal);
      process.on('SIGTTOU', ignoreSignal);

      cliLogger.info('SIGNAL', 'TTY control signals (SIGTTIN/SIGTTOU) set to ignore');
    } catch (error: any) {
      cliLogger.error('SIGNAL', 'Failed to setup TTY control signals', { error: error.message });
    }
  }

  /**
   * 注册信号处理器
   * @param signal 信号名称
   * @param handler 处理函数
   * @param category 信号类别
   */
  register(signal: NodeJS.Signals, handler: SignalHandler, category: SignalCategory): void {
    if (!this.initialized) {
      cliLogger.warn('SIGNAL', `Registering ${signal} before initialization`);
      this.initialize();
    }

    if (!this.handlers.has(signal)) {
      this.handlers.set(signal, []);

      // 只在第一次注册时设置 Node.js 的信号监听器
      process.on(signal, async () => {
        const handlers = this.handlers.get(signal) || [];
        cliLogger.debug('SIGNAL', `Received ${signal}, executing ${handlers.length} handlers`);

        for (const h of handlers) {
          try {
            await h();
          } catch (error: any) {
            cliLogger.error('SIGNAL', `Handler failed for ${signal}`, { error: error.message });
          }
        }
      });
    }

    this.handlers.get(signal)!.push(handler);
    cliLogger.debug('SIGNAL', `Registered handler for ${signal} (category: ${category})`);
  }

  /**
   * 注销信号处理器
   */
  unregister(signal: NodeJS.Signals, handler: SignalHandler): void {
    const handlers = this.handlers.get(signal);
    if (!handlers) return;

    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
      cliLogger.debug('SIGNAL', `Unregistered handler for ${signal}`);
    }

    // 如果没有处理器了，移除 Node.js 监听器
    if (handlers.length === 0) {
      this.handlers.delete(signal);
      process.removeAllListeners(signal);
      cliLogger.debug('SIGNAL', `Removed all listeners for ${signal}`);
    }
  }

  /**
   * 注销所有信号处理器
   */
  unregisterAll(): void {
    for (const signal of this.handlers.keys()) {
      process.removeAllListeners(signal);
    }
    this.handlers.clear();
    cliLogger.info('SIGNAL', 'Unregistered all signal handlers');
  }

  /**
   * 检测进程是否在前台
   * 用于判断是否可以安全写入 TTY
   */
  checkForeground(): boolean {
    if (process.platform === 'win32') {
      return true; // Windows 不需要检查
    }

    try {
      // 检查进程组 ID 是否等于前台进程组
      const pid = process.pid;
      // @ts-ignore - getpgid exists but not in Node.js types
      const pgid = process.getpgid?.(pid) ?? pid;

      if (!process.stdin.isTTY) {
        return false;
      }

      // 无法可靠检测，假设在前台
      this.isInForeground = true;
      return true;
    } catch (error) {
      // 检测失败，保守假设在前台
      return true;
    }
  }

  /**
   * 获取当前注册的信号列表
   */
  getRegisteredSignals(): NodeJS.Signals[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 清理并重置管理器
   */
  reset(): void {
    this.unregisterAll();
    this.initialized = false;
    cliLogger.info('SIGNAL', 'SignalManager reset');
  }
}

// 导出单例
export const signalManager = new SignalManagerClass();

/**
 * 安全的 TTY 写入包装器
 * 防止后台进程写入 TTY 触发 SIGTTOU
 */
export class SafeTTYWriter {
  private static instance: SafeTTYWriter;

  static getInstance(): SafeTTYWriter {
    if (!SafeTTYWriter.instance) {
      SafeTTYWriter.instance = new SafeTTYWriter();
    }
    return SafeTTYWriter.instance;
  }

  /**
   * 安全写入 stdout
   * 如果进程在后台或 TTY 不可用，静默失败
   */
  writeStdout(data: string): boolean {
    try {
      // 检查 stdout 是否可写
      if (process.stdout.destroyed || !process.stdout.writable) {
        return false;
      }

      // 尝试写入，如果触发 SIGTTOU 会被 ignore
      process.stdout.write(data);
      return true;
    } catch (error: any) {
      // 写入失败，静默忽略（可能是 EPIPE, ENOTTY 等）
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('TTY', 'stdout write failed', { error: error.message });
      }
      return false;
    }
  }

  /**
   * 安全写入 stderr
   */
  writeStderr(data: string): boolean {
    try {
      if (process.stderr.destroyed || !process.stderr.writable) {
        return false;
      }

      process.stderr.write(data);
      return true;
    } catch (error: any) {
      if (process.env.CLI_DEBUG === '1') {
        cliLogger.debug('TTY', 'stderr write failed', { error: error.message });
      }
      return false;
    }
  }

  /**
   * 带检查的 stdout 写入
   * 在写入前检查进程状态
   */
  safeWriteStdout(data: string, options?: {
    fallbackToStderr?: boolean;
    onError?: (error: Error) => void;
  }): boolean {
    const success = this.writeStdout(data);

    if (!success && options?.fallbackToStderr) {
      return this.writeStderr(data);
    }

    if (!success && options?.onError) {
      options.onError(new Error('Failed to write to stdout'));
    }

    return success;
  }
}

// 导出便捷实例
export const safeTTYWriter = SafeTTYWriter.getInstance();

/**
 * 便捷函数：注册常用信号
 */
export function setupCommonSignals(options: {
  onSIGINT?: SignalHandler;
  onSIGTERM?: SignalHandler;
  onSIGHUP?: SignalHandler;
  onSIGUSR1?: SignalHandler;
  onSIGUSR2?: SignalHandler;
  onSIGCONT?: SignalHandler;
  onSIGTSTP?: SignalHandler;
}) {
  signalManager.initialize();

  const ignoreSignal = () => { /* intentionally ignored */ };

  if (options.onSIGINT) {
    signalManager.register('SIGINT', options.onSIGINT, SignalCategory.USER_INTERRUPT);
  }

  if (options.onSIGTERM) {
    signalManager.register('SIGTERM', options.onSIGTERM, SignalCategory.PROCESS_CONTROL);
  }

  if (options.onSIGHUP) {
    signalManager.register('SIGHUP', options.onSIGHUP, SignalCategory.TERMINAL_DISCONNECT);
  }

  if (options.onSIGUSR1) {
    signalManager.register('SIGUSR1', options.onSIGUSR1, SignalCategory.CUSTOM_RECOVERY);
  }

  if (options.onSIGUSR2) {
    signalManager.register('SIGUSR2', options.onSIGUSR2, SignalCategory.CUSTOM_RECOVERY);
  }

  if (options.onSIGCONT) {
    signalManager.register('SIGCONT', options.onSIGCONT, SignalCategory.PROCESS_CONTROL);
  }

  if (options.onSIGTSTP) {
    signalManager.register('SIGTSTP', options.onSIGTSTP, SignalCategory.PROCESS_CONTROL);
  }

  try {
    process.on('SIGTTIN', ignoreSignal);
    process.on('SIGTTOU', ignoreSignal);
  } catch (err: any) {
    cliLogger.debug('SIGNAL', `SIGTTIN/SIGTTOU not supported: ${err?.message}`);
  }
}
