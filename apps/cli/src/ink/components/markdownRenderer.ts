/**
 * markdownRenderer — 纯函数: markdown 字符串 → ANSI 字符串。
 *
 * 零 React / ink 依赖, 可独立测试 (见 __tests__/markdown-render.snapshot.test.ts) + 复用 (print mode 等)。
 * React 组件壳在 MarkdownText.tsx, 只负责把这里的输出塞进 <Text>。
 */
import { marked, type Token, type Tokens } from 'marked';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { NeoxTheme, getBgMode } from '../theme.js';

const EOL = '\n';
// 流式渲染时把表格按原文(裸竖线)显示, 不画方框 (防半成品表格错位)。Ink 渲染是同步的, 单例 flag 安全。
let tablesAsRaw = false;
// 终端可用列宽 — 表格总宽超过它就画不下 (方框会折行错位), 此时才降级原文。渲染前由 renderMarkdown 写入。
let tableMaxWidth = 120;
// 正文可用列宽 (终端宽 - 回答前 "● " 那 2 列) —— 列表项自己折行做悬挂缩进时用。渲染前由 renderMarkdown 写入。
let contentWidth = 118;

// ─── marked 配置 ──────────────────────────────────────────────────
let markedConfigured = false;

function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;

  // 禁用 strikethrough —— 模型经常用 ~ 表示 "大约"（如 ~100）
  marked.use({
    tokenizer: {
      del() {
        return undefined as unknown as Tokens.Del;
      },
    },
  });
}

// ─── 字符串显示宽度（中文/emoji 占 2 列）──────────────────────────
// Use the same string-width implementation as Ink so table borders align for
// CJK text and emoji across Unicode blocks.
function getStringWidth(str: string): number {
  return stringWidth(str);
}

// ─── 行首 emoji 与紧贴的文字之间补一个空格 ──────────────────────────
// 模型常写 "已完成" / "长表格渲染正常" (emoji 后直接接字), 视觉上挤在一起。
// 只在"行首 emoji + 紧跟非空白"时补一个空格, 不动句中 emoji (低误伤)。 是 emoji 变体选择符。
function spaceAfterLeadingEmoji(text: string): string {
  return text.replace(/^(\p{Extended_Pictographic}️?)(?=\S)/u, '$1 ');
}

// ─── 有序列表编号: 第 1 层数字, 第 2 层字母 (a..z, aa..), 第 3 层小写罗马数字 ─────
function toAlphabetic(n: number): string {
  if (n <= 0) return '';
  const rest = Math.floor((n - 1) / 26);
  return toAlphabetic(rest) + String.fromCharCode(97 + ((n - 1) % 26));
}

const ROMAN_ONES = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
const ROMAN_TENS = ['', 'x', 'xx', 'xxx', 'xl', 'l', 'lx', 'lxx', 'lxxx', 'xc'];
const ROMAN_HUNDREDS = ['', 'c', 'cc', 'ccc', 'cd', 'd', 'dc', 'dcc', 'dccc', 'cm'];

function toRoman(n: number): string {
  if (n <= 0) return '';
  return 'm'.repeat(Math.floor(n / 1000))
    + ROMAN_HUNDREDS[Math.floor(n / 100) % 10]
    + ROMAN_TENS[Math.floor(n / 10) % 10]
    + ROMAN_ONES[n % 10];
}

function orderedMarker(depth: number, ordinal: number): string {
  if (depth === 2) return toAlphabetic(ordinal);
  if (depth === 3) return toRoman(ordinal);
  return String(ordinal);
}

// ─── 中文友好的折行 ────────────────────────────────────────────────
/* wrap-ansi 只在空格处断行, 一整串中文被当成一个"词": 要么整串挪到下一行 (上一行只剩几个字),
 * 要么硬切。中文排版里每个汉字/全角标点前后都能断。这里: 贪心按显示宽度装, 断点 = 最近的空格或 CJK 字符之后;
 * 找不到断点才硬切。ANSI 序列原样透传且不计宽; 断行处关闭/重开样式交给终端 (chalk 每段都自带 reset, 足够)。 */
