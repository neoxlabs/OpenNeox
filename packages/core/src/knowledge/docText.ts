
import fs from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractPdfText } from '../tools/image/imageProcessor.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/* 单文件进索引的文本上限 — BM25 in-memory, 百文件 × 80KB 量级无压力 */
export const MAX_DOC_TEXT_CHARS = 80_000;
/* 抽取缓存条数上限 (LRU) — 千文件规模的内存护栏 (~80MB 最坏)。
 * 超过此规模应切 SQLite FTS5 磁盘索引 (见设计文档 §规模预案)。 */
const CACHE_MAX_ENTRIES = 1000;

const PLAIN_TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'log', 'yaml', 'yml']);
const HTML_EXTS = new Set(['html', 'htm']);

const cache = new Map<string, { mtimeMs: number; text: string }>();

/** documentParseClient 解析缓存位置 — 必须与 documentCacheHandlers/readDocumentTool 一致 */
function parsedCachePath(fileId: string): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents', `${fileId}.md`);
}

export class DocumentTextExtractionError extends Error {
  constructor(public readonly filePath: string, reason: string) {
    super(`${path.basename(filePath)}: ${reason}`);
    this.name = 'DocumentTextExtractionError';
  }
}

/**
 * 抽取文档文本。成功返回文本 ('' = 文件确实没有可抽的文本层);
 * 失败抛 DocumentTextExtractionError, 且**不缓存**, 下次调用会重试。
 */
export async function extractDocumentText(
  filePath: string,
  mtimeMs: number,
  fileId?: string,
): Promise<string> {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    /* LRU touch */
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.text;
  }

  let text = '';
  try {
    /* 1. 解析缓存优先 (docx/xlsx/pdf 导入时解析出的 markdown — 全格式统一文本源) */
    if (fileId && /^[a-f0-9]{64}$/.test(fileId)) {
      try {
        text = await fs.readFile(parsedCachePath(fileId), 'utf-8');
      } catch { /* 缓存缺失 (被清理) — 走本地抽取 */ }
    }
    /* 2. 本地抽取 */
    if (!text) {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (ext === 'pdf') {
        const result = await extractPdfText(filePath, {});
        if (!result.valid) {
          throw new DocumentTextExtractionError(filePath, result.error || 'PDF text extraction failed');
        }
        if (result.hasTextLayer) text = result.text;
      } else if (PLAIN_TEXT_EXTS.has(ext)) {
        text = await fs.readFile(filePath, 'utf-8');
      } else if (HTML_EXTS.has(ext)) {
        text = (await fs.readFile(filePath, 'utf-8'))
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ');
      }
      /* docx/xlsx 无 fileId 且本地无解析器 → 只按文件名可搜 (这是"没有", 不是失败) */
    }
  } catch (err: any) {
    if (err instanceof DocumentTextExtractionError) throw err;
    throw new DocumentTextExtractionError(filePath, err?.message || String(err));
  }

  if (text.length > MAX_DOC_TEXT_CHARS) text = text.slice(0, MAX_DOC_TEXT_CHARS);
  cache.set(filePath, { mtimeMs, text });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return text;
}

/** 测试用 */
export function __clearDocTextCache(): void {
  cache.clear();
}
