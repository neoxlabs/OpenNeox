/**
 * 把模型写的各种公式写法归一成 remark-math 认的形状 (它只开了 $$…$$)。
 *
 * - 单独占一行的 `$$…$$` → 上下各起一行的块级公式。写在一行里 remark-math 会当行内公式,
 *   分式被压成文本尺寸, 还会跟段落里的下一行叠在一起。
 * - `\[…\]` → 块级, `\(…\)` → 行内。
 * - 单 `$…$`: 只有长得像公式才转成行内 `$$…$$`, 金额 ("固定 $50, 另收 $12") 原样留着。
 * - 公式内没转义的 `%` 补成 `\%`: TeX 里 `%` 是注释, 会把后半段公式吞掉。
 *
 * 围栏代码块和行内代码不动。
 */

const CJK_RE = /[　-〿㐀-鿿＀-￯]/;
/** 像公式的信号: TeX 命令、上下标、运算/关系符号、括号。 */
const MATH_SIGNAL_RE = /\\[a-zA-Z]+|[\^_=+*/<>|()]|\d\s*-\s*\d|^[a-zA-Z]$|^[-−]?\d+(\.\d+)?$/;
/** 数字后面挂着分隔符 ("5-", "1,200,") 是金额区间的前半截, 不是公式。 */
const MONEY_RE = /^[\d.,]+\s*[-–~,]$/;

const escapePercent = (tex: string): string => tex.replace(/(^|[^\\])%/g, '$1\\%');

const looksLikeInlineMath = (body: string): boolean => {
  if (!body || /^\s|\s$/.test(body)) return false;
  if (CJK_RE.test(body)) return false;
  if (MONEY_RE.test(body)) return false;
  return MATH_SIGNAL_RE.test(body);
};

/** 行内段落 (已排除代码): 处理 \(…\) 与单 $…$。已有的 $$…$$ 只补 %。 */
const normalizeInline = (text: string): string => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '$') {
      out += '\\$';
      i += 2;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '(') {
      const end = text.indexOf('\\)', i + 2);
      if (end > i + 2) {
        out += `$$${escapePercent(text.slice(i + 2, end).trim())}$$`;
        i = end + 2;
        continue;
      }
    }
    if (ch === '$' && text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      if (end > i + 2) {
        out += `$$${escapePercent(text.slice(i + 2, end))}$$`;
        i = end + 2;
        continue;
      }
      out += '$$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      const end = text.indexOf('$', i + 1);
      /* 收尾的 $ 后面紧跟数字 ("$5 到 $10" 的第二个 $) 不算闭合 */
      if (end > i + 1 && text[end + 1] !== '$' && !/\d/.test(text[end + 1] ?? '')) {
        const body = text.slice(i + 1, end);
        if (!body.includes('\n') && looksLikeInlineMath(body)) {
          out += `$$${escapePercent(body)}$$`;
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
};

/** 非围栏文本: 先拆行内代码, 其余交给 normalizeInline。 */
const normalizeProse = (text: string): string =>
  text
    .split(/(`+[^`\n]*?`+)/g)
    .map((part, idx) => (idx % 2 === 1 ? part : normalizeInline(part)))
    .join('');

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

export function normalizeMath(markdown: string): string {
  if (!/[$\\]/.test(markdown)) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let prose: string[] = [];
  let block: string[] | null = null;
  let blockRaw: string[] = [];
  let blockClose = '';

  const flushProse = () => {
    if (prose.length) out.push(normalizeProse(prose.join('\n')));
    prose = [];
  };
  /* 缩进跟着原行走, 列表项里的公式仍属于那个列表项 */
  let indent = '';
  const pushBlock = (body: string) => {
    flushProse();
    out.push('', `${indent}$$`, `${indent}${escapePercent(body.trim())}`, `${indent}$$`, '');
  };

  for (const line of lines) {
    if (fence) {
      out.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (block) {
      blockRaw.push(line);
      const idx = line.indexOf(blockClose);
      if (idx >= 0 && line.slice(idx + blockClose.length).trim() === '') {
        block.push(line.slice(0, idx));
        pushBlock(block.join('\n'));
        block = null;
      } else {
        block.push(line);
      }
      continue;
    }
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      flushProse();
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    const t = line.trim();
    indent = /^\s*/.exec(line)![0];
    /* 一整行就是一个公式: $$…$$ 或 \[…\] */
    const single = /^\$\$(.+)\$\$$/.exec(t) ?? /^\\\[(.+)\\\]$/.exec(t);
    if (single && !single[1].includes('$$')) {
      pushBlock(single[1]);
      continue;
    }
    /* 多行块的开头: 单独一行 $$ / \[, 或 $$ 后面接着正文 */
    const open = /^(\$\$|\\\[)(.*)$/.exec(t);
    if (open && !open[2].includes(open[1] === '$$' ? '$$' : '\\]')) {
      flushProse();
      block = open[2] ? [open[2]] : [];
      blockRaw = [line];
      blockClose = open[1] === '$$' ? '$$' : '\\]';
      continue;
    }
    prose.push(line);
  }
  if (block) {
    /* 流式中途还没收尾: 原样放回, 等下一帧 */
    prose.push(...blockRaw);
  }
  flushProse();
  return out.join('\n').replace(/^\n+/, '');
}