const CJK_RE = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/;
const CLOSE_PUNCT_RE = /[）】」』》〉，。、；：！？”’)\],.;:!?]/;
const OPEN_PUNCT_RE = /[（【「『《〈“‘(\[]/;
const canBreakAfter = (ch: string) => (ch === ' ' || CJK_RE.test(ch)) && !OPEN_PUNCT_RE.test(ch);
function wrapCJK(text: string, width: number): string {
  if (width < 4) return text;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    // 切成 [ansi | 单个字符] 的序列
    const parts = para.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? [];
    let line: string[] = [];
    let w = 0;
    let lastBreak = -1;  // line 里可以在其后断开的下标
    for (const p of parts) {
      if (p.startsWith('\x1b')) { line.push(p); continue; }
      const cw = stringWidth(p);
      if (w + cw > width && line.length > 0) {
        /* 避头: 收尾标点 (）」，。 …) 不许落在行首 —— 把它前面那个字一起带到下一行 */
        if (CLOSE_PUNCT_RE.test(p) && lastBreak === line.length - 1) lastBreak = line.length - 2;
        if (lastBreak >= 0 && lastBreak < line.length - 1) {
          const head = line.slice(0, lastBreak + 1);
          const tail = line.slice(lastBreak + 1);
          out.push(head.join('').replace(/\s+$/, ''));
          line = tail;
        } else {
          out.push(line.join('').replace(/\s+$/, ''));
          line = [];
        }
        // 续行去掉开头的空格
        while (line.length && line[0] === ' ') line.shift();
        w = stringWidth(line.join('').replace(/\x1b\[[0-9;]*m/g, ''));
        lastBreak = -1;
        for (let i = 0; i < line.length; i++) if (canBreakAfter(line[i]!)) lastBreak = i;
        if (p === ' ' && line.length === 0) continue;
      }
      /* 开头标点**前面**可以断: "researcher（research" 在 "（" 前换行, 而不是找不到断点硬切 */
      if (OPEN_PUNCT_RE.test(p) && line.length > 0) lastBreak = line.length - 1;
      line.push(p);
      w += cw;
      if (canBreakAfter(p)) lastBreak = line.length - 1;
    }
    out.push(line.join(''));
  }
  return out.join('\n');
}

// ─── stripAnsi (轻量内联) ─────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ─── 渲染上下文 ───────────────────────────────────────────────────
/** depth: 列表嵌套层 (list_item 往下 +1) · ordinal: 所在有序列表项的序号 · parent: 直接父 token */
interface RenderCtx {
  depth: number;
  ordinal: number | null;
  parent: Token | null;
}

const ROOT_CTX: RenderCtx = { depth: 0, ordinal: null, parent: null };

function renderChildren(tokens: Token[] | undefined, ctx: RenderCtx): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) out += renderToken(t, ctx);
  return out;
}

const codeHex = () => (getBgMode() === 'light' ? '#5B3FD0' : '#B7A6FF');
const HEADING_STYLES = [
  (s: string) => chalk.bold.hex(NeoxTheme.brand.purple)(s),
  chalk.bold, chalk.bold, chalk.bold, chalk.bold,
];
const UNORDERED_BULLETS = ['•', '◦', '▪'];

