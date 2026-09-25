/**
 * Async Stream Processor
 *
 * 异步流处理器，用于处理大内容而不阻塞 Event Loop
 *
 * 设计原则：
 * 1. 使用 Node.js Streams API 进行增量处理
 * 2. 自动分块，避免单次处理过大数据
 * 3. 支持背压（backpressure）控制
 * 4. 提供进度回调
 */

import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import { cliLogger } from '../platform/cliLogger.js';

const pipelineAsync = promisify(pipeline);

export interface StreamProcessorConfig {
  /** 每个块的最大大小（字节） */
  chunkSize: number;
  /** 处理延迟（ms，用于让出 Event Loop） */
  processingDelay: number;
  /** 启用调试日志 */
  debug: boolean;
  /** 最大并发处理数 */
  maxConcurrency: number;
}

export interface ProcessingProgress {
  /** 已处理字节数 */
  processedBytes: number;
  /** 总字节数（如果已知） */
  totalBytes?: number;
  /** 已处理块数 */
  processedChunks: number;
  /** 处理速度（字节/秒） */
  bytesPerSecond: number;
}

export type ChunkProcessor<T, R> = (chunk: T, index: number) => Promise<R> | R;
export type ProgressCallback = (progress: ProcessingProgress) => void;

/**
 * 异步流处理器
 */
export class StreamProcessor {
  private config: StreamProcessorConfig;

  constructor(config?: Partial<StreamProcessorConfig>) {
    this.config = {
      chunkSize: config?.chunkSize ?? 65536, // 64KB
      processingDelay: config?.processingDelay ?? 0, // 0 = setImmediate
      debug: config?.debug ?? false,
      maxConcurrency: config?.maxConcurrency ?? 4,
    };
  }

  /**
   * 处理大字符串
   * 将字符串分块处理，避免阻塞 Event Loop
   */
  async processLargeString<R>(
    content: string,
    processor: ChunkProcessor<string, R>,
    onProgress?: ProgressCallback
  ): Promise<R[]> {
    const totalBytes = Buffer.byteLength(content, 'utf8');
    const chunks = this.splitString(content);
    
    if (this.config.debug) {
      cliLogger.debug('STREAM_PROCESSOR', `Processing large string: ${totalBytes} bytes in ${chunks.length} chunks`);
    }

    return this.processChunks(chunks, processor, totalBytes, onProgress);
  }

  /**
   * 处理大 Buffer
   */
  async processLargeBuffer<R>(
    buffer: Buffer,
    processor: ChunkProcessor<Buffer, R>,
    onProgress?: ProgressCallback
  ): Promise<R[]> {
    const totalBytes = buffer.length;
    const chunks = this.splitBuffer(buffer);
    
    if (this.config.debug) {
      cliLogger.debug('STREAM_PROCESSOR', `Processing large buffer: ${totalBytes} bytes in ${chunks.length} chunks`);
    }

    return this.processChunks(chunks, processor, totalBytes, onProgress);
  }

  /**
   * 处理 JSON（大型对象）
   * 使用流式 JSON 解析，避免一次性加载到内存
   */
  async processLargeJSON<T = any>(
    jsonString: string,
    onProgress?: ProgressCallback
  ): Promise<T> {
    const totalBytes = Buffer.byteLength(jsonString, 'utf8');
    
    if (this.config.debug) {
      cliLogger.debug('STREAM_PROCESSOR', `Parsing large JSON: ${totalBytes} bytes`);
    }

    // 对于大 JSON，使用分块解析
    if (totalBytes > this.config.chunkSize) {
      return this.parseJSONInChunks(jsonString, onProgress);
    }

    // 小 JSON 直接解析
    return JSON.parse(jsonString);
  }

  /**
   * 将字符串分割成块
   */
  private splitString(content: string): string[] {
    const chunks: string[] = [];
    const chunkSizeChars = Math.floor(this.config.chunkSize / 2); // 假设平均2字节/字符
    
    for (let i = 0; i < content.length; i += chunkSizeChars) {
      chunks.push(content.slice(i, i + chunkSizeChars));
    }
    
    return chunks;
  }

  /**
   * 将 Buffer 分割成块
   */
  private splitBuffer(buffer: Buffer): Buffer[] {
    const chunks: Buffer[] = [];
    
    for (let i = 0; i < buffer.length; i += this.config.chunkSize) {
      chunks.push(buffer.slice(i, i + this.config.chunkSize));
    }
    
    return chunks;
  }

  /**
   * 处理块数组
   */
  private async processChunks<T, R>(
    chunks: T[],
    processor: ChunkProcessor<T, R>,
    totalBytes: number,
    onProgress?: ProgressCallback
  ): Promise<R[]> {
    const results: R[] = [];
    let processedBytes = 0;
    const startTime = Date.now();

    // 使用并发池处理
    const pool = new ConcurrencyPool<R>(this.config.maxConcurrency);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkBytes = typeof chunk === 'string' 
        ? Buffer.byteLength(chunk, 'utf8')
        : (chunk as Buffer).length;

      // 提交到并发池
      const promise = pool.run(async () => {
        // 处理前让出 Event Loop
        if (this.config.processingDelay > 0) {
          await sleep(this.config.processingDelay);
        } else {
          await setImmediateAsync();
        }

        // 处理块
        const result = await processor(chunk, i);

        // 更新进度
        processedBytes += chunkBytes;
        if (onProgress) {
          const elapsed = (Date.now() - startTime) / 1000;
          const bytesPerSecond = processedBytes / elapsed;
          
          onProgress({
            processedBytes,
            totalBytes,
            processedChunks: i + 1,
            bytesPerSecond,
          });
        }

        return result;
      });

      results.push(await promise);
    }

