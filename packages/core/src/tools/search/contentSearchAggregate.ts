import type { SearchFileMatch } from './contentSearchOutput.js';

/**
 * 超预算时的 search 结构化聚合 (LOOP-01)。
 *
 * 老做法: 超过 12K 由内核 `truncateMiddleUtf16Safe` 从**中段**挖掉, 模型拿到一个
 * 头尾都在、中间缺失的列表 —— 它分不清"是被截了"还是"本来就这么点", 于是换个
 * 关键词再搜一遍。
 *
 * 这里的做法: 在预算内**按文件**排布, 宁可每文件少给几条, 也要先覆盖尽可能多的文件:
 *   1. 首行: 共 N 条命中 / M 个文件 / 下面显示前 K 条
 *   2. 按文件计数表 (命中最多的在前)
 *   3. 每个文件的前几条命中原文 (整行, 绝不半行)
 *   4. 尾部: 未显示的规模 + 怎么收窄
 * 预算耗尽就停, 不留半行。
 *
 * 小结果集走不到这里 —— 调用方先按原格式渲染, 装得下就原样返回。
 */

export type AggregateShownBlock = {
  file: string;
  lines: Array<{ lineNum: number; line: string }>;
};

export type BuildSearchAggregateArgs = {
  budgetChars: number;
  totalMatches: number;
  filesWithMatches: number;
  results: SearchFileMatch[];
  countOnly: boolean;
  /** 查询 / 路径 / 策略等一行一条的元信息, 由调用方给定 */
  summaryLines: string[];
  formatDisplayPath: (absPath: string) => string;
  extractModule: (absPath: string) => string;
};

const COUNT_TABLE_TITLE = '━━━━ 按文件计数 (命中最多的在前) ━━━━';
const TAIL_TITLE = '━━━━ 未显示 / 收窄 ━━━━';
const NARROW_HINT = '收窄建议: 加 path 指定子目录 / file_pattern (例如 *.ts) / 更具体的 pattern';
/** 每个文件最多给几条命中 —— 预算再多也不再堆单文件 */
const MAX_LINES_PER_FILE = 12;
/** 首行 + 尾行 + 空行的预留 (实际值略有浮动, 留够避免越界) */
const FIXED_RESERVE = 420;
/** 计数表最多占预算的这个比例, 且不超过这个绝对值 */
const TABLE_BUDGET_FRACTION = 0.35;
const TABLE_BUDGET_MAX = 8_000;

function matchLine(lineNum: number, line: string): string {
  return `▶${String(lineNum).padStart(5)} │ ${line}`;
}