function renderToken(token: Token, ctx: RenderCtx): string {
  switch (token.type) {
    case 'space':
    case 'br':
      return EOL;

    case 'escape':
      return token.text;

    case 'image':
      return token.href;

    case 'hr':
      return '─'.repeat(40) + EOL;

    case 'codespan':
      // 品牌浅紫、不加反引号 — 视觉上清晰区分正文
      return chalk.hex(codeHex())(token.text);

    case 'em':
      return chalk.italic(renderChildren(token.tokens, { depth: 0, ordinal: null, parent: ctx.parent }));

    case 'strong':
      return chalk.bold(renderChildren(token.tokens, { depth: 0, ordinal: null, parent: ctx.parent }));

    case 'paragraph':
      return renderChildren(token.tokens, ROOT_CTX) + EOL;

    case 'heading': {
      const style = HEADING_STYLES[token.depth - 1] ?? chalk.bold;
      return style(renderChildren(token.tokens, ROOT_CTX)) + EOL + EOL;
    }

    case 'code': {
      // 代码块：左侧加 dim 竖条 ▎ 区分正文, 语言标签 dim 顶部
      const header = token.lang ? chalk.dim(`  ${token.lang}`) + EOL : '';
      const gutter = chalk.dim('▎ ');
      const body = (token.text as string).split(EOL).map(line => gutter + line).join(EOL);
      return header + body + EOL;
    }

    case 'blockquote': {
      // 引用: 有字的行前加 dim 竖线并整行斜体, 空行原样保留 (段落间距不变)
      const gutter = chalk.dim('│');
      const lines = renderChildren(token.tokens, ROOT_CTX).split(EOL);
      for (let i = 0; i < lines.length; i++) {
        if (stripAnsi(lines[i]).trim() !== '') lines[i] = `${gutter} ${chalk.italic(lines[i])}`;
      }
      return lines.join(EOL);
    }

    case 'link': {
      const label = stripAnsi(renderChildren(token.tokens, { depth: 0, ordinal: null, parent: token }));
      if (!label || label === token.href) return chalk.hex(codeHex()).underline(token.href);
      return chalk.hex(codeHex()).underline(label) + chalk.dim(` (${token.href})`);
    }

    case 'list': {
      const list = token as Tokens.List;
      let out = '';
      list.items.forEach((item, i) => {
        const ordinal = list.ordered ? (list.start as number) + i : null;
        out += renderToken(item, { depth: ctx.depth, ordinal, parent: list });
      });
      return out;
    }

    case 'list_item': {
      const indent = '  '.repeat(ctx.depth);
      const childCtx: RenderCtx = { depth: ctx.depth + 1, ordinal: ctx.ordinal, parent: token };
      let out = '';
      for (const child of token.tokens ?? []) out += indent + renderToken(child, childCtx);
      return out;
    }

    case 'text': {
      const inner = token.tokens
        ? renderChildren(token.tokens, { depth: ctx.depth, ordinal: ctx.ordinal, parent: token })
        : token.text;
      if (ctx.parent?.type !== 'list_item') return inner;
      // 列表项正文: 无序按嵌套深度换符号 (•/◦/), 有序按层级出编号; 标记上色更清晰。
      // ctx.depth 比视觉深度大 1 (list_item 往下 +1), 顶层对应 •
      const marker = ctx.ordinal === null
        ? UNORDERED_BULLETS[Math.min(Math.max(ctx.depth - 1, 0), UNORDERED_BULLETS.length - 1)]
        : orderedMarker(ctx.depth, ctx.ordinal) + '.';
      const lead = 2 * Math.max(0, ctx.depth - 1) + getStringWidth(marker) + 1;
      const body = spaceAfterLeadingEmoji(inner);
      const avail = contentWidth - lead;
      const wrappedBody = avail >= 10 && getStringWidth(stripAnsi(body)) > avail
        ? wrapCJK(body, avail).split('\n').join(EOL + ' '.repeat(lead))
        : body;
      return `${chalk.dim(marker)} ${wrappedBody}${EOL}`;
    }

    case 'table':
      return renderTable(token as Tokens.Table);

    default:
      // def / del / html 以及未知类型: 不输出
      return '';
  }
}

// ─── 表格 ─────────────────────────────────────────────────────────
function cellPlain(cell: Tokens.TableCell | undefined): string {
  return stripAnsi(renderChildren(cell?.tokens, ROOT_CTX));
}

function alignCell(
  styled: string,
  visibleWidth: number,
  columnWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const gap = Math.max(0, columnWidth - visibleWidth);
  switch (align) {
    case 'right':
      return ' '.repeat(gap) + styled;
    case 'center': {
      const before = Math.floor(gap / 2);
      return ' '.repeat(before) + styled + ' '.repeat(gap - before);
    }
    default:
      return styled + ' '.repeat(gap);
  }
}

