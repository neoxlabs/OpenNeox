import path from 'path';
import glob from 'fast-glob';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { createFileSearchMatcher, type SearchQuery } from './queryUtils.js';
import { filterRipgrepStderr } from './stderrFilter.js';

type ResolvedFrom = 'workspace' | 'ancestor' | 'absolute' | 'mixed';

type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunCommandFn = (
  command: string,
  args: string[],
  cwd: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
) => Promise<RunCommandResult>;

type SearchFilesModeParams = {
  /* 多路径: ripgrep / fast-glob 在每个路径下分别扫一次, 再合并去重. 单路径调用方传
   *   [absPath] 即可. anyIsDirectory 表示 *至少一个* 路径是目录 (决定 --max-depth 行为). */
  absPaths: string[];
  displayPath: string;
  resolvedFrom: ResolvedFrom;
  anyIsDirectory: boolean;
  shouldRecurse: boolean;
  includeHidden: boolean;
  filePattern?: string;
  normalizedQueries: SearchQuery[];
  andQueries: SearchQuery[];
  orQueries: SearchQuery[];
  querySummary: string;
  caseInsensitive: boolean;
  shouldUseRipgrep: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  searchIgnoreGlobs: string[];
  yieldEvery: number;
  throwIfAborted: () => void;
  yieldToEventLoop: () => Promise<void>;
  runCommand: RunCommandFn;
  getWorkspaceRoot: () => string;
  getRipgrepPath: () => Promise<string | null>;
  formatDisplayPath: (absPath: string) => string;
};

export async function runSearchFilesMode({
  absPaths,
  displayPath,
  resolvedFrom,
  anyIsDirectory,
  shouldRecurse,
  includeHidden,
  filePattern,
  normalizedQueries,
  andQueries,
  orQueries,
  querySummary,
  caseInsensitive,
  shouldUseRipgrep,
  signal,
  timeoutMs,
  searchIgnoreGlobs,
  yieldEvery,
  throwIfAborted,
  yieldToEventLoop,
  runCommand,
  getWorkspaceRoot,
  getRipgrepPath,
  formatDisplayPath,
}: SearchFilesModeParams): Promise<string> {
  const files = await (async () => {
    /* 单一文件路径 (非目录) — 直接当结果返回, 不走 rg/glob 扫描. */
    if (absPaths.length === 1 && !anyIsDirectory) {
      return [formatDisplayPath(absPaths[0])];
    }
    if (shouldUseRipgrep) {
      const rgPath = await getRipgrepPath();
      if (!rgPath) {
        throw new Error('ripgrep not available (this should not happen)');
      }

      const rgArgs = ['--files'];
      if (includeHidden) rgArgs.push('--hidden');
      if (!shouldRecurse && anyIsDirectory) {
        rgArgs.push('--max-depth', '1');
      }
      if (filePattern) {
        rgArgs.push('-g', filePattern);
      }
      searchIgnoreGlobs.forEach(globPattern => rgArgs.push('-g', globPattern));
      /* rg 后接多 positional paths 是 native 支持: rg --files PATH1 PATH2 ... */
      rgArgs.push('--', ...absPaths);

      const result = await runCommand(rgPath, rgArgs, getWorkspaceRoot(), { signal, timeoutMs });
      const filteredStderr = filterRipgrepStderr(result.stderr || '');
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        // 如果 stderr 全是权限错误且 exit code 为 2，降级为成功（无结果）
        if (result.exitCode === 2 && !filteredStderr && (result.stderr || '').length > 0) {
          // 纯权限错误，当作无结果处理
        } else {
          throw new Error(filteredStderr || 'rg files search failed');
        }
      }
      const lines = result.stdout.split('\n').filter(Boolean);
      return lines.map(line => {
        const resolved = path.isAbsolute(line)
          ? path.resolve(line)
          : path.resolve(getWorkspaceRoot(), line);
        return formatDisplayPath(resolved);
      });
    }

    /* fast-glob 走每个 absPath, 合并去重. */
    const globPattern = filePattern || '**/*';
    const fullPattern = shouldRecurse ? globPattern : globPattern.replace('**/', '');
    const seen = new Set<string>();
    const aggregated: string[] = [];
    for (const cwdPath of absPaths) {
      const resolvedFiles = await glob(fullPattern, {
        cwd: cwdPath,
        absolute: true,
        dot: includeHidden,
        onlyFiles: true,
        ignore: searchIgnoreGlobs.map(pattern => pattern.replace('!', '')),
      });
      for (const file of resolvedFiles) {
        const display = formatDisplayPath(file);
        if (!seen.has(display)) {
          seen.add(display);
          aggregated.push(display);
        }
      }
    }
    return aggregated;
  })();

  throwIfAborted();

  const matchers = normalizedQueries.map(query => ({
    query,
    matches: createFileSearchMatcher(query),
  }));

  const matchedFiles: string[] = [];
  let matchCheckCount = 0;
  for (const filePath of files) {
    throwIfAborted();
    const matches = matchers.map(m => ({ op: m.query.op, hit: m.matches(filePath) }));
    const orHit = matches.some(m => m.op === 'or' && m.hit);
    const andHit = matches.filter(m => m.op === 'and').every(m => m.hit);
    const notHit = matches.some(m => m.op === 'not' && m.hit);
    if (!notHit && (andQueries.length === 0 || andHit) && (orQueries.length === 0 || orHit)) {
      matchedFiles.push(filePath);
    }
    matchCheckCount++;
    if (matchCheckCount % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  const output: string[] = [
    `✓ 文件搜索: ${querySummary}`,
    `▸ 路径: ${displayPath}${shouldRecurse ? ' (递归)' : ''}${resolvedFrom === 'ancestor' ? ' (auto-resolved)' : ''}`,
    filePattern ? `▸ 文件过滤: ${filePattern}` : '',
    includeHidden ? '▸ 包含隐藏文件' : '',
    '',
    `找到 ${matchedFiles.length} 个文件`,
    '',
  ].filter(line => line !== '');

  const maxDisplay = 50;
  matchedFiles.slice(0, maxDisplay).forEach(file => output.push(`  ${file}`));
  if (matchedFiles.length > maxDisplay) {
    output.push(`  ... 还有 ${matchedFiles.length - maxDisplay} 个文件`);
  }

  return JSON.stringify(createContextualResult(
    'search',
    'success',
    matchedFiles.length > 0
      ? `search files "${querySummary}" (${matchedFiles.length} files)`
      : `search files "${querySummary}" (no matches)`,
    output.join('\n'),
    {
      metadata: {
        mode: 'files',
        strategy: shouldUseRipgrep ? 'rg' : 'glob',
        regex: normalizedQueries.some(q => q.regex),
        case_insensitive: caseInsensitive,
        path: displayPath,
        resolved_from: resolvedFrom,
        files: matchedFiles,
        queries: normalizedQueries,
      },
    }
  ));
}
