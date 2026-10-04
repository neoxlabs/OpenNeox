/**
 * readfile Reader - 智能文件读取核心实现
 *
 * 策略优先级:
 * 1. 如果有索引且可用 -> 使用索引精准定位
 * 2. 否则使用 Search + Chunk 方案
 * 3. 兜底使用传统 Chunk 读取
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

import {
  SmartReadOptions,
  ReadResult,
  Locator,
  SymbolInfo,
  SymbolKind,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONTEXT_LINES,
  MAX_CHUNK_SIZE,
} from './types.js';

// Text reads preserve the source encoding when it is supported and reject binary data.
import { safeReadFile, SafeReadError } from '../files/safeReadFile.js';
//  audit P0-H1: 这 7 处 fs ops 走限流 wrapper, 防 K=10 explore 同时读爆 fd
import { safeFs } from '../files/safeFs.js';

import {
  readLines,
  formatLinesWithNumbers,
  findBlockEnd,
  findBlockStart,
  sanitizeForJson,
  extractModule,
  getLanguageFromPath,
  splitContentLines,
} from './utils.js';

import { IndexManager } from './indexManager.js';

/**
 * 智能读取器
 */
export class SmartReader {
  private workspacePath: string;
  private indexManager: IndexManager | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * 设置索引管理器
   */
  setIndexManager(indexManager: IndexManager): void {
    this.indexManager = indexManager;
  }

  /**
   * 智能读取文件
   */
  async read(options: SmartReadOptions): Promise<ReadResult> {
    const {
      path: filePath,
      locator,
      mode = 'smart',
      autoFullThreshold,
      chunkSize = DEFAULT_CHUNK_SIZE,
      expandContext = DEFAULT_CONTEXT_LINES,
      maxLines = MAX_CHUNK_SIZE,
      useIndex = true,
    } = options;

    try {
      const absPath = this.resolvePath(filePath);

      // 检查文件是否存在
      const stats = await safeFs.stat(absPath);
      if (stats.isDirectory()) {
        return this.errorResult(filePath, '这是一个目录，不是文件');
      }

      // 根据模式选择读取策略
      switch (mode) {
        case 'full':
          return this.readFull(absPath, filePath, maxLines);

        case 'chunk':
          if (!locator || locator.type !== 'line') {
            return this.readChunk(absPath, filePath, 1, chunkSize);
          }
          return this.readChunk(absPath, filePath, locator.start, locator.end ? locator.end - locator.start + 1 : chunkSize);

        case 'smart':
        default:
          return this.smartRead(absPath, filePath, locator, {
            autoFullThreshold,
            chunkSize,
            expandContext,
            maxLines,
            useIndex,
          });
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return this.errorResult(filePath, '文件不存在');
      }
      return this.errorResult(filePath, error.message);
    }
  }

  /**
   * 智能读取 - 根据定位器选择最佳策略
   */
  private async smartRead(
    absPath: string,
    displayPath: string,
    locator: Locator | undefined,
    options: {
      autoFullThreshold?: number;
      chunkSize: number;
      expandContext: number;
      maxLines: number;
      useIndex: boolean;
    }
  ): Promise<ReadResult> {
    const { autoFullThreshold, chunkSize, expandContext, maxLines, useIndex } = options;

    // 没有定位器，读取文件开头
    if (!locator) {
      if (typeof autoFullThreshold === 'number' && autoFullThreshold > 0) {
        // safeReadFile removes a BOM, detects binary content, and reports the decoded text.
        let content: string;
        try {
          const result = await safeReadFile(absPath);
          content = result.content;
        } catch (e) {
          if (e instanceof SafeReadError && e.reason === 'binary') {
            return {
              success: false,
              path: displayPath,
              totalLines: 0,
              startLine: 0,
              endLine: 0,
              content: `[Binary file detected — cannot display as text]`,
              truncated: false,
              strategy: 'full',
              error: e.message,
            };
          }
          // 编码不支持时回退到 UTF-8
          content = await safeFs.readFile(absPath, 'utf-8') as string;
        }
        const lines = splitContentLines(sanitizeForJson(content));
        const totalLines = lines.length;

        if (totalLines <= autoFullThreshold) {
          const actualEnd = Math.min(totalLines, maxLines);
          const resultLines = lines.slice(0, actualEnd);
          return {
            success: true,
            path: displayPath,
            totalLines,
            startLine: 1,
            endLine: actualEnd,
            content: formatLinesWithNumbers(resultLines, 1),
            raw: resultLines.join('\n'),
            truncated: actualEnd < totalLines,
            strategy: 'full',
          };
        }

        const actualEnd = Math.min(chunkSize, totalLines);
        const resultLines = lines.slice(0, actualEnd);
        return {
          success: true,
          path: displayPath,
          totalLines,
          startLine: 1,
          endLine: actualEnd,
          content: formatLinesWithNumbers(resultLines, 1),
          raw: resultLines.join('\n'),
          truncated: actualEnd < totalLines,
          strategy: 'chunk',
        };
      }

      return this.readChunk(absPath, displayPath, 1, chunkSize);
    }

    switch (locator.type) {
      case 'line':
        return this.readByLine(absPath, displayPath, locator.start, locator.end, chunkSize);

      case 'pattern':
        return this.readByPattern(absPath, displayPath, locator.regex, {
          matchIndex: locator.matchIndex || 1,
          context: locator.context || expandContext,
          chunkSize,
        });

      case 'symbol':
        return this.readBySymbol(absPath, displayPath, locator.name, {
          kind: locator.kind,
          fuzzy: locator.fuzzy,
          chunkSize,
          useIndex,
        });

      case 'function':
        return this.readBySymbol(absPath, displayPath, locator.name, {
          kind: 'function',
          className: locator.className,
          chunkSize,
          useIndex,
        });

      case 'class':
        return this.readBySymbol(absPath, displayPath, locator.name, {
          kind: 'class',
          chunkSize,
          useIndex,
        });

      case 'range':
        return this.readByRange(absPath, displayPath, locator.startPattern, locator.endPattern, chunkSize);

      default:
        return this.readChunk(absPath, displayPath, 1, chunkSize);
    }
  }

