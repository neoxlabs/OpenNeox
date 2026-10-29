/**
 * CLI diff 展示口径 (CLI-04)
 *
 * 时间线里的 diff 卡只显示前 N 行, 长改动在卡里看不清 —— 需要能「折叠 + 全屏看」。
 * 这里放与 React 无关的纯逻辑, 三处共用同一套口径:
 *   · ToolCard 的折叠 (卡里显示前 DIFF_PREVIEW_MAX_LINES 行, 其余给一行提示);
 *   · ctrl+d 的全屏视图 (把条目里存的 diff 明细还原成可滚动的行);
 *   · 单测 (不依赖 Ink 渲染, 直接断言行/折叠数)。
 *
 * 明细格式由 InkUIAdapter 写死 (见 startEditFile / startWriteFile):
 *   `type:lineNum:content`, type ∈ H(header) / C(context) / +(add) / -(remove)
 */

import chalk from 'chalk';

/** 卡片默认折叠行数 (CLI-04 验收: 折叠默认 12 行) */
export const DIFF_PREVIEW_MAX_LINES = 12;

export interface ParsedDiffLine {
  type: 'header' | 'add' | 'remove' | 'context' | 'unknown';
  lineNum: number;
  content: string;
}

/**
 * 解析 unified diff 行的类型、行号和内容
 * 格式：type:lineNum:content
 */
export function parseDiffLine(line: string): ParsedDiffLine {
  // 新格式: type:lineNum:content
  const m = line.match(/^([HCR+\-]):(\d+):(.*)$/s);
  if (m) {
    const typeMap: Record<string, ParsedDiffLine['type']> = {
      'H': 'header', '+': 'add', '-': 'remove', 'C': 'context',
    };
    return { type: typeMap[m[1]] || 'unknown', lineNum: parseInt(m[2], 10), content: m[3] };
  }
  // 兼容旧格式 type:content (无行号)
  if (line.startsWith('H:')) return { type: 'header', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('+:')) return { type: 'add', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('-:')) return { type: 'remove', lineNum: 0, content: line.slice(2) };
  if (line.startsWith('C:')) return { type: 'context', lineNum: 0, content: line.slice(2) };
  return { type: 'unknown', lineNum: 0, content: line };
}

/**
 * 卡片里的 details 文本 → 可渲染的 diff 行。
 *
 * `keepFileHeaders=false` (卡片口径): 丢掉 `--- a/x` / `+++ b/x` / `@@` 这类噪音头,
 * 只留 `... (N more lines)` 这种截断提示 —— 与 ToolCard 一直以来的显示一致。
 * `keepFileHeaders=true` (全屏口径): 全留着, 用户在全屏里要能看出这是哪个 hunk。
 */
export function parseDiffDetails(details: string, opts: { keepFileHeaders?: boolean } = {}): ParsedDiffLine[] {
  const keep = opts.keepFileHeaders === true;
  return details
    .split('\n')
    .filter(line => line.length > 0)
    .map(parseDiffLine)
    .filter((dl) => {
      if (keep || dl.type !== 'header') return true;
      return /\(\d+\s+more lines?\)/i.test(dl.content) || /^\.\.\./.test(dl.content.trim());
    });
}

/** 折叠: 前 max 行照显示, 剩下的只给数量 */
export function foldDiffPreview<T>(
  lines: T[],
  max: number = DIFF_PREVIEW_MAX_LINES,
): { shown: T[]; hidden: number } {
  const limit = Math.max(0, Math.floor(max));
  if (lines.length <= limit) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, limit), hidden: lines.length - limit };
}

/** 全屏视图里的一段 (一次改动 / 一个文件) */
export interface DiffViewerSection {
  title: string;
  lines: ParsedDiffLine[];
}

/**
 * 原始 unified diff 文本 (git_diff 工具的输出) → 行。
 * 与 ToolCard 的 git_diff 卡同一口径: `diff --git` / `index` / `---` / `+++` / `@@` 都当头部。
 */
