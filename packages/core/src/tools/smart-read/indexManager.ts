/**
 * Index Manager - AST 索引管理器
 *
 * 负责:
 * - 构建和维护代码索引
 * - 查询符号信息
 * - 索引的持久化和加载
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
//  audit P0-H2: 索引读 / 重建路径全走限流, 防 1000+ 文件并发 readFile 爆 fd
import { safeFs } from '../files/safeFs.js';

import {
  FileIndex,
  IndexMetadata,
  IndexConfig,
  IndexBuildResult,
  SymbolInfo,
  SymbolSearchResult,
  SymbolKind,
  DEFAULT_INDEX_CONFIG,
} from './types.js';

import {
  computeHash,
  fileExists,
  ensureDir,
  getLanguageFromPath,
  similarity,
  splitContentLines,
} from './utils.js';

import { LanguageParserRegistry } from './parsers/registry.js';

const INDEX_VERSION = '1.0.0';

/**
 * 索引管理器
 */
export class IndexManager {
  private workspacePath: string;
  private config: IndexConfig;
  private metadata: IndexMetadata | null = null;
  private fileIndexCache: Map<string, FileIndex> = new Map();
  private parserRegistry: LanguageParserRegistry;

  constructor(workspacePath: string, config: Partial<IndexConfig> = {}) {
    this.workspacePath = workspacePath;
    this.config = { ...DEFAULT_INDEX_CONFIG, ...config };
    this.parserRegistry = new LanguageParserRegistry();
  }

  /**
   * 获取索引目录路径
   */
  get indexDir(): string {
    return path.join(this.workspacePath, this.config.cacheDir);
  }

  /**
   * 检查索引是否存在
   */
  async hasIndex(): Promise<boolean> {
    const metaPath = path.join(this.indexDir, 'meta.json');
    return fileExists(metaPath);
  }

  /**
   * 加载索引元信息
   */
  async loadMetadata(): Promise<IndexMetadata | null> {
    if (this.metadata) return this.metadata;

    const metaPath = path.join(this.indexDir, 'meta.json');
    try {
      const content = await safeFs.readFile(metaPath, 'utf-8');
      this.metadata = JSON.parse(content);
      return this.metadata;
    } catch {
      return null;
    }
  }

  /**
   * 保存索引元信息
   */
  private async saveMetadata(): Promise<void> {
    if (!this.metadata) return;

    await ensureDir(this.indexDir);
    const metaPath = path.join(this.indexDir, 'meta.json');
    await safeFs.writeFile(metaPath, JSON.stringify(this.metadata, null, 2));
  }