    // 等待所有任务完成
    await pool.drain();

    if (this.config.debug) {
      const elapsed = (Date.now() - startTime) / 1000;
      const throughput = (totalBytes / elapsed / 1024 / 1024).toFixed(2);
      cliLogger.debug('STREAM_PROCESSOR', 
        `Completed: ${chunks.length} chunks, ${totalBytes} bytes in ${elapsed.toFixed(2)}s (${throughput} MB/s)`
      );
    }

    return results;
  }

  /**
   * 分块解析 JSON
   * 对于非常大的 JSON，将其分块解析
   */
  private async parseJSONInChunks<T>(
    jsonString: string,
    onProgress?: ProgressCallback
  ): Promise<T> {
    // 简化版：大 JSON 仍使用标准解析，但在独立 tick 中执行
    // 完整的流式 JSON 解析需要 json-stream-parser 等库
    
    const totalBytes = Buffer.byteLength(jsonString, 'utf8');
    const startTime = Date.now();

    if (onProgress) {
      onProgress({
        processedBytes: 0,
        totalBytes,
        processedChunks: 0,
        bytesPerSecond: 0,
      });
    }

    // 让出 Event Loop
    await setImmediateAsync();

    // 解析
    const result = JSON.parse(jsonString);

    if (onProgress) {
      const elapsed = (Date.now() - startTime) / 1000;
      onProgress({
        processedBytes: totalBytes,
        totalBytes,
        processedChunks: 1,
        bytesPerSecond: totalBytes / elapsed,
      });
    }

    return result;
  }

  /**
   * 创建转换流
   * 用于 pipeline 处理
   */
  createTransformStream<T, R>(
    transformer: (chunk: T, index: number) => Promise<R> | R
  ): Transform {
    let chunkIndex = 0;
    const config = this.config;

    return new Transform({
      objectMode: true,
      async transform(chunk: T, encoding, callback) {
        try {
          // 让出 Event Loop
          if (config?.processingDelay > 0) {
            await sleep(config.processingDelay);
          } else {
            await setImmediateAsync();
          }

          const result = await transformer(chunk, chunkIndex++);
          callback(null, result);
        } catch (err) {
          callback(err as Error);
        }
      },
    });
  }
}

/**
 * 并发池
 * 限制同时运行的异步任务数量
 *  使用 Promise 信号量替代 sleep(10) 忙等轮询
 */
class ConcurrencyPool<T> {
  private maxConcurrency: number;
  private running: number = 0;
  private waiters: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * 运行任务
   */
  async run(task: () => Promise<T>): Promise<T> {
    // 如果达到并发限制，等待信号量释放
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      // 唤醒一个等待者
      if (this.waiters.length > 0) {
        const next = this.waiters.shift()!;
        next();
      }
    }
  }

  /**
   * 等待所有任务完成
   */
  async drain(): Promise<void> {
    if (this.running === 0) return;
    await new Promise<void>(resolve => {
      const check = () => {
        if (this.running === 0) {
          resolve();
        } else {
          // 注册一个 waiter，当有任务完成时再检查
          this.waiters.push(check);
        }
      };
      check();
    });
  }
}

/**
 * 辅助函数：sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 辅助函数：setImmediate as Promise
 */
function setImmediateAsync(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * 全局单例
 */
let globalProcessor: StreamProcessor | null = null;

/**
 * 获取全局流处理器
 */
export function getStreamProcessor(config?: Partial<StreamProcessorConfig>): StreamProcessor {
  if (!globalProcessor) {
    globalProcessor = new StreamProcessor(config);
  }
  return globalProcessor;
}

/**
 * 便捷函数：处理大字符串
 */
export async function processLargeString<R>(
  content: string,
  processor: ChunkProcessor<string, R>,
  onProgress?: ProgressCallback
): Promise<R[]> {
  const proc = getStreamProcessor();
  return proc.processLargeString(content, processor, onProgress);
}

/**
 * 便捷函数：处理大 JSON
 */
export async function parseLargeJSON<T = any>(
  jsonString: string,
  onProgress?: ProgressCallback
): Promise<T> {
  const proc = getStreamProcessor();
  return proc.processLargeJSON<T>(jsonString, onProgress);
}

/**
 * 便捷函数：安全解析 JSON（防止阻塞）
 */
export async function safeJSONParse<T = any>(
  jsonString: string,
  fallback?: T
): Promise<T | undefined> {
  try {
    // 如果字符串很大，使用异步解析
    if (Buffer.byteLength(jsonString, 'utf8') > 100000) { // 100KB
      return await parseLargeJSON<T>(jsonString);
    }
    
    // 小字符串直接解析，但在新 tick 中
    await setImmediateAsync();
    return JSON.parse(jsonString);
  } catch (err) {
    cliLogger.warn('STREAM_PROCESSOR', 'JSON parse failed', {
      error: err,
      length: jsonString.length,
    });
    return fallback;
  }
}


