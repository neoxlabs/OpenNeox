import path from 'path';

export type SearchQueryInput = {
  pattern: string;
  op?: 'and' | 'or' | 'not';
  regex?: boolean;
  case_insensitive?: boolean;
};

export type SearchQuery = {
  id: string;
  pattern: string;
  op: 'and' | 'or' | 'not';
  regex: boolean;
  caseInsensitive: boolean;
};

export type AnalyzedSearchQueries = {
  normalizedQueries: SearchQuery[];
  positiveQueries: SearchQuery[];
  andQueries: SearchQuery[];
  orQueries: SearchQuery[];
  notQueries: SearchQuery[];
  invalidRegex: string[];
  querySummary: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function globToRegExpSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      const nextChar = pattern[i + 1];
      source += nextChar === '*' ? (i++, '.*') : '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end > i + 1) {
        const parts = pattern.slice(i + 1, end).split(',').map(globToRegExpSource);
        source += `(?:${parts.join('|')})`;
        i = end;
        continue;
      }
    }
    if (char === '/' || char === '\\') {
      source += '/';
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

export function createFileSearchMatcher(query: SearchQuery): (filePath: string) => boolean {
  const flags = query.caseInsensitive ? 'i' : '';
  if (query.regex) {
    const regex = new RegExp(query.pattern, flags);
    return (filePath) => regex.test(filePath.replace(/\\/g, '/'));
  }
  if (looksLikeGlobPattern(query.pattern)) {
    const normalizedPattern = query.pattern.replace(/\\/g, '/');
    const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`, flags);
    const matchFullPath = normalizedPattern.includes('/');
    return (filePath) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const target = matchFullPath ? normalizedPath : path.posix.basename(normalizedPath);
      return regex.test(target);
    };
  }
  const regex = new RegExp(escapeRegExp(query.pattern), flags);
  return (filePath) => regex.test(filePath.replace(/\\/g, '/'));
}

export function normalizeSearchQueries(args: {
  pattern?: string;
  query?: string;
  keywords?: string[];
  queries?: SearchQueryInput[];
  op?: 'and' | 'or' | 'not';
  case_insensitive?: boolean;
  mode?: 'content' | 'files';
}): SearchQuery[] {
  const baseCaseInsensitive = args.case_insensitive ?? true;
  const patternDefaultRegex = args.mode === 'files' ? false : true;
  const normalized: SearchQuery[] = [];
  const pushQuery = (query: SearchQueryInput, defaultOp: 'and' | 'or' | 'not', defaultRegex: boolean) => {
    if (!query.pattern || !query.pattern.trim()) return;
    const op = (query.op || defaultOp).toLowerCase() as 'and' | 'or' | 'not';
    normalized.push({
      id: `q${normalized.length + 1}`,
      pattern: query.pattern,
      op: op === 'and' || op === 'or' || op === 'not' ? op : defaultOp,
      regex: query.regex ?? defaultRegex,
      caseInsensitive: query.case_insensitive ?? baseCaseInsensitive,
    });
  };
  if (args.pattern || args.query) pushQuery({ pattern: args.pattern || args.query || '', op: args.op }, 'or', patternDefaultRegex);
  if (Array.isArray(args.keywords)) for (const keyword of args.keywords) pushQuery({ pattern: keyword }, 'or', false);
  if (Array.isArray(args.queries)) for (const query of args.queries) pushQuery(query, 'or', query.regex ?? patternDefaultRegex);
  return normalized;
}

// ============================================================================
// 自然语言查询扩展
//
// 问题: content 模式下 pattern 默认按**正则**处理, 于是多词查询("compaction
// threshold" / "日志目录清理")变成字面短语匹配 —— 代码里永远不会连着出现这些词。
// 模型除了换词重猜没有任何线索。这就是"没有语义检索"最痛的那一刀:
// 不是 ripgrep 弱, 是查询意图和工具语义对不上。
//
// 这里只做**客观的形态变换**, 不猜同义词 (同义词是另一个量级的工程, 且容易自证循环):
//   1. 词项 AND —— "日志 目录 清理" → 三个词都出现的文件 (最大的一块收益)
//   2. 标识符拼法 —— "always active tools" → alwaysActiveTools / always_active_tools
//      / AlwaysActiveTools / ALWAYS_ACTIVE_TOOLS
//   3. 词形 —— compaction/compacting/compact 这类共同前缀退化 (仅英文, 保守取 4+ 字符词根)
// ============================================================================

/** 正则元字符 —— 出现这些就认为模型是有意写正则, 不做扩展 */
const REGEX_META = /[\\^$.|?*+()[\]{}]/;

/** 看起来像"自然语言意图"而不是正则/标识符的查询 */
export function looksLikeProseQuery(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (REGEX_META.test(p)) return false;          // 显式正则 → 尊重原意
  /* CJK compounds without spaces still represent natural-language queries. */
  const cjkRun = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{4,}/.test(p);
  if (!/[\s　]/.test(p) && !cjkRun) return false;  // 单个拉丁 token → 本来就能搜
  const parts = splitQueryTerms(p);
  return parts.length >= 2 && parts.length <= 12;
}

/**
 * Determine whether a query has the shape of a file or path rather than content.
 *
 * 症状: agent 拿文件名或路径片段去 search (默认 content 模式), 内容零命中, 于是反复
 * 换词重搜 —— 外部测试记为"search 对路径名不敏感导致空转"。
 *
 * 判据保守: 只认那些**几乎不可能是内容查询**的形状, 宁可漏判也不误判 ——
 * 误判会让本该是内容搜索的 query 被拖去搜文件名, 那是更坏的结果。
 *   · 带路径分隔符           src/tools/search
 *   · 带常见源码扩展名        runtimeSearchTool.ts / *.java
 *   · 带 glob 通配            *Controller*
 * 且不能含空格 (带空格的多半是自然语言, 交给 prose 那条降级)。
 */
const PATHY_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|go|rs|java|kt|swift|rb|php|c|h|cpp|hpp|cs|sh|yml|yaml|toml|sql|vue|svelte)$/i;
/**
 * Determine whether a zero-match content query should retry against file names.
 *
 * This check also accepts bare names without an extension or slash.
 *
 * The fallback runs only after content returns no matches, so a file-name miss
 * preserves the original result and costs one inexpensive lookup.
 *
 * 仍然排除: 带空格 (交给自然语言那条降级) 和显式正则 (尊重原意)。
 */
export function worthFilenameRetry(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || /[\s　]/.test(p)) return false;
  if (looksLikePathQuery(p)) return true;
  if (REGEX_META.test(p)) return false;
  /* 单个 token: 标识符 / 文件名主干 / 中文词都算 */
  return p.length >= 3;
}

export function looksLikePathQuery(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || /[\s　]/.test(p)) return false;   // 带空格 → 交给 prose 降级
  if (p.includes('/') || p.includes('\\')) return true;
  if (PATHY_EXT.test(p)) return true;
  if (/[*?]/.test(p) && /[A-Za-z0-9_-]/.test(p)) return true;  // glob 形状
  return false;
}

/** CJK 连续块 → 重叠 2-gram。中文技术词绝大多数是双字词("日志"/"目录"/"清理"),
 *  但无词典时无法准确分词, 所以取全部重叠 2-gram 当"软词项"(不要求全中, 见 softMinHits)。 */
export function cjkBigrams(run: string): string[] {
  if (run.length <= 2) return [run];
  const out: string[] = [];
  for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

/** 切词: 空白 + CJK/拉丁交界。CJK 连续块再拆成 2-gram。 */
export function splitQueryTerms(pattern: string): string[] {
  return pattern
    .split(/[\s　,，、;；]+/)
    .flatMap(seg => {
      // 拉丁与 CJK 混排时切开, 例如 "编码探测BOM" → ["编码探测","BOM"]
      const out: string[] = [];
      let buf = '', bufCjk: boolean | null = null;
      for (const ch of seg) {
        const cjk = /[㐀-鿿぀-ヿ가-힯]/.test(ch);
        if (bufCjk !== null && cjk !== bufCjk) { if (buf) out.push(buf); buf = ''; }
        buf += ch; bufCjk = cjk;
      }
      if (buf) out.push(buf);
      return out.flatMap(tok =>
        /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(tok) ? cjkBigrams(tok) : [tok]);
    })
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** 词项里有多少是 CJK 2-gram (噪音项) —— 决定要不要放宽"全中"的要求 */
export function countCjkTerms(terms: string[]): number {
  return terms.filter(t => /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,2}$/.test(t)).length;
}

/** 把词项拼成各种标识符惯例 */
export function identifierVariants(terms: string[]): string[] {
  const latin = terms.filter(t => /^[A-Za-z][A-Za-z0-9]*$/.test(t));
  if (latin.length < 2) return [];
  const lower = latin.map(t => t.toLowerCase());
  const cap = lower.map(t => t[0].toUpperCase() + t.slice(1));
  return [
    lower.join('_'),                       // always_active_tools
    lower.join(''),                        // alwaysactivetools
    lower[0] + cap.slice(1).join(''),      // alwaysActiveTools
    cap.join(''),                          // AlwaysActiveTools
    lower.join('_').toUpperCase(),         // ALWAYS_ACTIVE_TOOLS
    lower.join('-'),                       // always-active-tools
  ];
}

/** 英文词根退化 —— compaction → compact, retries → retri… 只做保守的后缀剥离 */
export function stemTerm(term: string): string | null {
  if (!/^[A-Za-z]{6,}$/.test(term)) return null;
  const t = term.toLowerCase();
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'ies', 'es', 's']) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) return t.slice(0, t.length - suf.length);
  }
  return null;
}

export type ProseExpansion = {
  terms: string[];
  /** 候选文件至少要命中多少个词项 —— 拉丁词要求全中, CJK 2-gram 有噪音只要求多数 */
  softMinHits: number;
  /** 每个词项(或其词根)一条 AND query — 命中"这些词都出现"的文件 */
  andQueries: SearchQuery[];
  /** 标识符拼法, OR — 命中模型其实想找的那个符号 */
  identifierQueries: SearchQuery[];
};

/** 把一条自然语言查询展开成可执行的 query 组 */
export function expandProseQuery(pattern: string, caseInsensitive = true): ProseExpansion {
  const terms = splitQueryTerms(pattern);
  let n = 0;
  const mk = (p: string, op: 'and' | 'or'): SearchQuery => ({
    id: `x${++n}`, pattern: p, op, regex: false, caseInsensitive,
  });
  const andQueries = terms.map(t => {
    const stem = stemTerm(t);
    /* 有词根时用 regex 兼容两种词形 (compact|compaction|compacting…) */
    if (stem) {
      return { id: `x${++n}`, pattern: `${stem}[a-z]*`, op: 'and' as const, regex: true, caseInsensitive };
    }
    return mk(t, 'and');
  });
  const identifierQueries = identifierVariants(terms).map(v => mk(v, 'or'));
  /* CJK 2-gram 是无词典切出来的, 必然带噪音项("录清"这种跨词边界的), 要求全中会一个都搜不到。
     取 60% 作门槛: 既滤掉巧合命中, 又容忍 1~2 个噪音 gram 落空。纯拉丁词精确, 仍要求全中。 */
  const cjk = countCjkTerms(terms);
  const softMinHits = cjk > 0 ? Math.max(2, Math.ceil(terms.length * 0.6)) : terms.length;
  return { terms, softMinHits, andQueries, identifierQueries };
}

export function analyzeSearchQueries(args: {
  pattern?: string;
  query?: string;
  keywords?: string[];
  queries?: SearchQueryInput[];
  op?: 'and' | 'or' | 'not';
  case_insensitive?: boolean;
  mode?: 'content' | 'files';
}): AnalyzedSearchQueries {
  const normalizedQueries = normalizeSearchQueries(args);
  const positiveQueries = normalizedQueries.filter(q => q.op !== 'not');
  const andQueries = normalizedQueries.filter(q => q.op === 'and');
  const orQueries = normalizedQueries.filter(q => q.op === 'or');
  const notQueries = normalizedQueries.filter(q => q.op === 'not');

  const invalidRegex = normalizedQueries
    .filter(q => q.regex)
    .map(q => {
      try {
        new RegExp(q.pattern);
        return null;
      } catch (error: any) {
        return `${q.pattern}: ${error.message}`;
      }
    })
    .filter((item): item is string => Boolean(item));

  const querySummaryParts: string[] = [];
  if (orQueries.length > 0) {
    querySummaryParts.push(orQueries.map(q => q.pattern).join(' OR '));
  }
  if (andQueries.length > 0) {
    querySummaryParts.push(`AND ${andQueries.map(q => q.pattern).join(' + ')}`);
  }
  if (notQueries.length > 0) {
    querySummaryParts.push(`NOT ${notQueries.map(q => q.pattern).join(' + ')}`);
  }
  const querySummary = querySummaryParts.join(' ');

  return {
    normalizedQueries,
    positiveQueries,
    andQueries,
    orQueries,
    notQueries,
    invalidRegex,
    querySummary,
  };
}
