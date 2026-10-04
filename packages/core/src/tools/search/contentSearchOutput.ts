import fs from 'fs';
import path from 'path';
import { recordRead } from '../smart-read/readLedger.js';

/**
 * Lines shown by search enter the read ledger as contiguous ranges.
 *
 *   The ledger stores unnumbered content in the same shape as readfile ranges
 *   so edit coherence can reuse the displayed text.
 */
function recordDisplayedBlocks(file: string, shown: Array<{ lineNum: number; line: string }>): void {
  if (shown.length === 0) return;
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return; }
  const sorted = [...shown].sort((a, b) => a.lineNum - b.lineNum);
  let block: Array<{ lineNum: number; line: string }> = [sorted[0]];
  const flush = () => {
    const start = block[0].lineNum;
    const end = block[block.length - 1].lineNum;
    recordRead(path.resolve(file), {
      rangeKey: `S:${start}-${end}`,
      content: block.map((m) => m.line).join('\n'),
      startLine: start,
      lineCount: end - start + 1,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      readAtTurn: 0,
    });
  };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].lineNum === block[block.length - 1].lineNum + 1) block.push(sorted[i]);
    else { flush(); block = [sorted[i]]; }
  }
  flush();
}

export type SearchFileMatch = {
  file: string;
  matches: Array<{
    lineNum: number;
    line: string;
    isMatch: boolean;
  }>;
  matchCount: number;
};

export type SearchReadHint = {
  file: string;
  anchor_lines: number[];
  num_lines: number;
};

type BuildSearchContentOutputArgs = {
  querySummary: string;
  displayPath: string;
  shouldRecurse: boolean;
  resolvedFrom: 'workspace' | 'ancestor' | 'absolute' | 'mixed';
  filePattern?: string;
  caseInsensitive: boolean;
  shouldUseRipgrep: boolean;
  filesSearched: number;
  filesWithMatches: number;
  totalMatches: number;
  maxMatches: number;
  countOnly: boolean;
  results: SearchFileMatch[];
  readHints: SearchReadHint[];
  formatDisplayPath: (absPath: string) => string;
  throwIfAborted: () => void;
  yieldToEventLoop: () => Promise<void>;
  yieldEvery?: number;
};

export async function buildSearchContentOutput({
  querySummary,
  displayPath,
  shouldRecurse,
  resolvedFrom,
  filePattern,
  caseInsensitive,
  shouldUseRipgrep,
  filesSearched,
  filesWithMatches,
  totalMatches,
  maxMatches,
  countOnly,
  results,
  readHints,
  formatDisplayPath,
  throwIfAborted,
  yieldToEventLoop,
  yieldEvery = 200,
}: BuildSearchContentOutputArgs): Promise<string> {
  const extractModule = (filePath: string): string => {
    const relPath = formatDisplayPath(filePath);
    const parts = relPath.split(path.sep);
    const srcIndex = parts.findIndex(p => ['src', 'lib', 'app', 'core', 'packages'].includes(p));
    if (srcIndex >= 0 && srcIndex + 1 < parts.length) {
      return parts[srcIndex + 1];
    }
    return parts[0] || 'root';
  };

  const output: string[] = [
    `✓ 搜索: ${querySummary}`,
    `▸ 路径: ${displayPath}${shouldRecurse ? ' (递归)' : ''}${resolvedFrom === 'ancestor' ? ' (auto-resolved)' : ''}`,
    filePattern ? `▸ 文件过滤: ${filePattern}` : '',
    caseInsensitive ? '▸ 模式: 忽略大小写' : '',
    shouldUseRipgrep ? '▸ 策略: ripgrep' : '▸ 策略: fallback',
    '',
    `━━━━ 结果摘要 ━━━━`,
    filesSearched > 0
      ? `文件: ${filesSearched} 已搜索, ${filesWithMatches} 有匹配`
      : `文件: ${filesWithMatches} 有匹配`,
    `匹配: ${totalMatches}${totalMatches >= maxMatches ? ' (已达上限)' : ''}`,
  ].filter(line => line !== '');

  const moduleStats = new Map<string, number>();
  let moduleStatCount = 0;
  for (const result of results) {
    moduleStatCount++;
    if (moduleStatCount % yieldEvery === 0) {
      await yieldToEventLoop();
    }
    const module = extractModule(result.file);
    moduleStats.set(module, (moduleStats.get(module) || 0) + result.matchCount);
  }
  if (moduleStats.size > 1) {
    output.push('');
    output.push('📦 模块分布:');
    const sortedModules = Array.from(moduleStats.entries()).sort((a, b) => b[1] - a[1]);
    for (const [mod, count] of sortedModules.slice(0, 5)) {
      output.push(`  ${mod}: ${count}`);
    }
    if (sortedModules.length > 5) {
      output.push(`  ... 还有 ${sortedModules.length - 5} 个模块`);
    }
  }

  output.push('');

  if (countOnly) {
    output.push('📋 文件列表:');
    let countModeLineCount = 0;
    for (const result of results) {
      countModeLineCount++;
      if (countModeLineCount % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      const relPath = formatDisplayPath(result.file);
      const module = extractModule(result.file);
      output.push(`  [${module}] ${relPath}: ${result.matchCount}`);
    }
  } else {
    let displayedMatches = 0;
    let outputLineCount = 0;
    const outputYieldEvery = 100;

    for (const result of results) {
      throwIfAborted();
      if (displayedMatches >= maxMatches) {
        output.push(`\n... 还有更多匹配 (已达 ${maxMatches} 上限)`);
        break;
      }

      const relPath = formatDisplayPath(result.file);
      const module = extractModule(result.file);
      output.push(`\n▸ [${module}] ${relPath} (${result.matchCount} 处)`);
      output.push('─'.repeat(50));

      let lastLineNum = -10;
      const shown: Array<{ lineNum: number; line: string }> = [];
      for (const match of result.matches) {
        if (displayedMatches >= maxMatches) break;

        outputLineCount++;
        if (outputLineCount % outputYieldEvery === 0) {
          await yieldToEventLoop();
        }

        if (match.lineNum > lastLineNum + 1 && lastLineNum > 0) {
          output.push('      ┄┄┄');
        }
        const prefix = match.isMatch ? '▶' : ' ';
        output.push(`${prefix}${String(match.lineNum).padStart(5)} │ ${match.line}`);
        shown.push({ lineNum: match.lineNum, line: match.line });
        lastLineNum = match.lineNum;
        if (match.isMatch) displayedMatches++;
      }
      recordDisplayedBlocks(result.file, shown);
    }
  }

  if (results.length === 0) {
    output.push('未找到匹配内容');
    output.push('');
    output.push('💡 建议:');
    output.push('  - 尝试 case_insensitive: true');
    output.push('  - 尝试 recursive: true 搜索子目录');
    output.push('  - 使用 keywords 或 queries 组合搜索');
    output.push('  - 查文件名请用 mode="files"');
  } else if (readHints.length > 0) {
    output.push('');
    output.push('💡 批量读取:');
    readHints.slice(0, 3).forEach(hint => {
      output.push(`  readfile(path="${hint.file}", anchor_lines=[${hint.anchor_lines.join(',')}], num_lines=${hint.num_lines})`);
    });
  }

  return output.join('\n');
}
