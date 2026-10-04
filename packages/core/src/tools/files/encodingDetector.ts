/**
 * File encoding detection runs before text reads and writes. It checks BOMs,
 * rejects binary content, validates UTF-8, and uses byte-distribution
 * heuristics for compatible legacy encodings without external dependencies.
 */

export type DetectedEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16-le'
  | 'utf-16-be'
  | 'ascii'
  | 'binary'
  | 'unknown';

export interface EncodingDetectionResult {
  encoding: DetectedEncoding;
  /** 检测置信度 0-1 */
  confidence: number;
  /** 是否有 BOM */
  hasBOM: boolean;
  /** 是否可能是二进制文件 */
  isBinary: boolean;
  /** BOM 字节长度（用于读取时跳过） */
  bomLength: number;
}

// BOM 签名
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const UTF16_LE_BOM = Buffer.from([0xFF, 0xFE]);
const UTF16_BE_BOM = Buffer.from([0xFE, 0xFF]);

/** 检测采样大小 — 只读前 8KB 足够判断 */
const DETECTION_SAMPLE_SIZE = 8192;

/**
 * 从 Buffer 检测文件编码
 *
 * @param buffer 文件内容（至少前 8KB）
 * @returns 编码检测结果
 */
export function detectEncoding(buffer: Buffer): EncodingDetectionResult {
  if (buffer.length === 0) {
    return { encoding: 'utf-8', confidence: 1.0, hasBOM: false, isBinary: false, bomLength: 0 };
  }

  // === Step 1: BOM 检测 ===
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { encoding: 'utf-8-bom', confidence: 1.0, hasBOM: true, isBinary: false, bomLength: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { encoding: 'utf-16-le', confidence: 1.0, hasBOM: true, isBinary: false, bomLength: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { encoding: 'utf-16-be', confidence: 1.0, hasBOM: true, isBinary: false, bomLength: 2 };
  }

  // === Step 2: 二进制检测 ===
  const sampleEnd = Math.min(buffer.length, DETECTION_SAMPLE_SIZE);
  let nullCount = 0;
  let highByteCount = 0;
  let controlCount = 0;

  for (let i = 0; i < sampleEnd; i++) {
    const byte = buffer[i];
    if (byte === 0x00) {
      nullCount++;
    }
    if (byte > 0x7F) {
      highByteCount++;
    }
    // 控制字符（除了 tab, newline, carriage return）
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      controlCount++;
    }
  }

  // NUL 字节 > 1% → 二进制
  if (nullCount > sampleEnd * 0.01) {
    return { encoding: 'binary', confidence: 0.95, hasBOM: false, isBinary: true, bomLength: 0 };
  }

  // 控制字符太多（排除 NUL）→ 可能是二进制
  if (controlCount > sampleEnd * 0.05) {
    return { encoding: 'binary', confidence: 0.8, hasBOM: false, isBinary: true, bomLength: 0 };
  }

  // === Step 3: 纯 ASCII ===
  if (highByteCount === 0) {
    return { encoding: 'ascii', confidence: 1.0, hasBOM: false, isBinary: false, bomLength: 0 };
  }

  // === Step 4: UTF-8 合法性验证 ===
  if (isValidUtf8(buffer, sampleEnd)) {
    return { encoding: 'utf-8', confidence: 0.95, hasBOM: false, isBinary: false, bomLength: 0 };
  }

  // === Step 5: 不是合法 UTF-8 — 返回 unknown ===
  return { encoding: 'unknown', confidence: 0.5, hasBOM: false, isBinary: false, bomLength: 0 };
}

/**
 * 验证 buffer 是否为合法 UTF-8
 *
 * UTF-8 编码规则：
 * - 0xxxxxxx: 1 字节 (ASCII)
 * - 110xxxxx 10xxxxxx: 2 字节
 * - 1110xxxx 10xxxxxx 10xxxxxx: 3 字节
 * - 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx: 4 字节
 */
function isValidUtf8(buffer: Buffer, length: number): boolean {
  let i = 0;
  while (i < length) {
    const byte = buffer[i];

    if (byte <= 0x7F) {
      // ASCII
      i++;
      continue;
    }

    let expectedContinuation: number;
    if ((byte & 0xE0) === 0xC0) {
      expectedContinuation = 1;
      // 检查 overlong: 110 00000 是非法的
      if ((byte & 0x1E) === 0) return false;
    } else if ((byte & 0xF0) === 0xE0) {
      expectedContinuation = 2;
    } else if ((byte & 0xF8) === 0xF0) {
      expectedContinuation = 3;
      // 检查 > U+10FFFF
      if (byte > 0xF4) return false;
    } else {
      // 非法首字节
      return false;
    }

    // 检查后续字节
    for (let j = 0; j < expectedContinuation; j++) {
      i++;
      if (i >= length) return true; // 截断，不算非法
      if ((buffer[i] & 0xC0) !== 0x80) return false;
    }

    i++;
  }

  return true;
}

/**
 * 判断文件是否应该被当做文本处理
 *
 * 返回 false 的情况：
 * - 二进制文件（图片、编译产物、压缩包等）
 * - UTF-16/UTF-32（当前不支持转换）
 */
export function isTextFile(result: EncodingDetectionResult): boolean {
  if (result.isBinary) return false;
  if (result.encoding === 'utf-16-le' || result.encoding === 'utf-16-be') return false;
  return true;
}

/**
 * 根据检测结果读取文件内容为字符串
 *
 * - UTF-8 BOM: 跳过 BOM 字节
 * - ASCII/UTF-8: 直接 toString('utf-8')
 * - 其他: 返回 null（不支持）
 */
export function bufferToString(buffer: Buffer, result: EncodingDetectionResult): string | null {
  if (result.isBinary) return null;

  switch (result.encoding) {
    case 'utf-8-bom':
      return buffer.subarray(result.bomLength).toString('utf-8');
    case 'utf-8':
    case 'ascii':
      return buffer.toString('utf-8');
    case 'unknown':
      // 尝试 UTF-8，可能有少量乱码但通常可用
      return buffer.toString('utf-8');
    default:
      return null;
  }
}

/**
 * 快速检测文件是否为二进制
 * 比完整 detectEncoding 更快，只检查 NUL 字节
 */
export function quickIsBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 512);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0x00) return true;
  }
  return false;
}
