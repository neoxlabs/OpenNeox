import fs from 'fs/promises';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { findFreshSearch, recordSearch, noteDuplicateHit } from '../smart-read/readLedger.js';
import { analyzeSearchQueries, looksLikeProseQuery, looksLikePathQuery, worthFilenameRetry, expandProseQuery, type SearchQuery } from './queryUtils.js';
import { intersectFilesByTerms } from './proseFallback.js';
import { createRipgrepResolver } from './ripgrepResolver.js';
import { resolveSearchPaths } from './resolveSearchPath.js';
import { runSearchFilesMode } from './filesModeSearch.js';
import { collectContentRipgrepMatches } from './contentRipgrepCollector.js';
import { buildSearchContentResults } from './contentSearchResultBuilder.js';
import { buildSearchContentOutput } from './contentSearchOutput.js';

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

type RuntimeSearchLogger = {
  debug: (scope: string, message: string, data?: any) => void;
  info: (scope: string, message: string, data?: any) => void;
  warn: (scope: string, message: string, data?: any) => void;
};

type CreateRuntimeSearchToolDeps = {
  resolveWorkspacePath: (requestedPath?: string) => string;
  formatDisplayPath: (absPath: string) => string;
  getWorkspaceRoot: () => string;
  runCommand: RunCommandFn;
  logger: RuntimeSearchLogger;
};

