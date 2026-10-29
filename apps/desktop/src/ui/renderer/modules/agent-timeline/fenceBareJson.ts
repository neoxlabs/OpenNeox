
const MIN_LEN = 120;
const KEY_RE = /"[^"\n]+"\s*:/;
/** 开头就是 `[{"` / `{"` / `[[`… 这种形状 —— 用来判"解析不了但确实是 JSON" */
const LOOKS_LIKE_JSON = /^[[{]\s*[[{]?\s*"/;

const FRAG_MIN_LEN = 200;
const FRAG_MIN_KEYS = 6;
const KEY_G = /"[^"\n]{1,64}"\s*:/g;

function fenceJsonFragments(input: string): string {
  const blocks = input.split(/\n{2,}/);
  let touched = false;
  const out = blocks.map((b) => {
    const t = b.trim();
    if (t.length < FRAG_MIN_LEN) return b;
    if (/^[ \t]*(?:```|~~~)/m.test(b)) return b;   // 已经有围栏
    /* 段落里**任意一行**顶格出现 { 或 [ 就归主扫描管 —— 主扫描对"顶层不闭合"有明确
     * 决定: 整段原样当正文, 绝不退化成逐个小对象包框。兜底不能推翻那条决定。 */
    if (/^[ \t]*[[{]/m.test(t)) return b;
    const keys = (t.match(KEY_G) || []).length;
    if (keys < FRAG_MIN_KEYS) return b;
    const quotes = (t.match(/"/g) || []).length;
    if (quotes < keys * 2) return b;
    touched = true;
    /* 不重排缩进: 碎片 parse 不出来。原样进代码块已经够了 —— 至少它不再是正文。 */
    return `\`\`\`json\n${t}\n\`\`\``;
  });
  return touched ? out.join('\n\n') : input;
}

/** 从 start 处扫一段配平的 JSON, 返回结束位置 (不含); 未闭合返回 -1. */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** 行首偏移集合 (含 0), 用来判断候选是否顶格. */
function isLineStart(text: string, i: number): boolean {
  if (i === 0) return true;
  for (let k = i - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

export function fenceBareJson(input: string, streaming = false): string {
  if (!input || (!input.includes('{') && !input.includes('[') && !input.includes('":'))) return input;
  // 已有围栏的区间整段跳过 (含未闭合的 streaming 尾巴)
  const skips: Array<[number, number]> = [];
  const fence = /^[ \t]*(?:```|~~~)/gm;
  let m: RegExpExecArray | null;
  let open: number | null = null;
  while ((m = fence.exec(input))) {
    if (open === null) open = m.index;
    else {
      skips.push([open, fence.lastIndex]);
      open = null;
    }
  }
  if (open !== null) skips.push([open, input.length]);
  const inSkip = (i: number) => skips.some(([a, b]) => i >= a && i < b);

  let out = '';
  let cursor = 0;
  for (let i = 0; i < input.length; i++) {
    if (i < cursor) continue;
    const ch = input[i];
    if (ch !== '[' && ch !== '{') continue;
    if (inSkip(i) || !isLineStart(input, i)) continue;

    let end = scanBalanced(input, i);
    let truncated = false;
    if (end < 0) {
      if (!streaming) break;
      end = input.length;
      truncated = true;
    }
    const body = input.slice(i, end);
    if (body.length < MIN_LEN || !KEY_RE.test(body)) { i = end - 1; continue; }

    let rendered = body;
    if (!truncated) {
      try {
        /* 解析成功顺手重排缩进 —— 模型甩过来的是一整行压扁的 JSON, 原样进代码块
         * 也是一条横到天边的长龙, 得靠横向滚动才看得完。 */
        rendered = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        if (!LOOKS_LIKE_JSON.test(body) || (body.match(/"\s*:/g) || []).length < 3) {
          i = end - 1; // 真不像 JSON: 跳过整段, 同样不往里钻
          continue;
        }
      }
    }
    out += input.slice(cursor, i);
    const nl = out.length && !out.endsWith('\n') ? '\n' : '';
    out += `${nl}\n\`\`\`json\n${rendered}\n\`\`\`\n`;
    cursor = end;
    i = end - 1;
  }
  /* 主扫描一个候选都没命中 —— 可能是 JSON 从中间开始, 交给碎片兜底再看一眼 */
  if (!cursor) return fenceJsonFragments(input);
  return out + input.slice(cursor);
}