export function parseUnifiedDiffText(text: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  let lineNum = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      out.push({ type: 'header', lineNum: 0, content: raw });
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      lineNum = m ? parseInt(m[1], 10) : 1;
      out.push({ type: 'header', lineNum: 0, content: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ type: 'add', lineNum: lineNum++, content: raw.slice(1) });
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ type: 'remove', lineNum, content: raw.slice(1) });
      continue;
    }
    out.push({ type: 'context', lineNum: lineNum++, content: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  // 尾部空行 (文本以 \n 结尾) 不算一行
  while (out.length > 0 && out[out.length - 1].type === 'context' && out[out.length - 1].content === '') out.pop();
  return out;
}

/** git_diff 卡 / 全屏视图里那段内容的来路 (可能是 JSON 包装, 也可能是原始 diff) */
function gitDiffTextOf(details: string | undefined, message: string | undefined): string | null {
  const src = details || message || '';
  if (!src) return null;
  if (src.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(src);
      const content = parsed?.content || parsed?.diff || parsed?.output;
      return typeof content === 'string' ? content : null;
    } catch { /* 不是 JSON, 往下走 */ }
  }
  if (src.includes('diff --git') || src.includes('@@')) return src;
  return null;
}

/**
 * 时间线条目 → 全屏视图的分段 (按出现顺序, 最近的排最后)。
 *
 * 只认两类: `file_update` (edit/write 的 diff 明细) 和 `git_diff` (git 工具的原始 diff)。
 * 其它条目 (普通工具输出) 不进这个视图 —— 它们用 ctrl+o 的完整记录看。
 */
export function collectDiffViewerSections(entries: Array<Record<string, any>>): DiffViewerSection[] {
  const sections: DiffViewerSection[] = [];
  for (const entry of entries) {
    const type = entry?.type as string | undefined;
    if (!type) continue;
    if (type === 'file_update') {
      const details = typeof entry.details === 'string' ? entry.details : '';
      // 只有带 `type:lineNum:` 明细的才是 diff (addFileUpdate 那类只有一行描述)
      if (!/^[HCR+-]:\d+:/m.test(details)) continue;
      const lines = parseDiffDetails(details, { keepFileHeaders: true });
      if (lines.length === 0) continue;
      sections.push({ title: String(entry.text || 'diff'), lines });
      continue;
    }
    if (type === 'git_diff') {
      const raw = gitDiffTextOf(
        typeof entry.details === 'string' ? entry.details : undefined,
        typeof entry.text === 'string' ? entry.text : undefined,
      );
      if (!raw) continue;
      const lines = parseUnifiedDiffText(raw);
      if (lines.length === 0) continue;
      sections.push({ title: String(entry.text || 'git diff'), lines });
    }
  }
  return sections;
}

/**
 * 一段 diff → 备用屏里的文本行 (带颜色)。
 *
 * 着色口径与卡片一致: 新增绿、删除红、上下文淡、头部青。chalk 在非 TTY 下自己是空操作,
 * 全屏视图只在交互终端里打开, 所以这里直接用 chalk, 不自己拼转义序列。
 */
export function renderDiffSectionLines(section: DiffViewerSection): string[] {
  let maxLn = 0;
  for (const line of section.lines) if (line.lineNum > maxLn) maxLn = line.lineNum;
  const lnW = Math.max(String(maxLn).length, 3);

  const out: string[] = [];
  for (const line of section.lines) {
    const ln = line.lineNum > 0 ? String(line.lineNum).padStart(lnW) : ' '.repeat(lnW);
    switch (line.type) {
      case 'add':
        out.push(chalk.green(`${ln} + ${line.content}`));
        break;
      case 'remove':
        out.push(chalk.red(`${ln} - ${line.content}`));
        break;
      case 'header':
        out.push(chalk.cyan(line.content));
        break;
      default:
        out.push(chalk.gray(`${ln}   ${line.content}`));
        break;
    }
  }
  return out;
}
