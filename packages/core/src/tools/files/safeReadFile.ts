/**
 * Encoding-aware text reads detect BOMs, normalize supported text encodings,
 * and reject binary files before content reaches file tools.
 */

import * as fs from 'fs/promises';
import { runWithFileLimit } from './fileLimiter.js';
import { detectEncoding, bufferToString, isTextFile, quickIsBinary, type EncodingDetectionResult } from './encodingDetector.js';
export type { EncodingDetectionResult } from './encodingDetector.js';

export interface SafeReadResult {
  content: string;
  encoding: EncodingDetectionResult;
}

/**
 * 编码感知的文件读取
 *
 * - 自动跳过 BOM
 * - 二进制文件返回错误信息
 * - 非 UTF-8 文件返回警告
 * - 支持 AbortSignal:大文件读到一半被 abort 立即 reject(Node 16+ 原生支持)
 *
 * @param filePath 绝对文件路径
 * @param options.signal AbortSignal, 传入后读大文件中途可立即取消
 * @returns 文件内容字符串
 * @throws 如果文件是二进制或不支持的编码, 或 signal 被 abort 抛 AbortError
 */
export async function safeReadFile(
  filePath: string,
  options?: { signal?: AbortSignal },
): Promise<SafeReadResult> {
  if (options?.signal?.aborted) {
    throw buildAbortError();
  }
  /* H1: 走共享 FD limiter — K=10 explore 子 agent 并发 readfile 不再爆 EMFILE */
  const buffer = await runWithFileLimit(() =>
    fs.readFile(filePath, options?.signal ? { signal: options.signal } : undefined),
  );
  const encoding = detectEncoding(buffer);

  if (!isTextFile(encoding)) {
    throw new SafeReadError(
      `Cannot read binary file: ${filePath}`,
      'binary',
      encoding,
    );
  }

  const content = bufferToString(buffer, encoding);
  if (content === null) {
    throw new SafeReadError(
      `Unsupported encoding (${encoding.encoding}) for file: ${filePath}`,
      'unsupported_encoding',
      encoding,
    );
  }

  return { content, encoding };
}

/**
 * 编码感知的文件写入
 *
 * 保持原文件的 BOM 状态：
 * - 如果原文件有 UTF-8 BOM，写入时保留 BOM
 * - 如果原文件没有 BOM，写入时不加 BOM
 */
export async function safeWriteFile(
  filePath: string,
  content: string,
  originalEncoding?: EncodingDetectionResult,
): Promise<void> {
  /* H1: writeFile 也走 limiter */
  if (originalEncoding?.encoding === 'utf-8-bom') {
    // 保留 BOM
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const contentBuffer = Buffer.from(content, 'utf-8');
    await runWithFileLimit(() => fs.writeFile(filePath, Buffer.concat([bom, contentBuffer])));
  } else {
    await runWithFileLimit(() => fs.writeFile(filePath, content, 'utf-8'));
  }
}

export class SafeReadError extends Error {
  constructor(
    message: string,
    public readonly reason: 'binary' | 'unsupported_encoding',
    public readonly encoding: EncodingDetectionResult,
  ) {
    super(message);
    this.name = 'SafeReadError';
  }
}

function buildAbortError(): Error {
  const err = new Error('safeReadFile aborted by signal');
  err.name = 'AbortError';
  return err;
}