  /**
   * 按行号读取
   */
  private async readByLine(
    absPath: string,
    displayPath: string,
    start: number,
    end: number | undefined,
    chunkSize: number
  ): Promise<ReadResult> {
    const actualEnd = end || start + chunkSize - 1;
    const { lines, totalLines } = await readLines(absPath, start, actualEnd);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine: start,
      endLine: Math.min(actualEnd, totalLines),
      content: formatLinesWithNumbers(lines, start),
      raw: lines.join('\n'),
      truncated: actualEnd < totalLines,
      strategy: 'chunk',
    };
  }

  /**
   * 按模式读取 (Search)
   */
  private async readByPattern(
    absPath: string,
    displayPath: string,
    pattern: string,
    options: {
      matchIndex: number;
      context: number;
      chunkSize: number;
    }
  ): Promise<ReadResult> {
    const { matchIndex, context, chunkSize } = options;

    // Prefer encoding-aware decoding and fall back to UTF-8 for unsupported encodings.
    const content = await safeReadFile(absPath).then(r => r.content).catch(() => safeFs.readFile(absPath, 'utf-8') as Promise<string>);
    const lines = splitContentLines(content);
    const totalLines = lines.length;

    // 创建正则表达式
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch (e: any) {
      return this.errorResult(displayPath, `无效的正则表达式: ${e.message}`);
    }

    // 查找匹配行
    const matchedLines: number[] = [];
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        matchedLines.push(idx + 1); // 1-indexed
      }
      regex.lastIndex = 0;
    });

    if (matchedLines.length === 0) {
      return {
        success: true,
        path: displayPath,
        totalLines,
        startLine: 1,
        endLine: Math.min(chunkSize, totalLines),
        content: `未找到匹配: "${pattern}"\n\n` + formatLinesWithNumbers(lines.slice(0, Math.min(50, totalLines)), 1),
        truncated: false,
        strategy: 'grep',
        metadata: {
          module: extractModule(absPath, this.workspacePath),
        },
      };
    }

    // 获取目标匹配
    const targetMatch = matchedLines[Math.min(matchIndex - 1, matchedLines.length - 1)];

    // 计算读取范围
    const startLine = Math.max(1, targetMatch - context);
    const endLine = Math.min(totalLines, targetMatch + chunkSize - context);

    const resultLines = lines.slice(startLine - 1, endLine);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine,
      endLine,
      content: formatLinesWithNumbers(resultLines, startLine),
      truncated: endLine < totalLines,
      strategy: 'grep',
      metadata: {
        matchedLine: targetMatch,
        module: extractModule(absPath, this.workspacePath),
      },
    };
  }

  /**
   * 按符号读取
   */
  private async readBySymbol(
    absPath: string,
    displayPath: string,
    name: string,
    options: {
      kind?: SymbolKind;
      className?: string;
      fuzzy?: boolean;
      chunkSize: number;
      useIndex?: boolean;
    }
  ): Promise<ReadResult> {
    const { kind, className, fuzzy, chunkSize, useIndex } = options;

    // 尝试使用索引
    if (useIndex && this.indexManager) {
      const indexResult = await this.readBySymbolFromIndex(absPath, displayPath, name, kind, className);
      if (indexResult) {
        return indexResult;
      }
    }

    // 回退到 Search 方案
    const pattern = this.buildSymbolPattern(name, kind, className);
    return this.readSymbolBlock(absPath, displayPath, pattern, name, chunkSize);
  }

  /**
   * 从索引读取符号
   */
  private async readBySymbolFromIndex(
    absPath: string,
    displayPath: string,
    name: string,
    kind?: SymbolKind,
    className?: string
  ): Promise<ReadResult | null> {
    if (!this.indexManager) return null;

    try {
      const fileIndex = await this.indexManager.getFileIndex(absPath);
      if (!fileIndex) return null;

      // 查找符号
      let symbol: SymbolInfo | undefined;

      if (className) {
        // 查找类的方法
        const classSymbol = fileIndex.symbols.find(s => s.kind === 'class' && s.name === className);
        if (classSymbol?.children) {
          symbol = classSymbol.children.find(s => s.name === name);
        }
      } else {
        symbol = fileIndex.symbols.find(s => {
          if (kind && s.kind !== kind) return false;
          return s.name === name;
        });
      }

      if (!symbol) return null;

      // 读取符号范围
      const { lines, totalLines } = await readLines(absPath, symbol.startLine, symbol.endLine);

      return {
        success: true,
        path: displayPath,
        totalLines,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        content: formatLinesWithNumbers(lines, symbol.startLine),
        truncated: false,
        strategy: 'index',
        metadata: {
          symbol,
          module: extractModule(absPath, this.workspacePath),
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * 使用 Search 读取符号块
   */
  private async readSymbolBlock(
    absPath: string,
    displayPath: string,
    pattern: string,
    symbolName: string,
    chunkSize: number
  ): Promise<ReadResult> {
    // Prefer encoding-aware decoding and fall back to UTF-8 for unsupported encodings.
    const content = await safeReadFile(absPath).then(r => r.content).catch(() => safeFs.readFile(absPath, 'utf-8') as Promise<string>);
    const lines = splitContentLines(content);
    const totalLines = lines.length;

    // 查找匹配行
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // 如果正则失败，使用简单字符串匹配
      regex = new RegExp(symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    let matchIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) {
      return {
        success: true,
        path: displayPath,
        totalLines,
        startLine: 1,
        endLine: Math.min(chunkSize, totalLines),
        content: `未找到符号: "${symbolName}"\n\n` + formatLinesWithNumbers(lines.slice(0, Math.min(50, totalLines)), 1),
        truncated: false,
        strategy: 'grep',
      };
    }

    // 智能查找代码块的开始和结束
    const blockStart = findBlockStart(lines, matchIdx);
    const blockEnd = findBlockEnd(lines, blockStart);

    // 限制最大读取范围
    const actualEnd = Math.min(blockEnd, blockStart + chunkSize);

    const resultLines = lines.slice(blockStart, actualEnd);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine: blockStart + 1,
      endLine: actualEnd,
      content: formatLinesWithNumbers(resultLines, blockStart + 1),
      truncated: actualEnd < blockEnd,
      strategy: 'grep',
      metadata: {
        matchedLine: matchIdx + 1,
        module: extractModule(absPath, this.workspacePath),
      },
    };
  }

  /**
   * 按范围读取
   */
  private async readByRange(
    absPath: string,
    displayPath: string,
    startPattern: string,
    endPattern: string,
    chunkSize: number
  ): Promise<ReadResult> {
    // Prefer encoding-aware decoding and fall back to UTF-8 for unsupported encodings.
    const content = await safeReadFile(absPath).then(r => r.content).catch(() => safeFs.readFile(absPath, 'utf-8') as Promise<string>);
    const lines = splitContentLines(content);
    const totalLines = lines.length;

    let startRegex: RegExp;
    let endRegex: RegExp;

    try {
      startRegex = new RegExp(startPattern, 'i');
      endRegex = new RegExp(endPattern, 'i');
    } catch (e: any) {
      return this.errorResult(displayPath, `无效的正则表达式: ${e.message}`);
    }

    // 查找开始和结束位置
    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (startIdx === -1 && startRegex.test(lines[i])) {
        startIdx = i;
      }
      if (startIdx !== -1 && endRegex.test(lines[i])) {
        endIdx = i;
        break;
      }
    }

    if (startIdx === -1) {
      return {
        success: true,
        path: displayPath,
        totalLines,
        startLine: 1,
        endLine: Math.min(chunkSize, totalLines),
        content: `未找到起始模式: "${startPattern}"\n\n` + formatLinesWithNumbers(lines.slice(0, Math.min(50, totalLines)), 1),
        truncated: false,
        strategy: 'grep',
      };
    }

    // 如果没找到结束，使用默认 chunk 大小
    if (endIdx === -1) {
      endIdx = Math.min(startIdx + chunkSize - 1, totalLines - 1);
    }

    // 限制最大范围
    const actualEnd = Math.min(endIdx + 1, startIdx + chunkSize);

    const resultLines = lines.slice(startIdx, actualEnd);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine: startIdx + 1,
      endLine: actualEnd,
      content: formatLinesWithNumbers(resultLines, startIdx + 1),
      truncated: actualEnd < endIdx + 1,
      strategy: 'grep',
      metadata: {
        module: extractModule(absPath, this.workspacePath),
      },
    };
  }

  /**
   * Chunk 读取
   */
  private async readChunk(
    absPath: string,
    displayPath: string,
    start: number,
    numLines: number
  ): Promise<ReadResult> {
    // Prefer encoding-aware decoding and fall back to UTF-8 for unsupported encodings.
    const content = await safeReadFile(absPath).then(r => r.content).catch(() => safeFs.readFile(absPath, 'utf-8') as Promise<string>);
    const lines = splitContentLines(sanitizeForJson(content));
    const totalLines = lines.length;

    const actualStart = Math.max(1, start);
    const actualEnd = Math.min(actualStart + numLines - 1, totalLines);

    const resultLines = lines.slice(actualStart - 1, actualEnd);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine: actualStart,
      endLine: actualEnd,
      content: formatLinesWithNumbers(resultLines, actualStart),
      truncated: actualEnd < totalLines,
      strategy: 'chunk',
    };
  }

  /**
   * 完整读取 (有限制)
   */
  private async readFull(
    absPath: string,
    displayPath: string,
    maxLines: number
  ): Promise<ReadResult> {
    // Prefer encoding-aware decoding and fall back to UTF-8 for unsupported encodings.
    const content = await safeReadFile(absPath).then(r => r.content).catch(() => safeFs.readFile(absPath, 'utf-8') as Promise<string>);
    const lines = splitContentLines(sanitizeForJson(content));
    const totalLines = lines.length;

    const actualEnd = Math.min(totalLines, maxLines);
    const resultLines = lines.slice(0, actualEnd);

    return {
      success: true,
      path: displayPath,
      totalLines,
      startLine: 1,
      endLine: actualEnd,
      content: formatLinesWithNumbers(resultLines, 1),
      truncated: actualEnd < totalLines,
      strategy: 'full',
    };
  }

  /**
   * 构建符号匹配模式
   */
  private buildSymbolPattern(name: string, kind?: SymbolKind, className?: string): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 根据符号类型构建不同的模式
    const patterns: Record<SymbolKind, string> = {
      function: `(function|async\\s+function|const|let|var)\\s+${escapedName}\\s*[=(<]`,
      class: `class\\s+${escapedName}(\\s+extends|\\s+implements|\\s*\\{|\\s*$)`,
      interface: `interface\\s+${escapedName}(\\s+extends|\\s*\\{|\\s*$)`,
      method: className
        ? `(${escapedName}|${className}\\.${escapedName})\\s*\\(`
        : `${escapedName}\\s*\\(`,
      variable: `(const|let|var)\\s+${escapedName}\\s*[=:]`,
      type: `type\\s+${escapedName}\\s*[=<]`,
      enum: `enum\\s+${escapedName}\\s*\\{`,
      constant: `(const|final|static\\s+final)\\s+[A-Z_]+\\s*${escapedName}`,
    };

    if (kind && patterns[kind]) {
      return patterns[kind];
    }

    // 通用模式：匹配常见的定义形式
    return `(function|class|interface|type|enum|const|let|var|def|fn|func)\\s+${escapedName}|${escapedName}\\s*(=|\\()`;
  }

  /**
   * 解析路径
   */
  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(this.workspacePath, filePath);
  }

  /**
   * 创建错误结果
   */
  private errorResult(path: string, error: string): ReadResult {
    return {
      success: false,
      path,
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      content: '',
      truncated: false,
      strategy: 'chunk',
      error,
    };
  }
}

/**
 * 创建 SmartReader 实例
 */
export function createSmartReader(workspacePath: string): SmartReader {
  return new SmartReader(workspacePath);
}
