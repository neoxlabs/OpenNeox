
import { mapOutsideCodeFences } from './mdFences';

/** 我们真正支持渲染的标签。白名单之外一律转义成字面量。 */
const ALLOWED = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'var', 'wbr',
]);

const TAG_SHAPE = /<\/?([a-zA-Z][^\s/>]*)(?:[\s/][^<>]*)?\/?>/g;

/** 一段**不含代码**的文本: 白名单外的标签形状把开头的 `<` 转义掉 */
function escapeSegment(text: string): string {
  if (!text.includes('<')) return text;
  return text.replace(TAG_SHAPE, (match, name: string) =>
    ALLOWED.has(String(name).toLowerCase()) ? match : '&lt;' + match.slice(1),
  );
}

/**
 * 按行内 code 切分后只处理非 code 部分。
 * 反引号按 CommonMark 规则配对: 开闭的反引号个数必须相同, 所以用 (`+) 捕获再找同长度的收尾。
 */
function escapeOutsideInlineCode(text: string): string {
  if (!text.includes('`')) return escapeSegment(text);
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('`', i);
    if (open === -1) { out += escapeSegment(text.slice(i)); break; }
    let runEnd = open;
    while (text[runEnd] === '`') runEnd++;
    const fence = text.slice(open, runEnd);
    const close = text.indexOf(fence, runEnd);
    /* 收尾反引号必须恰好同长度, 否则是更长的一串, 不算配对 */
    if (close === -1) { out += escapeSegment(text.slice(i)); break; }
    out += escapeSegment(text.slice(i, open));
    out += text.slice(open, close + fence.length);   /* code 原样 */
    i = close + fence.length;
  }
  return out;
}

/** HTML 注释原样保留 (rehype-raw 会正确处理, 且里面的尖括号不该被动) */
function escapeSkippingComments(text: string): string {
  if (!text.includes('<!--')) return escapeOutsideInlineCode(text);
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('<!--', i);
    if (start === -1) { out += escapeOutsideInlineCode(text.slice(i)); break; }
    out += escapeOutsideInlineCode(text.slice(i, start));
    const end = text.indexOf('-->', start + 4);
    if (end === -1) { out += text.slice(start); break; }   /* 未闭合 (流式在途) — 原样 */
    out += text.slice(start, end + 3);
    i = end + 3;
  }
  return out;
}

export function escapeUnknownHtmlTags(text: string): string {
  if (!text || !text.includes('<')) return text;
  return mapOutsideCodeFences(text, escapeSkippingComments);
}