  /**
   * 构建索引
   */
  async buildIndex(options: {
    paths?: string[];
    languages?: string[];
    force?: boolean;
    onProgress?: (current: number, total: number, file: string) => void;
  } = {}): Promise<IndexBuildResult> {
    const startTime = Date.now();
    const errors: Array<{ file: string; error: string }> = [];

    const {
      paths = this.config.include,
      languages = this.config.languages,
      force = false,
      onProgress,
    } = options;

    await ensureDir(this.indexDir);
    await ensureDir(path.join(this.indexDir, 'files'));

    // 收集要索引的文件
    const filesToIndex: string[] = [];

    for (const pattern of paths) {
      /* audit P1-5: glob 库内部并发不通过我们的 fileLimiter, 包一层 runWithFileLimit
         至少把整次 glob 计 1 槽 — 多 agent 并发调 buildIndex 时不至于全部同时跑 glob 内部 fan-out.
         彻底方案要换 fast-glob + concurrency=8 或自己写顺序 walker, 留 follow-up. */
      const { runWithFileLimit } = await import('../files/fileLimiter.js');
      const files = await runWithFileLimit(() => glob(pattern, {
        cwd: this.workspacePath,
        absolute: true,
        ignore: this.config.exclude,
      }));

      for (const file of files) {
        const lang = getLanguageFromPath(file);
        if (lang && languages.includes(lang)) {
          filesToIndex.push(file);
        }
      }
    }

    let filesIndexed = 0;
    let symbolsFound = 0;

    // 索引每个文件
    for (let i = 0; i < filesToIndex.length; i++) {
      const file = filesToIndex[i];
      onProgress?.(i + 1, filesToIndex.length, file);

      try {
        // 检查是否需要重新索引
        if (!force) {
          const existingIndex = await this.getFileIndex(file);
          if (existingIndex) {
            const stats = await safeFs.stat(file);
            if (existingIndex.mtime >= stats.mtimeMs) {
              // 索引是最新的，跳过
              symbolsFound += existingIndex.symbols.length;
              filesIndexed++;
              continue;
            }
          }
        }

        // 索引文件
        const index = await this.indexFile(file);
        if (index) {
          await this.saveFileIndex(index);
          this.fileIndexCache.set(file, index);
          symbolsFound += index.symbols.length;
          filesIndexed++;
        }
      } catch (error: any) {
        errors.push({ file, error: error.message });
      }
    }

    // 更新元信息
    this.metadata = {
      version: INDEX_VERSION,
      createdAt: this.metadata?.createdAt || Date.now(),
      updatedAt: Date.now(),
      fileCount: filesIndexed,
      symbolCount: symbolsFound,
      languages,
      indexDir: this.config.cacheDir,
    };

    await this.saveMetadata();

    return {
      success: errors.length === 0,
      filesIndexed,
      symbolsFound,
      timeMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * 索引单个文件
   */
  private async indexFile(filePath: string): Promise<FileIndex | null> {
    const lang = getLanguageFromPath(filePath);
    if (!lang) return null;

    const parser = this.parserRegistry.getParser(lang);
    if (!parser) return null;

    try {
      const content = await safeFs.readFile(filePath, 'utf-8');
      const stats = await safeFs.stat(filePath);

      const symbols = await parser.parse(content, filePath);

      // 提取导入和导出
      const imports = this.extractImports(content, lang);
      const exports = this.extractExports(content, lang);

      return {
        path: filePath,
        hash: computeHash(content),
        mtime: stats.mtimeMs,
        totalLines: splitContentLines(content).length,
        symbols,
        imports,
        exports,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 提取导入语句
   */
  private extractImports(content: string, lang: string): FileIndex['imports'] {
    const imports: FileIndex['imports'] = [];
    const lines = splitContentLines(content);

    // TypeScript/JavaScript
    if (['typescript', 'javascript'].includes(lang)) {
      const importRegex = /^import\s+(?:(?:\{([^}]+)\}|(\w+))\s+from\s+)?['"]([^'"]+)['"]/;
      lines.forEach((line, idx) => {
        const match = line.match(importRegex);
        if (match) {
          const names = match[1]?.split(',').map(n => n.trim()) || (match[2] ? [match[2]] : []);
          imports.push({
            module: match[3],
            line: idx + 1,
            names: names.filter(Boolean),
          });
        }
      });
    }

    // Python
    if (lang === 'python') {
      const importRegex = /^(?:from\s+(\S+)\s+import\s+(.+)|import\s+(\S+))/;
      lines.forEach((line, idx) => {
        const match = line.match(importRegex);
        if (match) {
          const module = match[1] || match[3];
          const names = match[2]?.split(',').map(n => n.trim()) || [];
          imports.push({ module, line: idx + 1, names });
        }
      });
    }

    return imports;
  }

  /**
   * 提取导出语句
   */
  private extractExports(content: string, lang: string): FileIndex['exports'] {
    const exports: FileIndex['exports'] = [];
    const lines = splitContentLines(content);

    // TypeScript/JavaScript
    if (['typescript', 'javascript'].includes(lang)) {
      const exportRegex = /^export\s+(?:(default)\s+)?(?:(class|function|const|let|var|interface|type|enum)\s+)?(\w+)?/;
      lines.forEach((line, idx) => {
        const match = line.match(exportRegex);
        if (match) {
          const kind = match[2] as SymbolKind | undefined;
          const name = match[3] || (match[1] ? 'default' : '');
          if (name) {
            exports.push({ name, line: idx + 1, kind });
          }
        }
      });
    }

    return exports;
  }

  /**
   * 获取文件索引
   */
  async getFileIndex(filePath: string): Promise<FileIndex | null> {
    // 检查缓存
    if (this.fileIndexCache.has(filePath)) {
      return this.fileIndexCache.get(filePath)!;
    }

    // 从磁盘加载
    const indexPath = this.getFileIndexPath(filePath);
    try {
      const content = await safeFs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as FileIndex;
      this.fileIndexCache.set(filePath, index);
      return index;
    } catch {
      return null;
    }
  }

  /**
   * 保存文件索引
   */
  private async saveFileIndex(index: FileIndex): Promise<void> {
    const indexPath = this.getFileIndexPath(index.path);
    await ensureDir(path.dirname(indexPath));
    await safeFs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * 获取文件索引路径
   */
  private getFileIndexPath(filePath: string): string {
    const relativePath = path.relative(this.workspacePath, filePath);
    const safeName = relativePath.replace(/[/\\]/g, '_').replace(/\./g, '_');
    return path.join(this.indexDir, 'files', `${safeName}.json`);
  }

  /**
   * 搜索符号
   */
  async searchSymbol(options: {
    query: string;
    kind?: SymbolKind;
    fuzzy?: boolean;
    limit?: number;
  }): Promise<SymbolSearchResult[]> {
    const { query, kind, fuzzy = false, limit = 20 } = options;
    const results: SymbolSearchResult[] = [];

    // 加载所有文件索引
    const filesDir = path.join(this.indexDir, 'files');
    try {
      const files = await safeFs.readdir(filesDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await safeFs.readFile(path.join(filesDir, file), 'utf-8');
          const index = JSON.parse(content) as FileIndex;

          for (const symbol of index.symbols) {
            if (kind && symbol.kind !== kind) continue;

            let score = 0;

            if (fuzzy) {
              score = similarity(query.toLowerCase(), symbol.name.toLowerCase());
              if (score < 0.5) continue;
            } else {
              if (!symbol.name.toLowerCase().includes(query.toLowerCase())) continue;
              score = symbol.name.toLowerCase() === query.toLowerCase() ? 1 : 0.8;
            }

            results.push({
              symbol,
              file: index.path,
              score,
            });

            // 也搜索子符号（如类的方法）
            if (symbol.children) {
              for (const child of symbol.children) {
                if (kind && child.kind !== kind) continue;

                let childScore = 0;
                if (fuzzy) {
                  childScore = similarity(query.toLowerCase(), child.name.toLowerCase());
                  if (childScore < 0.5) continue;
                } else {
                  if (!child.name.toLowerCase().includes(query.toLowerCase())) continue;
                  childScore = child.name.toLowerCase() === query.toLowerCase() ? 1 : 0.8;
                }

                results.push({
                  symbol: { ...child, parent: symbol.name },
                  file: index.path,
                  score: childScore,
                });
              }
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // 索引目录不存在
    }

    // 按分数排序并限制结果
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 使文件索引失效
   */
  async invalidate(filePath: string): Promise<void> {
    this.fileIndexCache.delete(filePath);
    const indexPath = this.getFileIndexPath(filePath);
    try {
      await safeFs.unlink(indexPath);
    } catch {
      // 忽略不存在的文件
    }
  }

  /**
   * 清除所有索引
   */
  async clear(): Promise<void> {
    this.fileIndexCache.clear();
    this.metadata = null;

    try {
      await fs.rm(this.indexDir, { recursive: true, force: true });
    } catch {
      // 忽略错误
    }
  }

  /**
   * 获取索引统计信息
   */
  async getStats(): Promise<{
    hasIndex: boolean;
    fileCount: number;
    symbolCount: number;
    lastUpdated: Date | null;
    size: number;
  }> {
    const meta = await this.loadMetadata();

    if (!meta) {
      return {
        hasIndex: false,
        fileCount: 0,
        symbolCount: 0,
        lastUpdated: null,
        size: 0,
      };
    }

    // 计算索引大小
    let size = 0;
    try {
      const filesDir = path.join(this.indexDir, 'files');
      const files = await safeFs.readdir(filesDir);
      for (const file of files) {
        const stats = await safeFs.stat(path.join(filesDir, file));
        size += stats.size;
      }
    } catch {
      // 忽略错误
    }

    return {
      hasIndex: true,
      fileCount: meta.fileCount,
      symbolCount: meta.symbolCount,
      lastUpdated: new Date(meta.updatedAt),
      size,
    };
  }
}

/**
 * 创建索引管理器
 */
export function createIndexManager(
  workspacePath: string,
  config?: Partial<IndexConfig>
): IndexManager {
  return new IndexManager(workspacePath, config);
}
