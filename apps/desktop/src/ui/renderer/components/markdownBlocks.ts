
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MATH_FENCE_RE = /^ {0,3}\$\$/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const CONTINUATION_RE = /^(?: {2,}|\t)/;
const DEFINITION_RE = /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:\s?/m;
const HTML_OPEN_RE = /^ {0,3}<(details|summary|div|section|article|aside|figure|table|thead|tbody|tr|td|th|ul|ol|li|dl|center|blockquote|pre|p|span|font)\b/i;

/** 这一行里该标签 开 - 合 的净数 (<p\b 不会误中 </p> 或 <pre) */
function netTagDepth(line: string, tag: string): number {
  const opens = (line.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
  const closes = (line.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
  return opens - closes;
}

export function splitMarkdownBlocks(md: string): string[] {
  if (!md) return [md];
  if (DEFINITION_RE.test(md)) return [md];

  const lines = md.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let inMath = false;
  let htmlTag: string | null = null;
  let htmlDepth = 0;
  let sawBlank = false;

  const flush = () => {
    if (current.length === 0) return;
    blocks.push(current.join('\n') + '\n');
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim() === '';

    if (!fence && !inMath && !htmlTag && sawBlank && !blank && current.length > 0
      && !CONTINUATION_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      flush();
    }

    current.push(line);

    if (fence) {
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      sawBlank = false;
      continue;
    }
    if (inMath) {
      if (MATH_FENCE_RE.test(line) && current.length > 1) inMath = false;
      sawBlank = false;
      continue;
    }
    if (htmlTag) {
      htmlDepth += netTagDepth(line, htmlTag);
      if (htmlDepth <= 0) htmlTag = null;
      sawBlank = false;
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) { fence = f[1]; sawBlank = false; continue; }
    if (MATH_FENCE_RE.test(line)) {
      /* 同一行开合 ($$x$$) 不算进入公式块 */
      const rest = line.trim().slice(2);
      if (!rest.includes('$$')) inMath = true;
      sawBlank = false;
      continue;
    }
    const h = HTML_OPEN_RE.exec(line);
    if (h) {
      const tag = h[1].toLowerCase();
      const depth = netTagDepth(line, tag);
      /* 这一行没把自己合上 → 进入 HTML 块, 合上之前一律不切 */
      if (depth > 0) { htmlTag = tag; htmlDepth = depth; sawBlank = false; continue; }
    }
    sawBlank = blank ? true : false;
  }

  if (current.length > 0) blocks.push(current.join('\n'));
  /* 最后一块不补换行; 前面每块补回 split 吃掉的 '\n' —— 保证拼回去逐字相同 */
  return blocks;
}
