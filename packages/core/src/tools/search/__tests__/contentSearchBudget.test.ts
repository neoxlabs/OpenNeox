import { describe, expect, it } from 'vitest';
import { readLikeBudgetChars } from '@neoxlabs/kernel/core/toolOutputBudget.js';
import { buildSearchContentOutput, type SearchFileMatch } from '../contentSearchOutput.js';

/**
 * search 输出预算 (LOOP-01):
 *   - 少量命中: 与改动前逐字一致 (小结果集不受预算影响)
 *   - 大量命中: 结构化聚合 (总数 / 按文件计数 / 每文件前几条 / 收窄提示), 不再中段挖空
 *   - 预算随模型窗口变化
 */

const FORMAT = (p: string) => p.replace('/p/src/', '');

async function render(args: {
  results: SearchFileMatch[];
  totalMatches: number;
  filesWithMatches: number;
  maxMatches?: number;
  countOnly?: boolean;
  budgetChars?: number;
}): Promise<string> {
  return buildSearchContentOutput({
    querySummary: 'alpha',
    displayPath: 'src',
    shouldRecurse: true,
    resolvedFrom: 'workspace',
    filePattern: '*.ts',
    caseInsensitive: true,
    shouldUseRipgrep: true,
    filesSearched: 120,
    filesWithMatches: args.filesWithMatches,
    totalMatches: args.totalMatches,
    maxMatches: args.maxMatches ?? 2000,
    countOnly: args.countOnly ?? false,
    results: args.results,
    readHints: [],
    formatDisplayPath: FORMAT,
    throwIfAborted: () => {},
    yieldToEventLoop: async () => {},
    budgetChars: args.budgetChars,
  });
}

function makeResults(files: number, perFile: number): SearchFileMatch[] {
  const results: SearchFileMatch[] = [];
  for (let f = 0; f < files; f++) {
    const matchCount = perFile + (f % 3);
    const matches: SearchFileMatch['matches'] = [];
    for (let i = 0; i < matchCount; i++) {
      matches.push({
        lineNum: 10 + i * 7,
        line: `const value_${f}_${i} = "a reasonably long source line so the budget is realistic ${'x'.repeat(30)}";`,
        isMatch: true,
      });
    }
    results.push({ file: `/p/src/mod${f % 5}/file${f}.ts`, matchCount, matches });
  }
  return results;
}

const countMatchLines = (text: string): number =>
  text.split('\n').filter((line) => line.startsWith('▶')).length;

describe('buildSearchContentOutput 预算', () => {
  it('少量命中 → 与改动前逐字一致', async () => {
    const out = await render({
      results: [{
        file: '/p/src/a.ts',
        matchCount: 2,
        matches: [
          { lineNum: 1, line: 'x', isMatch: false },
          { lineNum: 2, line: 'alpha', isMatch: true },
          { lineNum: 3, line: 'y', isMatch: false },
        ],
      }],
      totalMatches: 2,
      filesWithMatches: 1,
      maxMatches: 50,
    });

    /* 这段是改动前用旧实现 dump 出来的原样输出 (见交付清单), 一个字符都不许变 */
    const EXPECTED = '✓ 搜索: alpha\n▸ 路径: src (递归)\n▸ 文件过滤: *.ts\n▸ 模式: 忽略大小写\n▸ 策略: ripgrep\n━━━━ 结果摘要 ━━━━\n文件: 120 已搜索, 1 有匹配\n匹配: 2\n\n\n▸ [a.ts] a.ts (2 处)\n──────────────────────────────────────────────────\n     1 │ x\n▶    2 │ alpha\n     3 │ y';
    expect(out).toBe(EXPECTED);
  });

  it('大量命中 → 结构化: 首行总数 / 按文件计数 / 每文件前几条 / 收窄提示', async () => {
    const results = makeResults(40, 15);
    const totalMatches = results.reduce((n, r) => n + r.matchCount, 0);
    const budget = readLikeBudgetChars(128_000);
    const out = await render({ results, totalMatches, filesWithMatches: results.length, budgetChars: budget });
    const lines = out.split('\n');

    expect(out.length).toBeLessThanOrEqual(budget);
    expect(lines[0]).toMatch(new RegExp(`^共 ${totalMatches} 条命中, 分布在 40 个文件, 下面显示前 \\d+ 条$`));
    expect(out).toContain('━━━━ 按文件计数 (命中最多的在前) ━━━━');
    expect(out).toContain('▸ [mod0] mod0/file0.ts');
    /* 末尾必须是收窄提示, 模型读完就知道下一步怎么缩小范围 */
    expect(lines[lines.length - 1]).toContain('收窄建议:');
    expect(out).toMatch(/未显示: \d+ 个文件 \/ \d+ 处/);
    /* 不再出现"中间挖空"的痕迹 */
    expect(out).not.toContain('已截断');

    const shown = Number(/下面显示前 (\d+) 条/.exec(lines[0])?.[1]);
    expect(countMatchLines(out)).toBe(shown);

    const notShown = /未显示: (\d+) 个文件 \/ (\d+) 处/.exec(out);
    expect(Number(notShown?.[1])).toBeGreaterThanOrEqual(0);
    expect(Number(notShown?.[2])).toBe(totalMatches - shown);
    /* 计数表按命中数降序: 每行都不得大于上一行 */
    const tableStart = lines.indexOf('━━━━ 按文件计数 (命中最多的在前) ━━━━');
    const tableCounts: number[] = [];
    for (let i = tableStart + 1; i < lines.length && lines[i].startsWith('  ['); i++) {
      tableCounts.push(Number(/: (\d+)$/.exec(lines[i])?.[1]));
    }
    expect(tableCounts.length).toBeGreaterThan(0);
    for (let i = 1; i < tableCounts.length; i++) {
      expect(tableCounts[i]).toBeLessThanOrEqual(tableCounts[i - 1]);
    }
  });

  it('预算随模型窗口变化: 1M 窗口显示的命中数多于 32K', async () => {
    const results = makeResults(40, 15);
    const totalMatches = results.reduce((n, r) => n + r.matchCount, 0);
    const small = await render({ results, totalMatches, filesWithMatches: results.length, budgetChars: readLikeBudgetChars(32_000) });
    const large = await render({ results, totalMatches, filesWithMatches: results.length, budgetChars: readLikeBudgetChars(1_000_000) });

    expect(small.length).toBeLessThanOrEqual(12_000);
    expect(large.length).toBeLessThanOrEqual(60_000);
    expect(countMatchLines(large)).toBeGreaterThan(countMatchLines(small));
  });

  it('count_only 超预算 → 按文件计数表 + 未显示提示, 不逐文件铺到天边', async () => {
    const results: SearchFileMatch[] = Array.from({ length: 1200 }, (_, i) => ({
      file: `/p/src/pkg${i % 7}/f${i}.ts`,
      matchCount: 4,
      matches: [],
    }));
    const out = await render({
      results,
      totalMatches: 4800,
      filesWithMatches: 1200,
      countOnly: true,
      budgetChars: 12_000,
    });

    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.split('\n')[0]).toMatch(/^共 4800 条命中, 分布在 1200 个文件, 下面显示前 \d+ 个文件$/);
    expect(out).toContain('━━━━ 按文件计数 (命中最多的在前) ━━━━');
    expect(out).toMatch(/未显示: \d+ 个文件 \/ \d+ 处/);
    expect(out.trimEnd().split('\n').pop()).toContain('收窄建议:');
  });
});
