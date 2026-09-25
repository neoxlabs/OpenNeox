/**
 * readfile Tools - 工具定义
 *
 * 提供以下工具:
 * - readfile: 智能文件读取
 * - build_index: 构建代码索引
 * - search_symbol: 搜索符号
 * - get_definitions: 查找符号定义
 * - get_references: 查找符号引用
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { Tool } from '@neoxlabs/kernel/types/index.js';
import { isImageFile, isPdfFile, readImageFile, readPdfAsImages, extractPdfText, buildImageToolResult, parseImageResultImages } from '../image/index.js';
import { recordRead } from './readLedger.js';
import { estimateTokens } from '@neoxlabs/kernel';
import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
/* 失败要贴尾标, 否则时间线只能"没抛就算成功" —— 读失败照样打绿勾 (见 toolResult.ts) */
import { markToolFailure as fail, createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { SmartReader, createSmartReader } from './smartReader.js';
import { IndexManager, createIndexManager } from './indexManager.js';
import {
  Locator,
  SymbolKind,
  ReadResult,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_FULL_READ_THRESHOLD,
  MAX_CHUNK_SIZE
} from './types.js';
import { formatLinesWithNumbers, sanitizeForJson, splitContentLines } from './utils.js';

// 全局实例缓存
let smartReaderInstance: SmartReader | null = null;
let indexManagerInstance: IndexManager | null = null;
let currentWorkspacePath: string | null = null;

// 文件大小阈值配置
const FILE_SIZE_THRESHOLDS = {
  /** 小文件阈值 (行数)，小于此值默认 full */
  small: DEFAULT_FULL_READ_THRESHOLD,
  /** 大文件阈值 (行数)，大于此值优先用 index/symbol */
  large: 1000,
};
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const WHOLE_FILE_MAX_TOKENS = 25000;
/** paths=[...] 一次调用合计的 token 预算; 达到后剩下的文件不读, 让模型另发一次。 */
const MULTI_READ_MAX_TOKENS = 40000;
const DEFAULT_EDIT_CHUNK_SIZE = 120;
const MIN_AUTO_CHUNK_SIZE = 20;
const MAX_AUTO_READ_ATTEMPTS = 3;
const DEFAULT_MATCH_PREVIEW_LIMIT = 200;
const DEFAULT_MATCH_PREVIEW_CHARS = 200;

function indexNotBuilt(tool: string): string {
  return JSON.stringify(createContextualResult(
    tool,
    'error',
    'Symbol index not built yet',
    'Run build_index() first, then call this tool again:\n'
    + '  build_index()                        → index the whole project\n'
    + '  build_index(paths=["src/**/*.ts"])   → index only the given paths',
    { error: 'index_not_built', precondition: true },
  ));
}

/**
 * 获取或创建 SmartReader 实例
 */
function getSmartReader(workspacePath: string): SmartReader {
  if (!smartReaderInstance || currentWorkspacePath !== workspacePath) {
    smartReaderInstance = createSmartReader(workspacePath);
    currentWorkspacePath = workspacePath;

    // 如果有索引管理器，绑定到 reader
    if (indexManagerInstance) {
      smartReaderInstance.setIndexManager(indexManagerInstance);
    }
  }
  return smartReaderInstance;
}

/**
 * 获取或创建 IndexManager 实例
 */
function getIndexManager(workspacePath: string): IndexManager {
  if (!indexManagerInstance || currentWorkspacePath !== workspacePath) {
    indexManagerInstance = createIndexManager(workspacePath);
    currentWorkspacePath = workspacePath;

    // 如果有 reader，绑定索引管理器
    if (smartReaderInstance) {
      smartReaderInstance.setIndexManager(indexManagerInstance);
    }
  }
  return indexManagerInstance;
}

/**
 * 解析工作区路径
 */
function resolveWorkspacePath(filePath: string): string {
  // 获取工作区路径（假设当前工作目录）
  return process.cwd();
}

/**
 * 格式化显示路径
 */
function formatDisplayPath(absPath: string): string {
  const workspacePath = resolveWorkspacePath('');
  return path.relative(workspacePath, absPath) || absPath;
}

/** 把各种定位方式归一成一个可比的范围指纹 —— 决定"是不是同一段读"。宁可漏命中不可错命中。 */
function computeRangeKey(args: Record<string, any>): string {
  if (args.read_all === true) return 'FULL';
  if (args.start_line) return `L:${args.start_line}-${args.end_line ?? (args.start_line + (args.num_lines ?? 0))}`;
  if (args.symbol || args.function || args.class) return `SYM:${args.symbol || args.function || args.class}:${args.symbol_kind || ''}`;
  if (args.pattern) return `PAT:${args.pattern}:${args.match_index ?? 1}`;
  if (Array.isArray(args.ranges) && args.ranges.length) return 'R:' + args.ranges.map((r: any) => `${r.start}-${r.end ?? ''}`).sort().join(',');
  if (args.range_start && args.range_end) return `RG:${args.range_start}..${args.range_end}`;
  return 'FULL';
}

/** formatLinesWithNumbers 的确定性逆运算 (格式: `<padStart(6)> │ <line>`), 拿回无行号原文。 */
function stripLineNumbers(numbered: string): string {
  return numbered.split('\n').map((l) => l.replace(/^ *\d+ │ /, '')).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 索引状态信息
 */
export interface IndexStatusInfo {
  hasIndex: boolean;
  fileCount: number;
  symbolCount: number;
  lastUpdated: Date | null;
}

/**
 * 获取索引状态（用于动态 prompt）
 */
export async function getIndexStatus(workspacePath?: string): Promise<IndexStatusInfo> {
  const workspace = workspacePath || process.cwd();
  const indexManager = getIndexManager(workspace);
  const stats = await indexManager.getStats();
  return {
    hasIndex: stats.hasIndex,
    fileCount: stats.fileCount,
    symbolCount: stats.symbolCount,
    lastUpdated: stats.lastUpdated,
  };
}

/**
 * 生成动态的 readfile 策略提示
 * 根据索引状态生成不同的使用建议
 */
export async function getSmartReadStrategyHint(workspacePath?: string): Promise<string> {
  const status = await getIndexStatus(workspacePath);

  if (!status.hasIndex) {
    return `
📖 readfile 策略提示:
- 索引未构建，使用 pattern/grep 定位
- 小文件 (≤${FILE_SIZE_THRESHOLDS.small}行): 默认 full 读取
- 大文件: 先用 pattern/list_matches 定位，再用 anchor_lines/ranges 批量读取
- 💡 运行 build_index() 可以启用符号定位功能`;
  }

  return `
📖 readfile 策略提示 (索引已启用, ${status.symbolCount} 符号):
- 小文件 (≤${FILE_SIZE_THRESHOLDS.small}行): 默认 full 读取
- 大文件 (>${FILE_SIZE_THRESHOLDS.large}行): 优先用 symbol/function/class 定位
  ✓ readfile(path="big.ts", function="handleClick") - 精准定位函数
  ✓ readfile(path="big.ts", class="UserService") - 精准定位类
- 中等文件: pattern 和 symbol 均可，按需选择`;
}

/**
 * 获取完整的动态系统提示（供 runner 使用）
 */
export async function getSmartReadDynamicPrompt(workspacePath?: string): Promise<string> {
  const status = await getIndexStatus(workspacePath);
  const hint = await getSmartReadStrategyHint(workspacePath);

  const lines: string[] = [
    '## readfile 文件读取策略',
    '',
  ];

  if (status.hasIndex) {
    lines.push(`✅ 代码索引已启用 (${status.fileCount} 文件, ${status.symbolCount} 符号)`);
    lines.push('');
    lines.push('### 按文件大小选择策略:');
    lines.push('');
    lines.push(`| 文件大小 | 推荐策略 | 示例 |`);
    lines.push(`|---------|---------|------|`);
    lines.push(`| ≤${FILE_SIZE_THRESHOLDS.small}行 | full 自动读取 | \`readfile(path)\` |`);
    lines.push(`| ${FILE_SIZE_THRESHOLDS.small}-${FILE_SIZE_THRESHOLDS.large}行 | 均可 | 按需选择 |`);
    lines.push(`| >${FILE_SIZE_THRESHOLDS.large}行 | **symbol/function** | \`readfile(path, function="xxx")\` |`);
  } else {
    lines.push('⚠️ 代码索引未构建');
    lines.push('');
    lines.push('当前可用策略:');
    lines.push('- `start_line`: 按行号读取');
    lines.push('- `pattern`: 正则匹配定位（可配合 list_matches）');
    lines.push('- `range_start/end`: 范围读取');
    lines.push('');
    lines.push('💡 运行 `build_index()` 启用符号定位功能');
  }

  return lines.join('\n');
}

/**
 * 创建智能读取工具集
 */
export function createSmartReadTools(workspacePath?: string): Tool[] {
  const getWorkspace = () => workspacePath || process.cwd();

  // ============================================
  // 工具 1: readfile - 智能文件读取
  // ============================================
  const smartRead: Tool = {
    name: 'readfile',
    /* D wire: readfile 是短任务, 60s 足够覆盖大文件 / 慢盘 / mounted 网盘.
     *  避免 30min 全局 default 让 readfile 撞了网盘卡死时陪 30min. */
    timeoutMs: 60_000,
    // 动态并发安全判定:小读安全并发, 大读避免并发 OOM
    isConcurrencySafe: (args: Record<string, any>) => {
      if (args?.read_all === true) return false; // 整文件读不并发
      const numLines = Number(args?.num_lines ?? 0);
      const endLine = Number(args?.end_line ?? 0);
      const startLine = Number(args?.start_line ?? 0);
      const implicitRange = endLine - startLine;
      // 任意维度 > 5000 行视为大读, 保守串行
      if (numLines > 5000) return false;
      if (implicitRange > 5000) return false;
      // ranges 数组里任一区间过大 → 串行
      if (Array.isArray(args?.ranges)) {
        for (const r of args.ranges) {
          const span = Number(r?.end ?? 0) - Number(r?.start ?? 0);
          if (span > 5000) return false;
        }
      }
      return true;
    },
    description: `Read file. Defaults to ${DEFAULT_CHUNK_SIZE} lines, auto-full at ≤${DEFAULT_FULL_READ_THRESHOLD} lines, max 4000. Images become visual content; PDFs extract the text layer first (page via pages), scans fall back to rendered images.

Need several files? Pass paths=["a.ts","b.ts",...] in ONE call (up to 8) instead of one readfile per file — same options apply to each.

Read before you edit — edit locates text by old_string (copied verbatim from the file), not by line number. A whole-file read (no start_line/num_lines) returns the entire file up to ~25k tokens, so prefer one whole-file read over many small ranges. Every re-read resends the full content and costs a round trip — don't re-read what is already in your context.

Also accepted (no need to prefer them): end_line, pattern (regex jump), for_edit.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (required unless paths is given)',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Read several files in one call (up to 8). Prefer this over issuing one readfile per file.',
        },
        start_line: {
          type: 'number',
          description: 'Start line number (1-indexed)',
        },
        num_lines: {
          type: 'number',
          description: `Number of lines to read (default: ${DEFAULT_CHUNK_SIZE})`,
        },
        read_all: {
          type: 'boolean',
          description: 'Read the whole file at once (good for small files such as SKILL.md)',
        },
        force: {
          type: 'boolean',
          description: 'Legacy flag, no effect — reads always return the content.',
        },
        pages: {
          type: 'string',
          description: 'PDF only — page range, e.g. "1-5". Up to 60 pages per call.',
        },
      },
      required: [],
    },
    async function(args, toolCtx) {
      const multi = Array.isArray(args?.paths)
        ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (multi.length > 0) {
        const sections: string[] = [];
        const skipped: string[] = [];
        const images: Array<{ base64: string; mediaType: string; label?: string }> = [];
        let usedTokens = 0;
        for (const p of multi.slice(0, 8)) {
          if (sections.length > 0 && usedTokens >= MULTI_READ_MAX_TOKENS) {
            skipped.push(p);
            continue;
          }
          const one = await smartRead.function({ ...args, paths: undefined, path: p }, toolCtx);
          const text = typeof one === 'string' ? one : JSON.stringify(one);
          const imgs = parseImageResultImages(text);
          if (imgs) {
            images.push(...imgs);
            sections.push(`══════ ${p} ══════\n(${imgs.length} image(s), attached)`);
            continue;
          }
          usedTokens += estimateTokens(text);
          sections.push(`══════ ${p} ══════\n${text}`);
        }
        if (skipped.length > 0) {
          sections.push(`(Not read — this call already returned ~${Math.round(usedTokens / 1000)}k tokens. Read these in another call: ${skipped.join(', ')})`);
        }
        if (multi.length > 8) sections.push(`(还有 ${multi.length - 8} 个文件没读 —— 一次最多 8 个, 再发一次)`);
        if (images.length > 0) return buildImageToolResult(images, sections.join('\n\n'));
        return sections.join('\n\n');
      }
      const {
        path: pathArg,
        file_path: filePathSnake,
        filePath: filePathCamel,
        file: filePathAlias,
        start_line,
        end_line,
        num_lines,
        symbol,
        symbol_kind,
        class_name,
        function: funcName,
        class: className,
        pattern,
        match_index,
        list_matches,
        range_start,
        range_end,
        ranges,
        anchor_lines,
        context,
        use_index = true,
        for_edit,
        include_raw,
        max_output_chars,
        read_all,
        force,
      } = args;
      const filePath = [pathArg, filePathSnake, filePathCamel, filePathAlias]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

      if (!filePath) {
        return fail('✗ 缺少 path 参数（支持: path / file_path / filePath / file）');
      }

      const resolvedForCheck = path.isAbsolute(filePath) ? filePath : path.resolve(getWorkspace(), filePath);
      if (isImageFile(resolvedForCheck) && path.extname(resolvedForCheck).toLowerCase() !== '.svg') {
        try {
          const imageResult = await readImageFile(resolvedForCheck);
          const sizeKB = (imageResult.rawSize / 1024).toFixed(1);
          const label = `${path.basename(resolvedForCheck)} (${sizeKB}KB, ${imageResult.mediaType}${imageResult.wasResized ? ', resized' : ''})`;
          return buildImageToolResult([{
            base64: imageResult.base64,
            mediaType: imageResult.mediaType,
            label,
          }]);
        } catch (err: any) {
          return fail(`✗ 无法读取图片: ${err.message}`);
        }
      }

      if (isPdfFile(resolvedForCheck)) {
        const pages = args.pages as string | undefined;
        if (args.as_images !== true) {
          try {
            const textResult = await extractPdfText(resolvedForCheck, { pages });
            if (textResult.pageRangeOutOfBounds) {
              return `[PDF] ${path.basename(resolvedForCheck)} · ${textResult.error}`;
            }
            if (textResult.valid && textResult.hasTextLayer) {
              const maxChars = typeof max_output_chars === 'number' && max_output_chars > 0
                ? Math.floor(max_output_chars)
                : DEFAULT_MAX_OUTPUT_CHARS;
              let body = textResult.text;
              let truncNote = '';
              if (body.length > maxChars) {
                body = body.slice(0, maxChars);
                truncNote = `\n\n… (本段已按 max_output_chars=${maxChars} 截断, 用 pages 参数缩小范围继续读)`;
              }
              const moreNote = textResult.lastPage < textResult.totalPages
                ? ` · 还有 ${textResult.totalPages - textResult.lastPage} 页未读 (用 pages="${textResult.lastPage + 1}-…" 继续)`
                : '';
              return `[PDF 文本层] ${path.basename(resolvedForCheck)} · 共 ${textResult.totalPages} 页 · 本次第 ${textResult.firstPage}-${textResult.lastPage} 页${moreNote}\n\n${body}${truncNote}`;
            }
            /* 无文本层 (扫描版/纯图) 或 pdftotext 不可用 → 落到图片通道 */
          } catch {
            /* 文本通道异常不阻塞 — 落到图片通道 */
          }
        }
        try {
          const pdfResult = await readPdfAsImages(resolvedForCheck, { pages });
          if (pdfResult.pageRangeOutOfBounds) {
            return `[PDF] ${path.basename(resolvedForCheck)} · ${pdfResult.error}`;
          }
          if (!pdfResult.valid) {
            return fail(`✗ PDF 读取失败: ${pdfResult.error}`);
          }
          if (pdfResult.pages.length === 0) {
            return fail(`✗ PDF 无可读取的页面`);
          }
          return buildImageToolResult(
            pdfResult.pages.map(p => ({
              base64: p.base64,
              mediaType: p.mediaType,
              label: `${path.basename(resolvedForCheck)} — Page ${p.pageNumber}/${pdfResult.totalPages}`,
            })),
          );
        } catch (err: any) {
          return fail(`✗ PDF 处理失败: ${err.message}`);
        }
      }

      const workspace = getWorkspace();
      const reader = getSmartReader(workspace);

      const forEdit = for_edit === true;
      const includeRaw = forEdit && include_raw === true;
      const contextLines = typeof context === 'number' ? Math.max(0, context) : DEFAULT_CONTEXT_LINES;
      const maxOutputChars = typeof max_output_chars === 'number' && max_output_chars > 0
        ? Math.floor(max_output_chars)
        : DEFAULT_MAX_OUTPUT_CHARS;

      let effectiveChunkSize = read_all
        ? MAX_CHUNK_SIZE
        : (num_lines || (forEdit ? DEFAULT_EDIT_CHUNK_SIZE : DEFAULT_CHUNK_SIZE));
      effectiveChunkSize = Math.min(effectiveChunkSize, MAX_CHUNK_SIZE);
      if (!num_lines && pattern) {
        effectiveChunkSize = Math.max(MIN_AUTO_CHUNK_SIZE, contextLines * 2 + 1);
      }

      const hasRangeReads = Array.isArray(ranges) && ranges.length > 0;
      const hasAnchorReads = Array.isArray(anchor_lines) && anchor_lines.length > 0;
      const wantsMatchList = list_matches === true;

      if (forEdit && (hasRangeReads || hasAnchorReads || wantsMatchList)) {
        return fail('✗ for_edit=true 暂不支持 list_matches / ranges / anchor_lines，请使用单次 readfile 获取可编辑片段。');
      }

      const resolveReadPath = (): string => {
        if (path.isAbsolute(filePath)) return filePath;
        return path.resolve(workspace, filePath);
      };

      const loadFileLines = async (): Promise<{ absPath: string; lines: string[]; totalLines: number; rawContent: string }> => {
        const absPath = resolveReadPath();
        // When readfile is called immediately after write_file, the filesystem
        // directory entry cache may not have been flushed yet
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const rawContent = await fs.readFile(absPath, 'utf-8');
            const sanitized = sanitizeForJson(rawContent);
            const lines = splitContentLines(sanitized);
            return { absPath, lines, totalLines: lines.length, rawContent };
          } catch (err: any) {
            if (err.code === 'ENOENT' && attempt < 2) {
              await new Promise(r => setTimeout(r, 50)); // wait 50ms for fs sync
              continue;
            }
            throw err;
          }
        }
        throw new Error(`File not found after retries: ${absPath}`);
      };

      const normalizeRange = (start: number, end: number | undefined, totalLines: number): { start: number; end: number } => {
        const safeStart = Math.max(1, Math.floor(start));
        const resolvedEnd = typeof end === 'number' ? Math.floor(end) : safeStart + effectiveChunkSize - 1;
        const safeEnd = Math.min(totalLines, Math.max(resolvedEnd, safeStart));
        return { start: safeStart, end: safeEnd };
      };

      const mergeRanges = (input: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> => {
        const sorted = input
          .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
          .sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const range of sorted) {
          const last = merged[merged.length - 1];
          if (!last || range.start > last.end + 1) {
            merged.push({ ...range });
          } else {
            last.end = Math.max(last.end, range.end);
          }
        }
        return merged;
      };

      if (wantsMatchList) {
        if (!pattern) {
          return fail('✗ list_matches 需要配合 pattern 使用');
        }

        try {
          const { absPath, lines, totalLines } = await loadFileLines();
          let regex: RegExp;
          try {
            regex = new RegExp(pattern, 'gi');
          } catch (e: any) {
            return fail(`✗ 无效的正则表达式: ${e.message}`);
          }

          const matches: Array<{ line: number; text: string }> = [];
          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              matches.push({ line: idx + 1, text: line });
            }
            regex.lastIndex = 0;
          });

          const displayPath = formatDisplayPath(absPath);
          if (matches.length === 0) {
            const preview = formatLinesWithNumbers(lines.slice(0, Math.min(50, totalLines)), 1);
            return [
              `✓ 文件: ${displayPath}`,
              `总行数: ${totalLines} | 匹配: 0`,
              `策略: grep-list`,
              '',
              `未找到匹配: "${pattern}"`,
              '',
              '--- 内容（带行号，便于阅读）---',
              preview,
            ].join('\n');
          }

          const approxLineLen = DEFAULT_MATCH_PREVIEW_CHARS + 12;
          const maxPreviewLines = Math.max(
            5,
            Math.min(DEFAULT_MATCH_PREVIEW_LIMIT, Math.floor(maxOutputChars / approxLineLen))
          );
          const previewMatches = matches.slice(0, maxPreviewLines);
          const previewLines = previewMatches.map(match => {
            const trimmed = match.text.length > DEFAULT_MATCH_PREVIEW_CHARS
              ? `${match.text.slice(0, DEFAULT_MATCH_PREVIEW_CHARS)}...`
              : match.text;
            return `${String(match.line).padStart(6)} │ ${trimmed}`;
          });

          const output: string[] = [
            `✓ 文件: ${displayPath}`,
            `总行数: ${totalLines} | 匹配: ${matches.length}`,
            `策略: grep-list`,
            '',
            `--- 匹配摘要（前 ${previewLines.length}/${matches.length}）---`,
            ...previewLines,
          ];

          if (previewLines.length < matches.length) {
            output.push('', `⚠️ 摘要已截断，调整 max_output_chars 或缩小 pattern`);
          }

          const sampleAnchors = previewMatches.slice(0, 5).map(m => m.line).join(', ');
          output.push(
            '',
            `💡 读取匹配附近: readfile(path="${displayPath}", anchor_lines=[${sampleAnchors}], num_lines=${Math.min(200, effectiveChunkSize)})`
          );

          return output.join('\n');
        } catch (error: any) {
          return fail(`✗ 读取失败: ${error.message}`);
        }
      }

      if (hasRangeReads || hasAnchorReads) {
        try {
          const { absPath, lines, totalLines, rawContent } = await loadFileLines();

          const rangesToRead: Array<{ start: number; end: number }> = [];

          if (hasRangeReads) {
            for (const range of ranges as Array<{ start: number; end?: number }>) {
              if (!range || typeof range.start !== 'number') continue;
              rangesToRead.push(normalizeRange(range.start, range.end, totalLines));
            }
          } else if (hasAnchorReads) {
            const anchorSpan = Math.max(1, num_lines || (contextLines * 2 + 1));
            for (const anchor of anchor_lines as number[]) {
              if (typeof anchor !== 'number' || Number.isNaN(anchor)) continue;
              const start = Math.max(1, Math.floor(anchor - Math.floor(anchorSpan / 2)));
              const end = Math.min(totalLines, start + anchorSpan - 1);
              rangesToRead.push({ start, end });
            }
          }

          if (rangesToRead.length === 0) {
            return fail('✗ ranges/anchor_lines 为空，无法读取');
          }

          const mergedRanges = mergeRanges(rangesToRead);
          const displayPath = formatDisplayPath(absPath);

          /* 版本戳: 每个区块按 `R:start-end` 记进读账本 —— 让 grep → readfile(anchor_lines) → edit
           *   这条链闭合: edit 按行号编辑时能从账本切出该区块当 old_string; 重读同区块也能去重。 */
          let statInfo: { mtimeMs: number; size: number } | undefined;
          try {
            const st = await fs.stat(absPath);
            statInfo = { mtimeMs: st.mtimeMs, size: st.size };
          } catch { /* stat 失败不阻断读取 */ }

          const output: string[] = [
            `✓ 文件: ${displayPath}`,
            `总行数: ${totalLines} | 区块: ${mergedRanges.length}`,
            `策略: batch-range`,
            '',
            '--- 内容（带行号，便于阅读）---',
          ];

          let outputSize = output.join('\n').length;
          let displayed = 0;
          for (const [idx, range] of mergedRanges.entries()) {
            const rangeLines = lines.slice(range.start - 1, range.end);
            const chunk = formatLinesWithNumbers(rangeLines, range.start);
            const header = `# 区块 ${idx + 1}: ${range.start}-${range.end}`;
            const segment = `${header}\n${chunk}`;
            if (outputSize + segment.length + 2 > maxOutputChars && displayed > 0) {
              break;
            }
            output.push(segment, '');
            outputSize += segment.length + 2;
            displayed += 1;
            // 只登记真展示给模型的区块 (内容是无行号原文, edit 桥接用)。
            if (statInfo) {
              recordRead(absPath, {
                rangeKey: `R:${range.start}-${range.end}`,
                content: rangeLines.join('\n'),
                startLine: range.start,
                lineCount: range.end - range.start + 1,
                mtimeMs: statInfo.mtimeMs,
                sizeBytes: statInfo.size,
                readAtTurn: 0,
              });
            }
          }

          if (displayed < mergedRanges.length) {
            output.push(`⚠️ 输出已截断，仅显示前 ${displayed} 个区块`);
          }

          return output.join('\n').trimEnd();
        } catch (error: any) {
          return fail(`✗ 读取失败: ${error.message}`);
        }
      }

      // 构建定位器
      let locator: Locator | undefined;

      if (start_line) {
        // 行定位
        locator = {
          type: 'line',
          start: start_line,
          end: end_line,
        };
      } else if (funcName) {
        // 函数快捷方式
        locator = {
          type: 'function',
          name: funcName,
          className: class_name,
        };
      } else if (className) {
        // 类快捷方式
        locator = {
          type: 'class',
          name: className,
        };
      } else if (symbol) {
        // 符号定位
        locator = {
          type: 'symbol',
          name: symbol,
          kind: symbol_kind as SymbolKind,
        };
      } else if (pattern) {
        // 模式定位
        locator = {
          type: 'pattern',
          regex: pattern,
          matchIndex: match_index,
          context: contextLines,
        };
      } else if (range_start && range_end) {
        // 范围定位
        locator = {
          type: 'range',
          startPattern: range_start,
          endPattern: range_end,
        };
      }

      const formatOutput = (result: ReadResult): string => {
        const displayPath = formatDisplayPath(result.path);
        const lines: string[] = [
          `✓ 文件: ${displayPath}`,
          `总行数: ${result.totalLines} | 显示: 第 ${result.startLine}-${result.endLine} 行`,
          `策略: ${result.strategy}${result.metadata?.matchedLine ? ` | 匹配行: ${result.metadata.matchedLine}` : ''}`,
        ];

        if (result.metadata?.symbol) {
          lines.push(`符号: ${result.metadata.symbol.name} (${result.metadata.symbol.kind})`);
        }

        if (result.truncated) {
          lines.push('');
          if (result.totalLines <= 500) {
            lines.push(`💡 此文件仅 ${result.totalLines} 行，建议使用 readfile(path="${displayPath}", read_all=true) 一次读完，避免分段读取`);
          } else if (result.totalLines <= DEFAULT_FULL_READ_THRESHOLD) {
            lines.push(`ℹ️ 文件共 ${result.totalLines} 行（≤${DEFAULT_FULL_READ_THRESHOLD}行），如需完整内容可用 read_all=true 一次读完`);
          } else {
            lines.push(`ℹ️ 文件共 ${result.totalLines} 行，当前显示到第 ${result.endLine} 行。如需更多内容可用 start_line=${result.endLine + 1} 继续，或用 pattern 定位关键代码`);
          }
        } else if (result.strategy === 'chunk' && result.totalLines <= 500 && result.endLine < result.totalLines) {
          // 没有 truncated 但是 chunk 策略 + 小文件 — 提示可以 full read
          lines.push('');
          lines.push(`💡 此文件较小（${result.totalLines} 行），可用 readfile(path="${displayPath}", read_all=true) 一次读完`);
        }

        lines.push('');
        lines.push('--- 内容（带行号，便于阅读）---');
        lines.push(result.content);

        return lines.join('\n');
      };

      /* ── 读去重短路: 同范围 + mtime + size 未变 → 不重发全文, 一句 stub 省 token。
       *   stat 一次 (免读) 就能判, 不为校验而重读。命中就直接返回。 ── */
      const rangeKey = computeRangeKey(args);
      let statInfo: { mtimeMs: number; size: number } | undefined;
      try {
        const st = await fs.stat(resolvedForCheck);
        // 目录 / 空文件安全模式: 直接给准确信号, 别让模型对空文件幻觉内容、或把目录当文件读。
        if (st.isDirectory()) {
          return `[readfile] ${formatDisplayPath(resolvedForCheck)} 是目录, 不是文件。用 show_tree / list_directory 看目录, 或 search_files 找文件。`;
        }
        if (st.size === 0) {
          return `[readfile] ${formatDisplayPath(resolvedForCheck)} 是空文件 (0 字节, 无内容可读)。若你刚创建它, 用 write_file 写入内容。`;
        }
        statInfo = { mtimeMs: st.mtimeMs, size: st.size };
      } catch { /* stat 失败 (文件不存在等) → 交给下面正常读路径, 由它报准确错误 */ }

      /* 整文件读按 token 预算给全 (见 WHOLE_FILE_MAX_TOKENS); 带范围的读、显式 max_output_chars 照旧按字符 */
      const wholeFileRead = !(typeof max_output_chars === 'number' && max_output_chars > 0)
        && (read_all === true || (!locator && !num_lines));
      const overBudget = (out: string): boolean => (wholeFileRead
        ? estimateTokens(out) > WHOLE_FILE_MAX_TOKENS
        : out.length > maxOutputChars);
      const budgetRatio = (out: string): number => (wholeFileRead
        ? WHOLE_FILE_MAX_TOKENS / Math.max(1, estimateTokens(out))
        : maxOutputChars / Math.max(1, out.length));

      let attempt = 0;
      let lastOutput = '';
      let allowAutoFull = !num_lines;

      while (true) {
        const result = await reader.read({
          path: filePath,
          locator,
          mode: 'smart',
          autoFullThreshold: allowAutoFull ? DEFAULT_FULL_READ_THRESHOLD : undefined,
          chunkSize: effectiveChunkSize,
          expandContext: contextLines,
          useIndex: use_index,
        });

        if (!result.success) {
          return fail(`✗ 读取失败: ${result.error}\n\n💡 提示:\n- 检查文件路径是否正确\n- 使用 search_files 查找文件`);
        }

        const commitRead = (): void => {
          if (!statInfo) return;
          const raw = result.raw ?? stripLineNumbers(result.content);
          const deliveredWhole = result.startLine <= 1 && result.endLine >= result.totalLines;
          recordRead(resolvedForCheck, {
            rangeKey: rangeKey === 'FULL' && !deliveredWhole ? `L:${result.startLine}-${result.endLine}` : rangeKey,
            content: raw,
            startLine: result.startLine,
            lineCount: Math.max(1, result.endLine - result.startLine + 1),
            mtimeMs: statInfo.mtimeMs,
            sizeBytes: statInfo.size,
            readAtTurn: 0,
          });
        };

        lastOutput = formatOutput(result);
        if (!locator && result.totalLines > DEFAULT_FULL_READ_THRESHOLD && result.strategy === 'chunk') {
          lastOutput += `\n\n💡 此文件较大（${result.totalLines} 行），建议:\n- 使用 pattern/list_matches 定位关键代码，再用 anchor_lines/ranges 批量读取\n- 或指定 start_line/num_lines 精准读取\n- 不要逐段通读整个文件`;
        }

        if (allowAutoFull && result.strategy === 'full' && overBudget(lastOutput)) {
          allowAutoFull = false;
          const shrinkRatio = Math.max(0.1, Math.min(0.9, budgetRatio(lastOutput)));
          effectiveChunkSize = Math.max(MIN_AUTO_CHUNK_SIZE, Math.floor(effectiveChunkSize * shrinkRatio));
          attempt += 1;
          continue;
        }

        if (num_lines || !overBudget(lastOutput)) {
          commitRead();
          return lastOutput;
        }

        if (attempt >= MAX_AUTO_READ_ATTEMPTS || effectiveChunkSize <= MIN_AUTO_CHUNK_SIZE) {
          commitRead();
          return lastOutput;
        }

        const shrinkRatio = Math.max(0.1, Math.min(0.9, budgetRatio(lastOutput)));
        const nextChunkSize = Math.max(MIN_AUTO_CHUNK_SIZE, Math.floor(effectiveChunkSize * shrinkRatio));
        if (nextChunkSize >= effectiveChunkSize) {
          commitRead();
          return lastOutput;
        }

        effectiveChunkSize = nextChunkSize;
        attempt += 1;
      }
    },
  };

  // ============================================
  // 工具 2: build_index - 构建代码索引
  // ============================================
  const buildIndex: Tool = {
    name: 'build_index',
    description: `[Build code index] Build an AST index for the project to speed up code navigation.

Features:
- Parses TypeScript/JavaScript/Python code structure
- Extracts functions, classes, interfaces and type definitions
- Incremental updates (only changed files are re-indexed)
- Persisted under .neox/index/

Usage:
build_index()                          → index the current project
build_index(force=true)                → force a full rebuild
build_index(paths=["src/**/*.ts"])     → index only the given paths

Once indexed:
- readfile locates symbols faster and more accurately
- search_symbol can search symbols quickly`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Path patterns to index (default: every code file in the project)',
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Languages to index (default: typescript, javascript, python)',
        },
        force: {
          type: 'boolean',
          description: 'Force a full rebuild of the index (ignores the cache)',
        },
      },
    },
    async function(args) {
      const { paths, languages, force = false } = args;

      const workspace = getWorkspace();
      const indexManager = getIndexManager(workspace);

      // 构建索引
      const result = await indexManager.buildIndex({
        paths,
        languages,
        force,
        onProgress: (current, total, file) => {
          // 进度回调 (可以用于 UI 显示)
        },
      });

      // 格式化输出
      const lines: string[] = [
        result.success ? '✓ 索引构建完成' : '⚠️ 索引构建完成 (有错误)',
        '',
        `📊 统计:`,
        `  文件数: ${result.filesIndexed}`,
        `  符号数: ${result.symbolsFound}`,
        `  耗时: ${(result.timeMs / 1000).toFixed(2)}s`,
      ];

      if (result.errors.length > 0) {
        lines.push('');
        lines.push('❌ 错误:');
        for (const err of result.errors.slice(0, 5)) {
          lines.push(`  ${formatDisplayPath(err.file)}: ${err.error}`);
        }
        if (result.errors.length > 5) {
          lines.push(`  ... 还有 ${result.errors.length - 5} 个错误`);
        }
      }

      lines.push('');
      lines.push('💡 现在可以使用 readfile 的符号定位功能，或使用 search_symbol 搜索符号');

      return lines.join('\n');
    },
  };

  // ============================================
  // 工具 3: search_symbol - 搜索符号
  // ============================================
  const searchSymbol: Tool = {
    name: 'search_symbol',
    description: `[Search symbols] Search the index for functions, classes, interfaces and other symbols.

⚠️ Run build_index first.

Usage:
search_symbol(query="User")                     → symbols containing "User"
search_symbol(query="handle", kind="function")  → functions only
search_symbol(query="Service", kind="class")    → classes only
search_symbol(query="usr", fuzzy=true)          → fuzzy search

Returns:
- symbol name and kind
- file and line number
- ready to pass straight to readfile`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword',
        },
        kind: {
          type: 'string',
          description: 'Symbol kind: function, class, interface, method, variable, type, enum',
          enum: ['function', 'class', 'interface', 'method', 'variable', 'type', 'enum'],
        },
        fuzzy: {
          type: 'boolean',
          description: 'Fuzzy matching (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: ['query'],
    },
    async function(args) {
      const { query, kind, fuzzy = false, limit = 20 } = args;

      const workspace = getWorkspace();
      const indexManager = getIndexManager(workspace);

      // 检查索引是否存在
      const hasIndex = await indexManager.hasIndex();
      if (!hasIndex) return indexNotBuilt('search_symbol');

      // 搜索符号
      const results = await indexManager.searchSymbol({
        query,
        kind: kind as SymbolKind,
        fuzzy,
        limit,
      });

      if (results.length === 0) {
        return `✓ 搜索: "${query}"

未找到匹配的符号

💡 建议:
- 尝试 fuzzy=true 进行模糊搜索
- 检查关键词拼写
- 运行 build_index(force=true) 重建索引`;
      }

      // 格式化输出
      const lines: string[] = [
        `✓ 搜索: "${query}"${kind ? ` (类型: ${kind})` : ''}${fuzzy ? ' (模糊匹配)' : ''}`,
        `找到 ${results.length} 个结果:`,
        '',
      ];

      for (const result of results) {
        const relPath = formatDisplayPath(result.file);
        const parent = result.symbol.parent ? `${result.symbol.parent}.` : '';
        lines.push(
          `▸ ${parent}${result.symbol.name} (${result.symbol.kind})`,
          `  📄 ${relPath}:${result.symbol.startLine}`,
          ''
        );
      }

      lines.push('💡 使用 readfile 查看详情:');
      if (results.length > 0) {
        const first = results[0];
        lines.push(
          `  readfile(path="${formatDisplayPath(first.file)}", symbol="${first.symbol.name}")`
        );
      }

      return lines.join('\n');
    },
  };

  // ============================================
  // 工具 4: get_definitions - 查找符号定义
  // ============================================
  const getDefinitions: Tool = {
    name: 'get_definitions',
    description: `[Symbol definitions] Look up where a symbol is defined in the index.

⚠️ Run build_index first.

Examples:
get_definitions(query="UserService")            → find the definition
get_definitions(symbol="handleLogin", kind="function")
get_definitions(query="User", path="src/auth")  → restrict to a directory`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name (takes precedence)',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name (alias for query)',
        },
        kind: {
          type: 'string',
          description: 'Symbol kind: function, class, interface, method, variable, type, enum',
          enum: ['function', 'class', 'interface', 'method', 'variable', 'type', 'enum'],
        },
        path: {
          type: 'string',
          description: 'Restrict the search to a directory (relative to the workspace)',
        },
        fuzzy: {
          type: 'boolean',
          description: 'Fuzzy matching (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function(args) {
      const query = typeof args.query === 'string' ? args.query : typeof args.symbol === 'string' ? args.symbol : '';
      if (!query.trim()) {
        return fail('✗ 缺少参数: query (或 symbol)');
      }

      const workspace = getWorkspace();
      const indexManager = getIndexManager(workspace);

      const hasIndex = await indexManager.hasIndex();
      if (!hasIndex) return indexNotBuilt('get_definitions');

      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 100) : 20;
      const kind = args.kind as SymbolKind | undefined;
      const fuzzy = Boolean(args.fuzzy);

      let results = await indexManager.searchSymbol({
        query,
        kind,
        fuzzy,
        limit,
      });

      if (args.path) {
        const scopedPath = path.resolve(workspace, args.path);
        results = results.filter(result => {
          const filePath = path.resolve(result.file);
          return filePath === scopedPath || filePath.startsWith(scopedPath + path.sep);
        });
      }

      if (results.length === 0) {
        return `✓ 查找: "${query}"

未找到定义

💡 建议:
- 尝试 fuzzy=true 进行模糊搜索
- 检查关键词拼写
- 运行 build_index(force=true) 重建索引`;
      }

      const lines: string[] = [
        `✓ 定义: "${query}"${kind ? ` (类型: ${kind})` : ''}${fuzzy ? ' (模糊匹配)' : ''}`,
        `找到 ${results.length} 个结果:`,
        '',
      ];

      for (const result of results) {
        const relPath = formatDisplayPath(result.file);
        const parent = result.symbol.parent ? `${result.symbol.parent}.` : '';
        lines.push(
          `▸ ${parent}${result.symbol.name} (${result.symbol.kind})`,
          `  📄 ${relPath}:${result.symbol.startLine}`,
          ''
        );
      }

      lines.push('💡 使用 readfile 查看详情:');
      if (results.length > 0) {
        const first = results[0];
        lines.push(
          `  readfile(path="${formatDisplayPath(first.file)}", symbol="${first.symbol.name}")`
        );
      }

      return lines.join('\n');
    },
  };

  // ============================================
  // 工具 5: get_references - 查找符号引用
  // ============================================
  const getReferences: Tool = {
    name: 'get_references',
    description: `[Symbol references] Find where a symbol is referenced across the workspace.

Examples:
get_references(query="UserService")
get_references(symbol="handleLogin", path="src/auth")
get_references(query="FeatureFlag", file_pattern="*.ts")`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name (takes precedence)',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name (alias for query)',
        },
        path: {
          type: 'string',
          description: 'Search path (relative to the workspace; defaults to the workspace root)',
        },
        file_pattern: {
          type: 'string',
          description: 'File filter (e.g., "*.ts", "*.{js,ts}")',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive (default: false)',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a regular expression (default: false)',
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines (default: 2)',
        },
        max_matches: {
          type: 'number',
          description: 'Maximum number of matches (default: 200)',
        },
      },
    },
    permission: {
      category: ToolCategory.READ,
      allowInAskMode: true,
    },
    async function(args) {
      const query = typeof args.query === 'string' ? args.query : typeof args.symbol === 'string' ? args.symbol : '';
      if (!query.trim()) {
        return fail('✗ 缺少参数: query (或 symbol)');
      }

      const workspace = getWorkspace();
      const targetPath = path.resolve(workspace, args.path || '.');

      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(targetPath);
      } catch {
        return fail('✗ 路径不存在');
      }

      const contextLines = typeof args.context_lines === 'number' && args.context_lines >= 0
        ? Math.min(args.context_lines, 10)
        : 2;
      const maxMatches = typeof args.max_matches === 'number' && args.max_matches > 0
        ? Math.min(args.max_matches, 1000)
        : 200;
      const caseInsensitive = Boolean(args.case_insensitive);
      const regexMode = Boolean(args.regex);

      let regex: RegExp;
      try {
        const pattern = regexMode ? query : escapeRegExp(query);
        regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
      } catch (error: any) {
        return fail(`✗ 无效的正则表达式: ${error.message}`);
      }

      let filesToSearch: string[] = [];
      if (stats.isDirectory()) {
        const globPattern = args.file_pattern || '**/*';
        const { runWithFileLimit } = await import('../files/fileLimiter.js');
        filesToSearch = await runWithFileLimit(() => glob(globPattern, {
          cwd: targetPath,
          absolute: true,
          nodir: true,
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/.next/**',
            '**/coverage/**',
            '**/__pycache__/**',
            '**/target/**',
            '**/vendor/**',
          ],
        }));
      } else {
        filesToSearch = [targetPath];
      }

      if (filesToSearch.length === 0) {
        return '✓ 未找到可搜索的文件';
      }

      interface FileMatch {
        file: string;
        matches: Array<{ lineNum: number; line: string; isMatch: boolean }>;
        matchCount: number;
      }

      const results: FileMatch[] = [];
      let totalMatches = 0;
      let filesSearched = 0;
      let filesWithMatches = 0;

      for (const file of filesToSearch) {
        if (totalMatches >= maxMatches) break;

        try {
          const content = await fs.readFile(file, 'utf-8');
          if (content.includes('\0')) {
            continue;
          }
          const lines = splitContentLines(content);
          const matchedLineNums = new Set<number>();
          const collectedLines = new Map<number, { line: string; isMatch: boolean }>();

          for (let i = 0; i < lines.length; i++) {
            if (totalMatches >= maxMatches) break;
            const line = lines[i];
            const isMatch = regex.test(line);
            regex.lastIndex = 0;

            if (isMatch) {
              matchedLineNums.add(i);
              totalMatches++;

              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              for (let j = start; j <= end; j++) {
                const existing = collectedLines.get(j);
                collectedLines.set(j, {
                  line: lines[j],
                  isMatch: existing?.isMatch || j === i,
                });
              }
            }
          }

          filesSearched++;

          if (matchedLineNums.size > 0) {
            filesWithMatches++;
            const lineNums = Array.from(collectedLines.keys()).sort((a, b) => a - b);
            const fileMatches: FileMatch['matches'] = lineNums.map(lineNum => ({
              lineNum: lineNum + 1,
              line: collectedLines.get(lineNum)?.line || '',
              isMatch: collectedLines.get(lineNum)?.isMatch || false,
            }));

            results.push({
              file,
              matches: fileMatches,
              matchCount: matchedLineNums.size,
            });
          }
        } catch {
          continue;
        }
      }

      const displayPath = formatDisplayPath(targetPath);
      const output: string[] = [
        `✓ 引用: "${query}"`,
        `▸ 路径: ${displayPath}`,
        args.file_pattern ? `▸ 文件过滤: ${args.file_pattern}` : '',
        caseInsensitive ? '▸ 模式: 忽略大小写' : '',
        regexMode ? '▸ 模式: 正则' : '',
        '',
        `文件: ${filesSearched} 已搜索, ${filesWithMatches} 有匹配`,
        `匹配: ${totalMatches}${totalMatches >= maxMatches ? ' (已达上限)' : ''}`,
      ].filter(line => line !== '');

      for (const result of results) {
        const relPath = formatDisplayPath(result.file);
        output.push(`\n▸ ${relPath} (${result.matchCount} 处)`);
        output.push('─'.repeat(50));

        let lastLineNum = -10;
        for (const match of result.matches) {
          if (match.lineNum > lastLineNum + 1 && lastLineNum > 0) {
            output.push('      ┄┄┄');
          }
          const prefix = match.isMatch ? '▶' : ' ';
          output.push(`${prefix}${String(match.lineNum).padStart(5)} │ ${match.line}`);
          lastLineNum = match.lineNum;
        }
      }

      if (results.length === 0) {
        output.push('未找到匹配内容');
        output.push('');
        output.push('💡 建议:');
        output.push('  - 检查关键词拼写');
        output.push('  - 使用 regex=true 进行更精确匹配');
        output.push('  - 缩小或扩大 path/file_pattern 范围');
      }

      return output.join('\n');
    },
  };

  // ============================================
  // 工具 6: index_stats - 索引统计
  // ============================================
  const indexStats: Tool = {
    name: 'index_stats',
    description: `[Index stats] Show the current project's index status and statistics.`,
    parameters: {
      type: 'object',
      properties: {},
    },
    async function() {
      const workspace = getWorkspace();
      const indexManager = getIndexManager(workspace);

      const stats = await indexManager.getStats();

      if (!stats.hasIndex) {
        return `📊 索引状态: 未构建

💡 运行 build_index() 构建索引以获得更好的代码导航体验`;
      }

      const sizeKB = (stats.size / 1024).toFixed(1);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      const sizeDisplay = stats.size > 1024 * 1024 ? `${sizeMB}MB` : `${sizeKB}KB`;

      return `📊 索引状态: 已构建

统计:
  文件数: ${stats.fileCount}
  符号数: ${stats.symbolCount}
  索引大小: ${sizeDisplay}
  最后更新: ${stats.lastUpdated?.toLocaleString() || 'N/A'}

💡 使用 build_index(force=true) 可以重建索引`;
    },
  };

  const expTier = (process.env.NEOX_EXP_READFILE_TIER || '').toUpperCase();
  if (expTier === 'B' || expTier === 'C') {
    const keep = expTier === 'C'
      ? ['path', 'start_line', 'end_line', 'num_lines', 'read_all']
      : ['path', 'start_line', 'end_line', 'num_lines', 'read_all', 'symbol'];
    const props = (smartRead.parameters as any)?.properties;
    if (props) {
      for (const k of Object.keys(props)) if (!keep.includes(k)) delete props[k];
    }
  }

  return [smartRead, buildIndex, searchSymbol, getDefinitions, getReferences, indexStats];
}
