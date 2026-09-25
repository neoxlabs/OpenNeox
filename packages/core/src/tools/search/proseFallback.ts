/**
 * 自然语言查询的候选文件求交
 *
 * Content search intersects per-query results, which can be truncated for
 * common terms. This fallback intersects the smaller `rg -l` file lists first,
 * then limits content search to the candidate files.
 *
 * 排序也在这里做 —— 词项 AND 天然会命中一大票文件, 按字母序返回等于没排序。
 */
import type { SearchQuery } from './queryUtils.js';

/** 跟 contentRipgrepCollector / runtimeSearchTool 同一套签名 (cwd 是位置参数) */
export type RunCommandFn = (
  command: string,
  args: string[],
  cwd: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<{ stdout?: string; stderr?: string; exitCode: number }>;

export interface IntersectParams {
  terms: SearchQuery[];
  /** 候选文件至少要命中多少个词项 (CJK 2-gram 带噪音, 不能要求全中) */
  minHits?: number;
  identifiers: SearchQuery[];
  absPaths: string[];
  shouldRecurse: boolean;
  includeHidden?: boolean;
  filePattern?: string;
  searchIgnoreGlobs: string[];
  runCommand: RunCommandFn;
  getRipgrepPath: () => Promise<string | null> | string | null;
  getWorkspaceRoot: () => string;
  timeoutMs: number;
}

export interface IntersectResult {
  /** 候选文件绝对路径, 已按相关性排序 */
  files: string[];
  /** 命中标识符拼法的文件 (高精度, 排最前) */
  identifierHits: string[];
}

function buildBaseArgs(p: IntersectParams): string[] {
  const args = ['-l', '-i', '--no-messages'];
  if (!p.shouldRecurse) args.push('--max-depth', '1');
  if (p.includeHidden) args.push('--hidden');
  if (p.filePattern) args.push('-g', p.filePattern);
  for (const glob of p.searchIgnoreGlobs) args.push('-g', `!${glob}`);
  return args;
}

async function filesMatching(p: IntersectParams, rg: string, q: SearchQuery): Promise<Set<string>> {
  const args = buildBaseArgs(p);
  if (!q.regex) args.push('-F');
  args.push('-e', q.pattern, ...p.absPaths);
  try {
    const res = await p.runCommand(rg, args, p.getWorkspaceRoot(), { timeoutMs: p.timeoutMs });
    const out = new Set<string>();
    for (const line of String(res.stdout ?? '').split('\n')) {
      const t = line.trim();
      if (t) out.add(t);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** 相关性打分 — 名字里带词的排前面, 路径浅的排前面 */
function scoreFile(file: string, terms: string[], isIdentifierHit: boolean): number {
  const lower = file.toLowerCase();
  const base = lower.split('/').pop() || lower;
  let score = 0;
  if (isIdentifierHit) score += 100;                       // 标识符拼法命中 = 最强信号
  for (const t of terms) {
    const tt = t.toLowerCase().replace(/\[a-z\]\*$/, '');  // 去掉词根 regex 尾巴
    if (!tt) continue;
    if (base.includes(tt)) score += 20;                    // 文件名里就有
    else if (lower.includes(tt)) score += 5;               // 路径里有
  }
  score -= (file.split('/').length - 1) * 0.3;             // 路径越深越靠后
  if (/[.](test|spec)[.]/.test(base)) score -= 8;          // 测试文件通常不是要找的实现
  if (/\/(dist|build|node_modules)\//.test(lower)) score -= 50;
  return score;
}

export async function intersectFilesByTerms(p: IntersectParams): Promise<IntersectResult> {
  const rgPath = await p.getRipgrepPath();
  if (!rgPath) return { files: [], identifierHits: [] };

  /* 1. 逐词取"有匹配的文件名"集合(rg -l 输出极小, 高频词也不会截断), 再按命中数筛。
   *    不用硬交集: CJK 无词典切出的 2-gram 必然含跨词边界的噪音项("录清"), 要求全中会一个都搜不到。
   *    minHits 由调用方按词项构成给 (纯拉丁=全中, 含 CJK=多数)。 */
  const termSets = await Promise.all(p.terms.map(q => filesMatching(p, rgPath, q)));
  const need = Math.max(1, Math.min(p.minHits ?? p.terms.length, p.terms.length));
  const hitCount = new Map<string, number>();
  for (const s of termSets) for (const f of s) hitCount.set(f, (hitCount.get(f) || 0) + 1);
  const intersection = new Set<string>();
  for (const [f, c] of hitCount) if (c >= need) intersection.add(f);

  /* 2. 标识符拼法单独求并 —— 它是高精度信号, 不该被"所有词都要出现"卡掉
   *    (例如 ALWAYS_ACTIVE_TOOLS 所在文件未必单独出现过 "active" 这个词)。 */
  const idSets = await Promise.all(p.identifiers.map(q => filesMatching(p, rgPath, q)));
  const identifierHits = new Set<string>();
  for (const s of idSets) for (const f of s) identifierHits.add(f);

  const all = new Set<string>([...intersection, ...identifierHits]);
  const termPatterns = p.terms.map(q => q.pattern);
  /* 命中的词项越多排越前 —— 软门槛下这是最强的相关性信号 */
  const rank = (f: string) => scoreFile(f, termPatterns, identifierHits.has(f)) + (hitCount.get(f) || 0) * 3;
  const ranked = [...all].sort((a, b) => rank(b) - rank(a));

  return { files: ranked, identifierHits: [...identifierHits] };
}