function renderTable(table: Tokens.Table): string {
  //  流式中: 表格还没写完, 别画方框 (半成品方框会错位/乱), 先按原文裸竖线显示;
  //   消息写完 (非流式) 再渲成方框。
  if (tablesAsRaw && table.raw) {
    return chalk.dim(table.raw.trimEnd()) + EOL;
  }

  // 每列宽度 = 表头与各行该列显示宽度的最大值 (CJK/emoji 占 2 列), 至少 3
  const widths = table.header.map((head, col) =>
    Math.max(3, getStringWidth(cellPlain(head)), ...table.rows.map(row => getStringWidth(cellPlain(row[col])))),
  );

  //  表格降级原文(dim)的两种情形 —— 只在画方框反而更糟时才降级:
  //   1) 列数对不上: 模型写的表本身畸形, 画方框必错位。
  //   2) 总宽超出终端: 方框画出来会折行、边框断裂, 比原文还乱。
  //  不因"单格内容长"降级 —— 长 URL/连接串是合法的单个值, 该照常画方框 (此前误伤过)。
  const ragged = table.rows.some(row => row.length !== table.header.length);
  if (ragged && table.raw) {
    return chalk.dim(table.raw.trimEnd()) + EOL;
  }
  const n = widths.length;
  const budget = tableMaxWidth - (1 + 3 * n);
  if (widths.reduce((a, b) => a + b, 0) > budget) {
    const amount = widths.map((_, col) =>
      [cellPlain(table.header[col]), ...table.rows.map(r => cellPlain(r[col]))].reduce((s, c) => s + getStringWidth(c), 0));
    const natural = widths.slice();
    let flex = natural.map((_, i) => i);
    let avail = budget;
    for (let guard = 0; guard < n; guard++) {
      const total = flex.reduce((s, i) => s + amount[i]!, 0) || 1;
      /* 短列 (≤16 列, 或不超过平均份额) 一律给足自然宽度 —— "DATABASE_URL" 这种一个词的列按比例分会被切成 "DATABASE_UR / L" */
      const even = Math.min(16, Math.floor(avail / flex.length));
      const fits = flex.filter(i => natural[i]! <= Math.max(even, Math.floor(avail * amount[i]! / total)));
      if (fits.length === 0) break;
      for (const i of fits) { widths[i] = natural[i]!; avail -= natural[i]!; }
      flex = flex.filter(i => !fits.includes(i));
    }
    const total = flex.reduce((s, i) => s + amount[i]!, 0) || 1;
    for (const i of flex) widths[i] = Math.max(6, Math.floor(avail * amount[i]! / total));
    const longestWord = (col: number) => Math.max(0, ...[cellPlain(table.header[col]), ...table.rows.map(r => cellPlain(r[col]))]
      .flatMap(c => c.split(/[\s⺀-鿿豈-﫿︰-﹏＀-￯　-〿]+/)).map(w => getStringWidth(w)));
    for (const i of flex) {
      const floor = Math.min(longestWord(i), Math.floor(budget * 0.3));
      const need = floor - widths[i]!;
      if (need <= 0) continue;
      const donor = flex.filter(j => j !== i).sort((a, b) => widths[b]! - widths[a]!)[0];
      if (donor === undefined || widths[donor]! - need < 12) continue;
      widths[i] = floor;
      widths[donor]! -= need;
    }
  }
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    let wi = 0;
    for (let i = 1; i < n; i++) if (widths[i]! > widths[wi]!) wi = i;
    if (widths[wi]! <= 6) break;  // 已经窄到头了, 放弃收窄 (宁可让终端折, 也不把字挤成一列一个)
    widths[wi]! -= 1;
  }

  const border = (left: string, joint: string, right: string): string =>
    left + widths.map(w => '─'.repeat(w + 2)).join(joint) + right + EOL;

  /** 一行表格: 每格按列宽折行, 行高 = 最高那格 */
  const row = (cells: Array<{ styled: string; col: number }>): string => {
    const wrapped = cells.map(({ styled, col }) => {
      const w = widths[col]!;
      return getStringWidth(stripAnsi(styled)) <= w ? [styled] : wrapCJK(styled, w).split('\n');
    });
    const h = Math.max(1, ...wrapped.map(l => l.length));
    let out = '';
    for (let r = 0; r < h; r++) {
      let line = '│ ';
      wrapped.forEach((lines, i) => {
        const s = lines[r] ?? '';
        line += alignCell(s, getStringWidth(stripAnsi(s)), widths[cells[i]!.col]!, table.align?.[cells[i]!.col]) + ' │ ';
      });
      out += line.trimEnd() + EOL;
    }
    return out;
  };

  const headerRow = row(table.header.map((head, col) => ({ styled: chalk.bold(cellPlain(head)), col })));
  const bodyRows = table.rows.map(cells => row(cells.map((cell, col) => ({ styled: renderChildren(cell.tokens, ROOT_CTX), col }))));

  return border('┌', '┬', '┐')
    + headerRow
    + border('├', '┼', '┤')
    + bodyRows.join('')
    + border('└', '┴', '┘')
    + EOL;
}