const SEARCH_IGNORE_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/out/**',
  '!**/.next/**',
  '!**/coverage/**',
  '!**/__pycache__/**',
  '!**/target/**',
  '!**/vendor/**',
];

const SEARCH_TIMEOUT_MS = Number(process.env.NEOX_SEARCH_TIMEOUT_MS) || 30_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRuntimeSearchTool({
  resolveWorkspacePath,
  formatDisplayPath,
  getWorkspaceRoot,
  runCommand,
  logger,
}: CreateRuntimeSearchToolDeps): Tool {
  const ripgrepResolver = createRipgrepResolver({
    runCommand,
    getWorkspaceRoot,
    logInfo: (scope, message, data) => logger.info(scope, message, data),
    logWarn: (scope, message, data) => logger.warn(scope, message, data),
  });
  const { getRipgrepPath, isRipgrepAvailable, isRipgrepSpawnFailure, setCachedRipgrepPath, getLastDetectionFailure } = ripgrepResolver;

  setTimeout(() => {
    void isRipgrepAvailable().catch(() => { /* 预热失败不致命, 真搜索时会重试 */ });
  }, 1500);

  return {
    name: 'search',
    /* D wire: search 是短任务, 90s 给大 monorepo (千万行) ripgrep 留余量. 避免 30min */
    timeoutMs: 90_000,
    description: `Global search. pattern (regex) or keywords[] (literal OR), mode='content'|'files'. Defaults: path=cwd, recursive, case-insensitive, auto-ignores node_modules/.git/dist/build/vendor. queries[] supports and/or/not. With mode='files', pattern is a glob (e.g. "*Controller*.java"). For multiple paths use paths: ["dir1", "dir2"] (the path field is single-value only — do not space-join several paths into it).`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern (regex by default). Examples: "error", "login", "function\\s+\\w+"',
        },
        query: {
          type: 'string',
          description: 'Alias for pattern',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multi-keyword OR search (literal matching)',
        },
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alias for keywords (literal OR)',
        },
        queries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              op: { type: 'string', enum: ['and', 'or', 'not'] },
              regex: { type: 'boolean' },
              case_insensitive: { type: 'boolean' },
            },
            required: ['pattern'],
          },
          description: 'Advanced multi-query (supports and/or/not)',
        },
        op: {
          type: 'string',
          enum: ['and', 'or', 'not'],
          description: 'Logical operator for pattern (default: or)',
        },
        mode: {
          type: 'string',
          enum: ['content', 'files'],
          description: 'Search mode: content or filename (default: content)',
        },
        path: {
          type: 'string',
          description: 'A single search path (optional, defaults to cwd). For multiple paths use the paths[] field — do not space-join them.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple search paths (e.g. ["packages/core/src", "packages/cli/src"]). When given, the path field is ignored. ripgrep natively supports multiple positional paths, so one call scans them all.',
        },
        recursive: {
          type: 'boolean',
          description: 'Recurse into subdirectories (optional; defaults to true for directories, false for files)',
        },
        file_pattern: {
          type: 'string',
          description: 'File type filter (e.g., "*.ts", "*.{js,jsx,ts,tsx}")',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden files (default: false)',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive (default: true)',
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines (default: 2)',
        },
        max_matches: {
          type: 'number',
          description: 'Maximum number of matches (default: 200)',
        },
        count_only: {
          type: 'boolean',
          description: 'Return counts only (a fast way to see how matches are distributed)',
        },
      },
    },
    async function({
      pattern,
      query,
      keywords: keywordsArg,
      patterns,
      queries,
      op,
      mode = 'content',
      path: searchPath,
      paths: searchPaths,
      recursive,
      file_pattern,
      include_hidden = false,
      case_insensitive = true,
      context_lines = 2,
      max_matches = 200,
      count_only = false,
    }, context) {
      /* patterns[] = keywords 的别名 (见上面 schema 注释); 两个都给就合并去重 */
      const keywords = (Array.isArray(keywordsArg) || Array.isArray(patterns))
        ? [...new Set([...(keywordsArg ?? []), ...(patterns ?? [])].filter((k: unknown) => typeof k === 'string' && k.trim()))]
        : keywordsArg;
      try {
        const searchStartTime = Date.now();
        logger.debug('SEARCH', `>>> searchTool.execute START, pattern=${pattern || query || keywords?.join(',')}`);

        const signal = context?.signal;
        const throwIfAborted = () => {
          if (signal?.aborted) {
            const error = new Error('Operation cancelled');
            error.name = 'AbortError';
            throw error;
          }
        };
        const yieldEvery = 200;
        const yieldToEventLoop = async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
        };

        const workspaceRoot = getWorkspaceRoot();
        const { resolutions, uniqueAbsPaths, aggregateResolvedFrom } = resolveSearchPaths({
          paths: searchPaths,
          searchPath,
          workspaceRoot,
          resolveWorkspacePath,
        });
        const resolvedFrom = aggregateResolvedFrom;

        /* displayPath: 单路径直接显示, 多路径用 ", " 串起来 (用户看 status bar 一眼能认). */
        const displayPath = uniqueAbsPaths.length === 1
          ? formatDisplayPath(uniqueAbsPaths[0])
          : uniqueAbsPaths.map(p => formatDisplayPath(p)).join(', ');

        throwIfAborted();

        /* fs.stat 每个 unique path; 任意一个失败立即返回 (避免静默丢路径). */
        let anyIsDirectory = false;
        for (const absPath of uniqueAbsPaths) {
          try {
            const stats = await fs.stat(absPath);
            if (stats.isDirectory()) anyIsDirectory = true;
          } catch (error: any) {
            return JSON.stringify(createContextualResult(
              'search',
              'error',
              `search failed: ${error.message}`,
              undefined,
              { error: error.message, file_path: absPath }
            ));
          }
        }

        const shouldRecurse = recursive !== undefined ? recursive : anyIsDirectory;

        let {
          normalizedQueries,
          positiveQueries,
          andQueries,
          orQueries,
          notQueries,
          querySummary,
        } = analyzeSearchQueries({
          pattern,
          query,
          keywords,
          queries,
          op,
          case_insensitive,
          mode,
        });
        const { invalidRegex } = analyzeSearchQueries({
          pattern, query, keywords, queries, op, case_insensitive, mode,
        });

        throwIfAborted();

        if (normalizedQueries.length === 0) {
          return JSON.stringify(createContextualResult(
            'search',
            'error',
            'search failed: no query provided',
            undefined,
            { error: 'Provide pattern/keywords/queries' }
          ));
        }

        if (positiveQueries.length === 0) {
          return JSON.stringify(createContextualResult(
            'search',
            'error',
            'search failed: only NOT queries provided',
            undefined,
            { error: 'At least one non-NOT query is required' }
          ));
        }

        if (invalidRegex.length > 0) {
          return JSON.stringify(createContextualResult(
            'search',
            'error',
            `search failed: invalid regex (${invalidRegex[0]})`,
            undefined,
            { error: `Invalid regex: ${invalidRegex.join('; ')}` }
          ));
        }

        const searchKey = JSON.stringify({
          pattern: pattern ?? null, query: query ?? null, keywords: keywords ?? null,
          queries: queries ?? null, op: op ?? null, mode,
          paths: uniqueAbsPaths, fp: file_pattern ?? null, ci: case_insensitive,
          rec: shouldRecurse, hid: include_hidden, ctx: context_lines, mm: max_matches, co: count_only,
        });
        const cachedSearch = findFreshSearch(searchKey);
        if (cachedSearch) {
          noteDuplicateHit('search');
          const shown = cachedSearch.filesWithMatches.slice(0, 40);
          const more = cachedSearch.filesWithMatches.length - shown.length;
          const body = [
            `⟳ 与上次相同的搜索, 且期间没有文件改动 → 结果未变 (已跳过重搜)。`,
            `上次: ${cachedSearch.matchCount} 个匹配, 命中 ${cachedSearch.filesWithMatches.length} 个文件:`,
            ...shown.map(f => `  ${f}`),
            more > 0 ? `  … 及另 ${more} 个文件` : '',
          ].filter(Boolean).join('\n');
          return JSON.stringify(createContextualResult(
            'search',
            'success',
            `search "${querySummary}" (未变化 · ${cachedSearch.matchCount} matches)`,
            body,
            { metadata: { deduplicated: true, match_count: cachedSearch.matchCount, files_with_matches: cachedSearch.filesWithMatches } },
          ));
        }

        logger.debug('SEARCH', `>>> Before isRipgrepAvailable, elapsed=${Date.now() - searchStartTime}ms`);
        const shouldUseRipgrep = await isRipgrepAvailable();
        logger.debug('SEARCH', `<<< After isRipgrepAvailable, elapsed=${Date.now() - searchStartTime}ms`);

        const suggestedNumLines = Math.min(200, Math.max(80, context_lines * 4 + 40));
        logger.info('SEARCH', `Strategy: ${shouldUseRipgrep ? 'ripgrep' : 'fallback'}`);

        if (!shouldUseRipgrep) {
          const failureDetail = getLastDetectionFailure();
          const summary = failureDetail
            ? `search failed: ripgrep not available (${failureDetail})`
            : 'search failed: ripgrep not available';
          return JSON.stringify(createContextualResult(
            'search',
            'error',
            summary,
            `Ripgrep is required for search.\nDetection failure: ${failureDetail || 'unknown'}`,
            { error: summary }
          ));
        }

        throwIfAborted();

        /* files 模式的入参在下面两处复用 (显式 mode='files', 以及 content 零命中后的降级) */
        const callFilesMode = () => runSearchFilesMode({
            absPaths: uniqueAbsPaths,
            displayPath,
            resolvedFrom,
            anyIsDirectory,
            shouldRecurse,
            includeHidden: include_hidden,
            filePattern: file_pattern,
            normalizedQueries,
            andQueries,
            orQueries,
            querySummary,
            caseInsensitive: case_insensitive,
            shouldUseRipgrep,
            signal,
            searchIgnoreGlobs: SEARCH_IGNORE_GLOBS,
            yieldEvery,
            throwIfAborted,
            yieldToEventLoop,
            timeoutMs: SEARCH_TIMEOUT_MS,
            runCommand,
            getWorkspaceRoot,
            getRipgrepPath,
            formatDisplayPath,
        });

        if (mode === 'files') {
          return callFilesMode();
        }

        const runContentPass = async (qs: {
          positiveQueries: SearchQuery[];
          andQueries: SearchQuery[];
          notQueries: SearchQuery[];
          overrideAbsPaths?: string[];
        }) => {
          const collected = await collectContentRipgrepMatches({
            shouldUseRipgrep,
            positiveQueries: qs.positiveQueries,
            contextLines: context_lines,
            includeHidden: include_hidden,
            shouldRecurse,
            anyIsDirectory,
            filePattern: file_pattern,
            absPaths: qs.overrideAbsPaths ?? uniqueAbsPaths,
            searchIgnoreGlobs: SEARCH_IGNORE_GLOBS,
            signal,
            yieldEvery,
            throwIfAborted,
            yieldToEventLoop,
            timeoutMs: SEARCH_TIMEOUT_MS,
            runCommand,
            getWorkspaceRoot,
            getRipgrepPath,
            isRipgrepSpawnFailure,
            setCachedRipgrepPath,
            logWarn: (scope: string, message: string, data?: unknown) => logger.warn(scope, message, data),
            maxMatchesPerFile: count_only ? 50 : Math.max(20, Number(max_matches) * 2),
            maxColumns: 300,
          });
          const passNotMatchers = qs.notQueries.map(queryItem => {
            const source = queryItem.regex ? queryItem.pattern : escapeRegExp(queryItem.pattern);
            return new RegExp(source, queryItem.caseInsensitive ? 'i' : '');
          });
          const built = await buildSearchContentResults({
            matchStore: collected.matchStore,
            fileQueryHits: collected.fileQueryHits,
            requiredQueryIds: new Set(qs.andQueries.map(q => q.id)),
            notMatchers: passNotMatchers,
            maxMatches: max_matches,
            countOnly: count_only,
            suggestedNumLines,
            formatDisplayPath,
            throwIfAborted,
            yieldToEventLoop,
            yieldEvery,
          });
          return { collected, built };
        };

        let pass = await runContentPass({ positiveQueries, andQueries, notQueries });
        let proseFallbackNote = '';

        if (pass.built.results.length === 0 && typeof pattern === 'string' && worthFilenameRetry(pattern)) {
          const raw = await callFilesMode();
          let parsed: any = null;
          try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch { parsed = null; }
          const text = typeof parsed?.content === 'string' ? parsed.content : '';
          const files: unknown[] = Array.isArray(parsed?.metadata?.files) ? parsed.metadata.files : [];
          /* 判"有没有命中"看 metadata.files 的长度, 不看文案里有没有"未找到" ——
           * 文案里本来就带一段"建议"可能含这些词, 拿它当判据会误伤。 */
          if (files.length > 0 && text) {
            return JSON.stringify({
              ...parsed,
              summary: `search "${pattern}" → 按文件名命中 ${files.length} 个`,
              content:
                `━━━━ 已按文件名检索 ━━━━\n` +
                `"${pattern}" 作为**文件内容**无匹配, 已自动改用 mode='files' 按文件名再搜一次。\n` +
                `若你要找的是内容而非文件, 请换成具体标识符或 keywords:[...] 重搜。\n\n` +
                text,
            });
          }
        }

        if (pass.built.results.length === 0 && mode !== 'files' && typeof pattern === 'string' && looksLikeProseQuery(pattern)) {
          const exp = expandProseQuery(pattern, case_insensitive ?? true);
          const retryPositive = [...exp.andQueries, ...exp.identifierQueries];
          if (retryPositive.length > 0) {
            const candidates = await intersectFilesByTerms({
              terms: exp.andQueries,
              minHits: exp.softMinHits,
              identifiers: exp.identifierQueries,
              absPaths: uniqueAbsPaths,
              shouldRecurse,
              includeHidden: include_hidden,
              filePattern: file_pattern,
              searchIgnoreGlobs: SEARCH_IGNORE_GLOBS,
              runCommand,
              getRipgrepPath,
              getWorkspaceRoot,
              timeoutMs: SEARCH_TIMEOUT_MS,
            });
            const retry = candidates.files.length === 0 ? { built: { results: [] } } as any : await runContentPass({
              positiveQueries: retryPositive,
              andQueries: [],                        // 交集已经保证了 AND, 这里只要展示片段
              notQueries,
              overrideAbsPaths: candidates.files.slice(0, 120),
            });
            if (retry.built.results.length > 0) {
              pass = retry;
              normalizedQueries = [...retryPositive, ...notQueries];
              positiveQueries = retryPositive;
              andQueries = exp.andQueries;
              orQueries = exp.identifierQueries;
              querySummary = `${pattern} → 词项 AND(${exp.terms.join(' + ')})${exp.identifierQueries.length ? ` OR 标识符拼法` : ''}`;
              proseFallbackNote = [
                '',
                '━━━━ 已按自然语言降级检索 ━━━━',
                `原查询 "${pattern}" 作为字面短语无匹配 (代码里通常不会连着出现这些词)。`,
                `已改为: 要求这些词都出现 —— ${exp.terms.join(' + ')}${exp.identifierQueries.length ? `; 并附带标识符拼法 (${exp.identifierQueries.slice(0, 3).map(q => q.pattern).join(' / ')}…)` : ''}。`,
                '若结果不是你要的, 直接用具体标识符或 keywords:[...] 重搜更准。',
              ].join('\n');
            }
          }
        }

        const { matchStore, fileQueryHits, filesSearched, executedCommands, tccHint, truncated, truncatedQueries } = pass.collected;
        const { results, totalMatches, filesWithMatches, readHints, metadataMatches } = pass.built;

        results.sort((a, b) => formatDisplayPath(a.file).localeCompare(formatDisplayPath(b.file)));
        const output = await buildSearchContentOutput({
          querySummary,
          displayPath,
          shouldRecurse,
          resolvedFrom,
          filePattern: file_pattern,
          caseInsensitive: case_insensitive,
          shouldUseRipgrep,
          filesSearched,
          filesWithMatches,
          totalMatches,
          maxMatches: max_matches,
          countOnly: count_only,
          results,
          readHints,
          formatDisplayPath,
          throwIfAborted,
          yieldToEventLoop,
          yieldEvery,
        });

        // rg 吐到 4MB 被 kill 后,我们仍拿到前 4MB 的 JSON 匹配 —— 这些照常展示,
        // 额外附一段"结果已截断,建议缩范围"的说明给 LLM 看,它自己会重试更窄的查询。
        const truncationHint = truncated
          ? [
              '',
              '━━━━ 结果已截断 ━━━━',
              `⚠ 匹配输出超过 4MB 上限,已返回部分结果(查询: ${(truncatedQueries ?? []).map(q => `"${q}"`).join(', ') || '未知'})。`,
              '建议缩小搜索范围后重试: 1) 加 file_pattern 限定文件类型; 2) 把 path 缩到具体子目录; 3) 先用 count_only=true 看命中分布; 4) 避免在大目录搜单字母或极高频词。',
            ].join('\n')
          : '';

        const hintSuffix = [tccHint, truncationHint, proseFallbackNote].filter(s => s && s.trim().length > 0).join('\n\n');
        const finalOutput = hintSuffix ? `${output}\n\n${hintSuffix}` : output;

        /* 登记结果指纹, 供后续相同查询去重 (截断的结果不登记, 免得沿用不完整数据)。 */
        if (!truncated) {
          const matchedFiles = [...new Set(results.map(r => formatDisplayPath(r.file)))];
          recordSearch(searchKey, totalMatches, matchedFiles, {
            /* 失效判定要用它: 新写入的内容里若出现这个模式, 说明可能多出新匹配 */
            pattern: typeof pattern === 'string' ? pattern : (typeof query === 'string' ? query : undefined),
            caseInsensitive: !!case_insensitive,
            /* 绝对路径单独给失效判定 — 上面那份是 display 路径, 跟写入回报的绝对路径比不上 */
            matchedPaths: [...new Set(results.map(r => r.file))],
          });
        }

        return JSON.stringify(createContextualResult(
          'search',
          'success',
          results.length > 0
            ? `search "${querySummary}" (${totalMatches} matches${truncated ? ', truncated' : ''})`
            : `search "${querySummary}" (no matches)`,
          finalOutput,
          {
            metadata: {
              mode: 'content',
              strategy: shouldUseRipgrep ? 'rg' : 'fallback',
              regex: normalizedQueries.some(q => q.regex),
              case_insensitive,
              path: displayPath,
              resolved_from: resolvedFrom,
              queries: normalizedQueries,
              matches: metadataMatches,
              read_hints: readHints,
              files_with_matches: filesWithMatches,
              command: executedCommands.length > 0 ? executedCommands[0] : undefined,
              truncated: truncated || undefined,
            },
          }
        ));
      } catch (error: any) {
        // 不要拼进 user-facing detail —— stack 第一帧本身就是 "Error: <message>",
        // 拼起来 UI 会显示两遍一样的内容 + 一堆文件路径,完全是噪音。
        const errMsg = error?.message || error?.name || String(error) || 'unknown error';
        logger.warn('SEARCH', 'search tool failed', {
          path: searchPath,
          paths: searchPaths,
          mode,
          pattern,
          query,
          keywords,
          queries,
          file_pattern,
          context_lines,
          max_matches,
          error: errMsg,
          stack: error?.stack,
        });
        return JSON.stringify(createContextualResult(
          'search',
          'error',
          `search failed: ${errMsg}`,
          undefined,
          { error: errMsg }
        ));
      }
    },
  };
}
