import * as path from 'node:path';
import * as fsSync from 'node:fs';
import type { SearchQuery } from './queryUtils.js';
import { filterRipgrepStderr, detectTCCIssue } from './stderrFilter.js';

/* bundled rg 起不来时的回退候选。裸 'rg' 依赖 spawn env 的 PATH — 而 command runner 用的是
 * 启动时抓的 shellEnv 快照, ripgrepResolver 运行时对 process.env.PATH 的 prepend 根本到不了
 * 子进程 (Windows 定位)。所以先试 execPath 同目录的 sidecar 绝对路径, 再试裸 'rg'。 */
function ripgrepFallbackCandidates(exclude: string): string[] {
  const out: string[] = [];
  try {
    const sidecar = path.join(
      path.dirname(process.execPath),
      process.platform === 'win32' ? 'rg.exe' : 'rg',
    );
    if (sidecar !== exclude && fsSync.existsSync(sidecar)) out.push(sidecar);
  } catch { /* 非致命 */ }
  if (exclude !== 'rg') out.push('rg');
  return out;
}

export type SearchMatchStore = Map<string, Map<number, { line: string; queryIds: Set<string>; column?: number }>>;
export type SearchFileQueryHits = Map<string, Set<string>>;

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

type CollectContentRipgrepMatchesArgs = {
  shouldUseRipgrep: boolean;
  positiveQueries: SearchQuery[];
  contextLines: number;
  includeHidden: boolean;
  shouldRecurse: boolean;
  /* anyIsDirectory: 至少一个 absPaths 元素是目录 — 决定是否给 rg 加 --max-depth 1
   *   (--max-depth 只对目录入口有意义, 单文件无作用). */
  anyIsDirectory: boolean;
  filePattern?: string;
  /* 多路径: rg PATTERN PATH1 PATH2 ... 是 ripgrep CLI 原生支持. 单路径调用方传 [absPath]. */
  absPaths: string[];
  searchIgnoreGlobs: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  yieldEvery: number;
  throwIfAborted: () => void;
  yieldToEventLoop: () => Promise<void>;
  runCommand: RunCommandFn;
  getWorkspaceRoot: () => string;
  getRipgrepPath: () => Promise<string | null>;
  isRipgrepSpawnFailure: (exitCode: number, stderr: string) => boolean;
  setCachedRipgrepPath: (resolvedPath: string | null) => void;
  logWarn: (scope: string, message: string, data?: any) => void;
  /**
   *  每文件 match 上限 — 直接传给 rg 的 `-m`。
   * 如果 LLM 要 max_matches 条总数,我们给 rg 的每文件上限开到 max(max_matches * 2, 20)
   * 作为安全余量(给 notMatchers 后置过滤留空间),避免 rg 跑全工作区后吐出几十 MB JSON。
   * 没传则不加 -m(保留老行为)。
   */
  maxMatchesPerFile?: number;
  /** `--max-columns` — 防止极长行(binary / minified)把 JSON output 撑爆 */
  maxColumns?: number;
};