/** 渲染单个 marked token (对外保留的位置参数签名, 内部统一走 RenderCtx)。 */
export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  return renderToken(token, { depth: listDepth, ordinal: orderedListNumber, parent });
}

// ─── 表格分隔行修复 ───────────────────────────────────────────────
// 模型有时把分隔行写歪 (如 `|---不用轮|------|`, 混进了文字) → GFM 不认 → 整张表渲成裸竖线。
// 这里保守地把"上一行是表头(2+竖线) + 本行像分隔行(含竖线和横杠、且大部分是 -|: 空格)"的
// 行规整成合法分隔行 `|---|---|`, 让 marked 能解析成表 (混进分隔行的杂字本就是噪音, 丢掉无妨)。
function normalizeTableDelimiters(md: string): string {
  const lines = md.split('\n');
  const isValidDelim = (l: string) => /^\s*\|?[\s\-:|]+\|?\s*$/.test(l) && l.includes('-');
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const prevPipes = (prev.match(/\|/g) || []).length;
    if (prevPipes < 2 || !cur.includes('|') || !cur.includes('-')) continue;
    if (isValidDelim(cur)) continue; // 已经合法, 不动
    const nonSpace = cur.replace(/\s/g, '');
    const delimChars = (cur.match(/[-|:]/g) || []).length;
    // 仅当本行"绝大部分"是分隔字符 (≥60%) 才判定为写歪的分隔行, 避免误伤正文
    if (nonSpace.length === 0 || delimChars / nonSpace.length < 0.6) continue;
    const cellCount = Math.max(1, prev.split('|').filter(s => s.trim() !== '').length);
    lines[i] = '|' + Array(cellCount).fill('---').join('|') + '|';
  }
  return lines.join('\n');
}

// ─── applyMarkdown —— 顶层入口 ───────────────────────────────────
export function applyMarkdown(content: string): string {
  configureMarked();
  // 预处理：① 修复标题缺少空格 ② 修复写歪的表格分隔行
  let preprocessed = content.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');
  preprocessed = normalizeTableDelimiters(preprocessed);
  return marked
    .lexer(preprocessed)
    .map(t => formatToken(t))
    .join('')
    // ③ 收掉多余空行: 3+ 连续换行 → 至多一个空行, 整体更紧凑不松散
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── 流式不完整表格检测 ───────────────────────────────────────────
function hasIncompleteTable(content: string): { hasTable: boolean; isComplete: boolean; tableStart: number } {
  const lines = content.split('\n');
  let tableStart = -1;
  let hasHeaderSeparator = false;
  let dataRowCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('|')) {
      if (tableStart === -1) tableStart = i;
      if (/^\|?[\s\-:|]+\|[\s\-:|]*\|?$/.test(line)) {
        hasHeaderSeparator = true;
      } else if (hasHeaderSeparator) {
        dataRowCount++;
      }
    } else if (tableStart !== -1 && line === '') {
      break;
    }
  }

  if (tableStart === -1) {
    return { hasTable: false, isComplete: true, tableStart: -1 };
  }

  const lastLine = lines[lines.length - 1].trim();
  const endsWithTableRow = lastLine.includes('|');
  const isComplete = hasHeaderSeparator && dataRowCount >= 1 && !endsWithTableRow;
  return { hasTable: true, isComplete, tableStart };
}

// ─── renderMarkdown ───────────────────────────────────────────────
export function renderMarkdown(content: string, streaming: boolean = false): string {
  try {
    // Render streaming tables as raw pipe text because incomplete rows cannot
    // form a stable grid; convert them after the message completes.
    tablesAsRaw = streaming;
    // 终端列宽 - 留 4 列给卡片左右内边距; 拿不到 (非 TTY) 退 120。
    tableMaxWidth = Math.max(40, (process.stdout.columns || 120) - 4);
    contentWidth = Math.max(20, (process.stdout.columns || 120) - 2);
    const preprocessed = content.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');
    return applyMarkdown(preprocessed);
  } catch {
    return content;
  } finally {
    tablesAsRaw = false;
  }
}