export function buildSearchAggregateOutput(
  args: BuildSearchAggregateArgs,
): { text: string; shown: AggregateShownBlock[] } {
  const {
    budgetChars,
    totalMatches,
    filesWithMatches,
    results,
    countOnly,
    summaryLines,
    formatDisplayPath,
    extractModule,
  } = args;

  /* 计数表与详情都按命中数降序 —— 最可能相关的文件先出现, 也满足"命中最多的在前" */
  const files = [...results].sort((a, b) => (
    b.matchCount - a.matchCount
    || formatDisplayPath(a.file).localeCompare(formatDisplayPath(b.file))
  ));
  const rowOf = (r: SearchFileMatch): string => (
    `  [${extractModule(r.file)}] ${formatDisplayPath(r.file)}: ${r.matchCount}`
  );

  const tableBudget = Math.min(
    TABLE_BUDGET_MAX,
    Math.max(400, Math.floor(budgetChars * TABLE_BUDGET_FRACTION)),
  );
  const tableLines: string[] = [];
  let tableLen = COUNT_TABLE_TITLE.length + 1;
  let tableFileCount = 0;
  let tableMatchCount = 0;
  for (let i = 0; i < files.length; i++) {
    const row = rowOf(files[i]);
    if (tableLen + row.length + 1 > tableBudget) {
      const more = `  … 还有 ${files.length - i} 个文件未列出`;
      tableLines.push(more);
      tableLen += more.length + 1;
      break;
    }
    tableLines.push(row);
    tableLen += row.length + 1;
    tableFileCount++;
    tableMatchCount += files[i].matchCount;
  }

  const shown: AggregateShownBlock[] = [];
  const lines: string[] = [];

  if (countOnly) {
    /* count_only 没有命中原文, 计数表本身就是内容: 直接按预算铺满, 尾部说明还剩多少 */
    const firstLine = `共 ${totalMatches} 条命中, 分布在 ${filesWithMatches} 个文件, `
      + `下面显示前 ${tableFileCount} 个文件`;
    const body = [firstLine, ...summaryLines, '', COUNT_TABLE_TITLE, ...tableLines];
    body.push('');
    body.push(TAIL_TITLE);
    body.push(`未显示: ${Math.max(0, filesWithMatches - tableFileCount)} 个文件 / ${Math.max(0, totalMatches - tableMatchCount)} 处`);
    body.push(NARROW_HINT);
    return { text: body.join('\n'), shown };
  }

  /* 每个文件的命中原文 (不含上下文行: 超预算时优先"多覆盖文件", 不铺上下文) */
  const matchLinesByFile: string[][] = [];
  const shownLinesByFile: Array<Array<{ lineNum: number; line: string }>> = [];
  for (const file of files) {
    const hits = file.matches.filter((m) => m.isMatch);
    matchLinesByFile.push(hits.map((m) => matchLine(m.lineNum, m.line)));
    shownLinesByFile.push(hits.map((m) => ({ lineNum: m.lineNum, line: m.line })));
  }
  const headerOf = (i: number): string => (
    `▸ [${extractModule(files[i].file)}] ${formatDisplayPath(files[i].file)} (${files[i].matchCount} 处)`
  );

  const fixedLen = 160
    + summaryLines.reduce((n, s) => n + s.length + 1, 0)
    + tableLen
    + TAIL_TITLE.length + 1
    + 160;
  const detailBudget = Math.max(0, budgetChars - fixedLen);

  /* 轮转分配: 先保证"每个文件至少 1 条", 有剩余再给每个文件加第 2、第 3 条……
   * 这样预算不足时覆盖到的文件数最多, 而不是前几个文件吃掉全部预算。 */
  const shownCounts = new Array<number>(files.length).fill(0);
  let detailLen = 0;
  const headerCosts = files.map((_, i) => headerOf(i).length + 1);
  for (let round = 0; round < MAX_LINES_PER_FILE; round++) {
    let progressed = false;
    for (let i = 0; i < files.length; i++) {
      const lineList = matchLinesByFile[i];
      if (shownCounts[i] >= lineList.length || shownCounts[i] >= MAX_LINES_PER_FILE) continue;
      const cost = (shownCounts[i] === 0 ? headerCosts[i] : 0) + lineList[shownCounts[i]].length + 1;
      if (detailLen + cost > detailBudget) continue;
      shownCounts[i]++;
      detailLen += cost;
      progressed = true;
    }
    if (!progressed) break;
  }

  let shownTotal = 0;
  let filesShown = 0;
  for (const n of shownCounts) {
    if (n > 0) {
      filesShown++;
      shownTotal += n;
    }
  }

  lines.push(`共 ${totalMatches} 条命中, 分布在 ${filesWithMatches} 个文件, 下面显示前 ${shownTotal} 条`);
  lines.push(...summaryLines);
  lines.push('');
  lines.push(COUNT_TABLE_TITLE);
  lines.push(...tableLines);
  lines.push('');
  for (let i = 0; i < files.length; i++) {
    if (shownCounts[i] === 0) continue;
    lines.push(headerOf(i));
    lines.push(...matchLinesByFile[i].slice(0, shownCounts[i]));
    lines.push('');
    shown.push({ file: files[i].file, lines: shownLinesByFile[i].slice(0, shownCounts[i]) });
  }
  lines.push(TAIL_TITLE);
  lines.push(`未显示: ${Math.max(0, filesWithMatches - filesShown)} 个文件 / ${Math.max(0, totalMatches - shownTotal)} 处`);
  lines.push(NARROW_HINT);

  return { text: lines.join('\n'), shown };
}