export async function collectContentRipgrepMatches({
  shouldUseRipgrep,
  positiveQueries,
  contextLines,
  includeHidden,
  shouldRecurse,
  anyIsDirectory,
  filePattern,
  absPaths,
  searchIgnoreGlobs,
  signal,
  timeoutMs,
  yieldEvery,
  throwIfAborted,
  yieldToEventLoop,
  runCommand,
  getWorkspaceRoot,
  getRipgrepPath,
  isRipgrepSpawnFailure,
  setCachedRipgrepPath,
  logWarn,
  maxMatchesPerFile,
  maxColumns,
}: CollectContentRipgrepMatchesArgs): Promise<{
  matchStore: SearchMatchStore;
  fileQueryHits: SearchFileQueryHits;
  filesSearched: number;
  executedCommands: string[];
  tccHint?: string;
  truncated?: boolean;
  truncatedQueries?: string[];
}> {
  const matchStore: SearchMatchStore = new Map();
  const fileQueryHits: SearchFileQueryHits = new Map();
  let filesSearched = 0;
  const executedCommands: string[] = [];
  let tccHint: string | undefined;
  let truncated = false;
  const truncatedQueries: string[] = [];

  if (!shouldUseRipgrep) {
    return { matchStore, fileQueryHits, filesSearched, executedCommands };
  }

  const rgPath = await getRipgrepPath();
  if (!rgPath) {
    throw new Error('ripgrep not available (this should not happen)');
  }

  for (const queryItem of positiveQueries) {
    throwIfAborted();
    const rgArgs = ['--json', '--with-filename', '--line-number', '--column', '-a'];
    rgArgs.push('-C', String(contextLines));
    if (typeof maxMatchesPerFile === 'number' && maxMatchesPerFile > 0 && Number.isFinite(maxMatchesPerFile)) {
      rgArgs.push('-m', String(Math.floor(maxMatchesPerFile)));
    }
    if (typeof maxColumns === 'number' && maxColumns > 0 && Number.isFinite(maxColumns)) {
      rgArgs.push('--max-columns', String(Math.floor(maxColumns)));
    }

    if (queryItem.caseInsensitive) rgArgs.push('-i');
    if (!queryItem.regex) rgArgs.push('-F');
    if (includeHidden) rgArgs.push('--hidden');
    if (!shouldRecurse && anyIsDirectory) {
      rgArgs.push('--max-depth', '1');
    }
    if (filePattern) {
      rgArgs.push('-g', filePattern);
    }
    searchIgnoreGlobs.forEach(globPattern => rgArgs.push('-g', globPattern));
    /* rg PATTERN PATH1 PATH2 ... 多 positional paths native 支持 (rg --help). */
    rgArgs.push('--', queryItem.pattern, ...absPaths);

    let activeRgPath = rgPath;
    let rgOutput = '';
    let rgExit = 0;
    let rgError = '';

    const executeRipgrep = async (commandPath: string) => {
      const commandStr = `${commandPath} ${rgArgs.join(' ')}`;
      executedCommands.push(commandStr);
      return runCommand(commandPath, rgArgs, getWorkspaceRoot(), { signal, timeoutMs });
    };

    try {
      const result = await executeRipgrep(activeRgPath);
      rgOutput = result.stdout;
      //  先检测 TCC 问题（使用原始 stderr），再过滤
      const rawStderr = result.stderr || '';
      const tccResult = detectTCCIssue(rawStderr);
      if (tccResult.userHint) {
        tccHint = tccResult.userHint;
      }
      rgError = filterRipgrepStderr(rawStderr);
      rgExit = result.exitCode;
      /* Path-level warnings leave the search usable: ripgrep skips those paths
       * and searches the remainder, so the result code follows whether output exists. */
      if (rgExit === 2 && !rgError && rawStderr.length > 0) {
        rgExit = rgOutput.trim() ? 0 : 1;
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || signal?.aborted) {
        throw error;
      }
      rgError = filterRipgrepStderr(error?.message || error?.stderr || String(error));
      rgExit = error?.exitCode || 2;
    }

    if (rgExit !== 0 && rgExit !== 1 && activeRgPath !== 'rg' && isRipgrepSpawnFailure(rgExit, rgError)) {
      logWarn('SEARCH', 'Bundled ripgrep failed, retrying with system rg', {
        exitCode: rgExit,
        error: rgError,
        bundledPath: activeRgPath,
        workspaceRoot: getWorkspaceRoot(),
        absPaths,
        query: queryItem.pattern,
        args: rgArgs,
      });

      for (const candidate of ripgrepFallbackCandidates(activeRgPath)) {
        try {
          const fallbackResult = await executeRipgrep(candidate);
          rgOutput = fallbackResult.stdout;
          rgError = filterRipgrepStderr(fallbackResult.stderr || '');
          rgExit = fallbackResult.exitCode;
          if (rgExit === 2 && !rgError && (fallbackResult.stderr || '').length > 0) {
            rgExit = rgOutput.trim() ? 0 : 1;
          }
          activeRgPath = candidate;

          if (rgExit === 0 || rgExit === 1) {
            setCachedRipgrepPath(candidate);
            break;
          }
          if (!isRipgrepSpawnFailure(rgExit, rgError)) break; /* 真跑起来了但报错 — 别再换二进制 */
        } catch (error: any) {
          if (error?.name === 'AbortError' || signal?.aborted) {
            throw error;
          }
          const fallbackError = filterRipgrepStderr(error?.message || error?.stderr || String(error));
          rgError = `${rgError}\nFallback ${candidate} failed: ${fallbackError}`.trim();
          rgExit = error?.exitCode || 2;
        }
      }
    }

    //  OUTPUT_CAP soft-truncate:参考 Claude Code 官方 Grep 的做法,
    // 不把超限当失败 —— 子进程被 SIGKILL 前已经写入了前 4MB 的 --json 输出,
    // 这些 JSON 行绝大多数是完整的(最后一行可能半截,下面 parse loop 的 try/catch
    // 已兜住)。把它们当成部分结果正常解析,再通过返回值里的 truncated 标记
    // 告诉上层"还有更多",让 LLM 自己决定缩范围重搜而不是看到 "Tool failed"。
    if (rgError.includes('NEOX_OUTPUT_CAP')) {
      truncated = true;
      truncatedQueries.push(queryItem.pattern);
      if (rgExit !== 0 && rgExit !== 1) {
        logWarn('SEARCH', 'ripgrep output capped, returning partial results', {
          query: queryItem.pattern,
          exitCode: rgExit,
          partialBytes: rgOutput.length,
        });
        rgExit = 0;
      }
    } else if (rgExit !== 0 && rgExit !== 1) {
      logWarn('SEARCH', 'ripgrep content query failed', {
        exitCode: rgExit,
        error: rgError,
        activeRgPath,
        workspaceRoot: getWorkspaceRoot(),
        absPaths,
        query: queryItem.pattern,
        args: rgArgs,
      });
      const errorDetails = rgError ? `\nError: ${rgError}` : '';
      const commandHint = process.env.NEOX_SEARCH_VERBOSE_ERROR === '1'
        ? `\nCommand: ${activeRgPath} ${rgArgs.join(' ')}`
        : '';
      throw new Error(`ripgrep failed (exit code ${rgExit})${errorDetails}${commandHint}`);
    }

    let rgLineCount = 0;
    for (const line of rgOutput.split('\n')) {
      throwIfAborted();
      rgLineCount++;
      if (rgLineCount % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === 'summary') {
        const stats = parsed.data?.stats;
        if (stats && typeof stats.searches === 'number') {
          filesSearched = Math.max(filesSearched, stats.searches);
        }
        continue;
      }

      const isMatch = parsed.type === 'match';
      const isContext = parsed.type === 'context';
      if (!isMatch && !isContext) continue;

      const data = parsed.data;
      const filePath = data?.path?.text;
      const lineNumber = data?.line_number;
      const lineText = data?.lines?.text;
      const submatch = Array.isArray(data?.submatches) ? data.submatches[0] : undefined;
      if (!filePath || !lineNumber || typeof lineText !== 'string') continue;

      const lineContent = lineText.replace(/\n$/, '');
      const fileMap = matchStore.get(filePath) || new Map();
      const entry = fileMap.get(lineNumber) || { line: lineContent, queryIds: new Set<string>() };
      entry.line = lineContent;

      if (isMatch) {
        entry.queryIds.add(queryItem.id);
        if (entry.column === undefined && submatch?.start !== undefined) {
          entry.column = submatch.start + 1;
        }

        const queryHitSet = fileQueryHits.get(filePath) || new Set<string>();
        queryHitSet.add(queryItem.id);
        fileQueryHits.set(filePath, queryHitSet);
      }

      fileMap.set(lineNumber, entry);
      matchStore.set(filePath, fileMap);
    }
  }

  return {
    matchStore,
    fileQueryHits,
    filesSearched,
    executedCommands,
    tccHint,
    truncated: truncated || undefined,
    truncatedQueries: truncatedQueries.length > 0 ? truncatedQueries : undefined,
  };
}
