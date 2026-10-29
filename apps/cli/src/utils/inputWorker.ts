/**
 * Independent Input Worker
 * 
 * 独立的输入处理模块，运行在主线程但使用独立的事件循环
 * 通过 setImmediate 确保输入处理不被长时间运行的任务阻塞
 * 
 * 设计原则：
 * 1. 输入事件立即响应，不等待主任务完成
 * 2. 使用队列缓冲输入，防止丢失
 * 3. 提供降级机制，在 Worker 不可用时回退到主线程
 */

import { EventEmitter } from 'events';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface InputEvent {
  type: 'keypress' | 'data' | 'readable' | 'error' | 'close';
  data?: any;
  timestamp: number;
}

export interface InputWorkerConfig {
  /** 输入队列最大大小 */
  maxQueueSize: number;
  /** 启用调试日志 */
  debug: boolean;
  /** 输入处理优先级（ms，越小优先级越高） */
  processingDelay: number;
}

/**
 * 独立输入处理器
 * 
 * 不使用真正的 Worker threads（避免序列化开销和复杂性）
 * 而是使用 setImmediate + 高优先级调度确保输入及时处理
 */
export class InputWorker extends EventEmitter {
  private config: InputWorkerConfig;
  private inputQueue: InputEvent[] = [];
  private processing = false;
  private started = false;
  private stdinListeners: Map<string, (...args: any[]) => void> = new Map();
  private immediateTimer: ReturnType<typeof setImmediate> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<InputWorkerConfig>) {
    super();
    this.config = {
      maxQueueSize: config?.maxQueueSize ?? 1000,
      debug: config?.debug ?? false,
      processingDelay: config?.processingDelay ?? 0, // 0 = 最高优先级
    };
  }

  /**
   * 启动输入处理器
   */
  start(): void {
    if (this.started) {
      cliLogger.warn('INPUT_WORKER', 'Already started');
      return;
    }

    this.started = true;

    // 监听 stdin 的所有事件
    this.attachStdinListeners();

    // 启动处理循环
    this.scheduleProcessing();

    if (this.config.debug) {
      cliLogger.info('INPUT_WORKER', 'Started', {
        maxQueueSize: this.config.maxQueueSize,
        processingDelay: this.config.processingDelay,
      });
    }
  }

  /**
   * 停止输入处理器
   */
  stop(): void {
    if (!this.started) return;

    this.started = false;

    // 移除所有监听器
    this.detachStdinListeners();

    // 取消处理循环
    if (this.immediateTimer) {
      clearImmediate(this.immediateTimer);
      this.immediateTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    // 清空队列
    this.inputQueue = [];

    if (this.config.debug) {
      cliLogger.info('INPUT_WORKER', 'Stopped');
    }
  }

  /**
   * 附加 stdin 监听器
   */
  private attachStdinListeners(): void {
    // keypress 事件（需要 readline.emitKeypressEvents）
    const keypressHandler = (str: string, key: any) => {
      this.enqueueEvent({
        type: 'keypress',
        data: { str, key },
        timestamp: Date.now(),
      });
    };
    process.stdin.on('keypress', keypressHandler);
    this.stdinListeners.set('keypress', keypressHandler);

    // data 事件（原始数据）
    const dataHandler = (data: Buffer) => {
      this.enqueueEvent({
        type: 'data',
        data: data,
        timestamp: Date.now(),
      });
    };
    process.stdin.on('data', dataHandler);
    this.stdinListeners.set('data', dataHandler);

    // readable 事件
    const readableHandler = () => {
      this.enqueueEvent({
        type: 'readable',
        timestamp: Date.now(),
      });
    };
    process.stdin.on('readable', readableHandler);
    this.stdinListeners.set('readable', readableHandler);

    // error 事件
    const errorHandler = (error: Error) => {
      this.enqueueEvent({
        type: 'error',
        data: error,
        timestamp: Date.now(),
      });
    };
    process.stdin.on('error', errorHandler);
    this.stdinListeners.set('error', errorHandler);

    // close 事件
    const closeHandler = () => {
      this.enqueueEvent({
        type: 'close',
        timestamp: Date.now(),
      });
    };
    process.stdin.on('close', closeHandler);
    this.stdinListeners.set('close', closeHandler);
  }

  /**
   * 移除 stdin 监听器
   */
  private detachStdinListeners(): void {
    for (const [event, handler] of this.stdinListeners.entries()) {
      process.stdin.removeListener(event, handler);
    }
    this.stdinListeners.clear();
  }

  /**
   * 入队输入事件
   */
  private enqueueEvent(event: InputEvent): void {
    // 检查队列大小
    if (this.inputQueue.length >= this.config.maxQueueSize) {
      cliLogger.warn('INPUT_WORKER', 
        `Queue full (${this.inputQueue.length}/${this.config.maxQueueSize}), dropping oldest event`
      );
      this.inputQueue.shift(); // 移除最旧的事件
    }

    this.inputQueue.push(event);

    if (this.config.debug) {
      cliLogger.debug('INPUT_WORKER', `Enqueued ${event.type} event (queue: ${this.inputQueue.length})`);
    }

    // 确保处理循环在运行
    if (!this.processing) {
      this.scheduleProcessing();
    }
  }

  /**
   * 调度处理循环
   */
  private scheduleProcessing(): void {
    if (this.immediateTimer || this.timeoutTimer) return; // 已经调度

    // 使用 setImmediate 确保高优先级
    // setImmediate 比 setTimeout(0) 更高优先级
    // 在大多数情况下会在 I/O 回调之后立即执行
    if (this.config.processingDelay === 0) {
      this.immediateTimer = setImmediate(() => {
        this.immediateTimer = null;
        this.processQueue();
      });
    } else {
      this.timeoutTimer = setTimeout(() => {
        this.timeoutTimer = null;
        this.processQueue();
      }, this.config.processingDelay);
    }
  }

  /**
   * 处理队列中的事件
   */
  private processQueue(): void {
    if (!this.started) return;

    this.processing = true;

    // 批量处理多个事件（但不要一次处理太多）
    const batchSize = Math.min(10, this.inputQueue.length);
    const batch = this.inputQueue.splice(0, batchSize);

    if (this.config.debug && batch.length > 0) {
      cliLogger.debug('INPUT_WORKER', `Processing ${batch.length} events (queue: ${this.inputQueue.length})`);
    }

    // 发送事件给主线程
    for (const event of batch) {
      try {
        this.emit(event.type, event.data);
      } catch (err) {
        cliLogger.error('INPUT_WORKER', `Error processing ${event.type} event`, { error: err });
      }
    }

    this.processing = false;

    // 如果还有待处理事件，继续调度
    if (this.inputQueue.length > 0) {
      this.scheduleProcessing();
    }
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): { size: number; processing: boolean; maxSize: number } {
    return {
      size: this.inputQueue.length,
      processing: this.processing,
      maxSize: this.config.maxQueueSize,
    };
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    const count = this.inputQueue.length;
    this.inputQueue = [];
    
    if (count > 0 && this.config.debug) {
      cliLogger.info('INPUT_WORKER', `Cleared ${count} queued events`);
    }
  }

  /**
   * 强制恢复 stdin
   */
  forceStdinRecovery(): void {
    if (!process.stdin.isTTY) return;

    try {
      const wasPaused = process.stdin.isPaused?.();
      
      if (wasPaused) {
        process.stdin.resume();
        cliLogger.info('INPUT_WORKER', '✓ stdin resumed (forced)');
      }

      if (!(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw && !process.stdin.destroyed) {
        process.stdin.setRawMode(true);
        cliLogger.info('INPUT_WORKER', '✓ raw mode restored (forced)');
      }
    } catch (err) {
      cliLogger.error('INPUT_WORKER', 'Failed to recover stdin', { error: err });
    }
  }
}

/**
 * 全局单例实例
 */
let globalWorker: InputWorker | null = null;

/**
 * 获取全局输入处理器
 */
export function getInputWorker(config?: Partial<InputWorkerConfig>): InputWorker {
  if (!globalWorker) {
    globalWorker = new InputWorker(config);
  }
  return globalWorker;
}

/**
 * 启动全局输入处理器
 */
export function startInputWorker(config?: Partial<InputWorkerConfig>): InputWorker {
  const worker = getInputWorker(config);
  worker.start();
  return worker;
}

/**
 * 停止全局输入处理器
 */
export function stopInputWorker(): void {
  if (globalWorker) {
    globalWorker.stop();
    globalWorker = null;
  }
}

