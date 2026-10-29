
import { coerceDsmlArg } from './dsmlToolCalls.js';

export interface ParsedXmlToolCall {
  name: string;
  /** 已经序列化好的 JSON, 直接就是 tool_calls[].function.arguments */
  arguments: string;
}

export interface XmlToolCallParseResult {
  calls: ParsedXmlToolCall[];
  /** 摘掉调用区段之后剩下的正文 */
  text: string;
  /** 见到过调用标记但没解析出完整调用 (或只解析出一部分) */
  sawIncomplete: boolean;
}

/** 调用标记 —— 只认这几种名字, 不拿通配吞 `<content>` 这类普通标签。 */
const MARKER = /<\/?(?:antml:)?(?:invoke|parameter|function_calls|tool_calls|tool_call|function_call|tool_use)\b[^>]*>/gi;
/** 最后一个标记之后允许残留的东西: 空白 + 闭合外壳。 */
const TRAILER = /^(?:\s*<\/?(?:antml:)?(?:content|result|output|function_calls|tool_calls|tool_call|function_call|invoke|tool_use|parameter|parameters|arguments)\s*>)*\s*$/i;
/** 带 name 的调用开标签。 */
const INVOKE_OPEN = /<(?:antml:)?(invoke|tool_call|function_call|tool_use)\b([^>]*)>/gi;
const OPEN_WRAPPER = /<(?:antml:)?(?:content|result|output|parameters|arguments)\b[^>]*>\s*$/i;
const NAME_ATTR = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const PARAM = /<(?:antml:)?parameter\s+([^>]*)>([\s\S]*?)<\/(?:antml:)?parameter\s*>/gi;
const STRING_ATTR = /\bstring\s*=\s*(?:"(true|false)"|'(true|false)')/i;

/** 最后一个空行之后的位置 —— 标记必须出现在这之后才算"在回答末尾"。 */
function lastParagraphStart(src: string): number {
  const re = /\n[ \t]*\n/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) last = m.index + m[0].length;
  return last < 0 ? 0 : last;
}

/** 代码块 (``` / ~~~) 覆盖的区间; 未闭合的开围栏算到文末。 */
function fencedRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { ch: string; len: number; start: number } | null = null;
  let pos = 0;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    const line = src.slice(pos, lineEnd);
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const fence = m[1]!;
      if (!open) open = { ch: fence[0]!, len: fence.length, start: pos };
      else if (open.ch === fence[0] && fence.length >= open.len) {
        ranges.push([open.start, lineEnd]);
        open = null;
      }
    }
    if (nl === -1) break;
    pos = lineEnd + 1;
  }
  if (open) ranges.push([open.start, src.length]);
  return ranges;
}

/** 从属性串里取 `name="…"` 的值。 */
function attrName(attrs: string): string | null {
  const m = NAME_ATTR.exec(attrs);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim();
}

/**
 * 从助手正文里抽出 XML 形态的工具调用。
 *
 * 没有任何候选标记时原样返回 (几段 cheap 正则), 所以可以无条件调用。
 */
export function parseXmlToolCalls(content: string): XmlToolCallParseResult {
  const src = content ?? '';
  if (!src) return { calls: [], text: src, sawIncomplete: false };

  const fences = fencedRanges(src);
  const inFence = (i: number) => fences.some(([s, e]) => i >= s && i < e);
  const tailStart = lastParagraphStart(src);

  /* 1) 收集尾部、代码块外的标记。一个都没有 → 不是调用, 原样返回。 */
  const marks: Array<{ index: number; end: number }> = [];
  const markerRe = new RegExp(MARKER.source, 'gi');
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(src)) !== null) {
    if (mm.index < tailStart || inFence(mm.index)) continue;
    marks.push({ index: mm.index, end: mm.index + mm[0].length });
  }
  if (marks.length === 0) return { calls: [], text: src, sawIncomplete: false };

  /* 2) 标记必须一直延伸到回答末尾, 否则是在正常讨论 / 引用, 不碰。 */
  let regionStart = marks[0]!.index;
  const lastEnd = marks[marks.length - 1]!.end;
  if (!TRAILER.test(src.slice(lastEnd))) return { calls: [], text: src, sawIncomplete: false };

  for (;;) {
    const w = OPEN_WRAPPER.exec(src.slice(0, regionStart));
    if (!w) break;
    regionStart = w.index;
  }

  /* 3) 解析调用区段。已经吃掉一块就从它后面继续, 避免参数值里的 `<invoke …>` 被当成第二个调用。 */
  const region = src.slice(regionStart);
  const calls: ParsedXmlToolCall[] = [];
  let sawIncomplete = false;
  const openRe = new RegExp(INVOKE_OPEN.source, 'gi');
  let cursor = 0;
  for (;;) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(region);
    if (!open) break;
    const tag = open[1]!;
    const name = attrName(open[2] ?? '');
    const bodyStart = open.index + open[0].length;
    /* 没有 name 或没有闭合标签 → 截断, 后面不可信, 直接停。 */
    if (!name) { sawIncomplete = true; break; }
    const closeRe = new RegExp(`</(?:antml:)?${tag}\\s*>`, 'i');
    const close = closeRe.exec(region.slice(bodyStart));
    if (!close) { sawIncomplete = true; break; }

    const body = region.slice(bodyStart, bodyStart + close.index);
    const args: Record<string, unknown> = {};
    const paramRe = new RegExp(PARAM.source, 'gi');
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      const pName = attrName(p[1] ?? '');
      if (!pName) continue;
      const s = STRING_ATTR.exec(p[1] ?? '');
      args[pName] = coerceDsmlArg(p[2]!, s ? (s[1] ?? s[2]) : undefined);
    }
    /* 有开有闭但一个参数都没解析出来, 却明明写着 parameter —— 格式又变了, 不猜。 */
    if (Object.keys(args).length === 0 && /parameter/i.test(body)) {
      sawIncomplete = true;
      break;
    }
    calls.push({ name, arguments: JSON.stringify(args) });
    cursor = bodyStart + close.index + close[0].length;
  }

  if (calls.length === 0) sawIncomplete = true;

  /* 调用区段在末尾 (trailer 只允许闭合外壳), 所以把它整段从正文里摘掉即可。 */
  return { calls, text: src.slice(0, regionStart).trimEnd(), sawIncomplete };
}
