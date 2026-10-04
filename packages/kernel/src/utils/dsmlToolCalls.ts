/**
 * 将 DSML 文本形式的工具调用转换为结构化调用。
 * 只接受完整的 invoke 块；未闭合或无法解析参数的片段标记为不完整。
 */

/** 分隔符是全角竖线 U+FF5C, 而且见过写两遍的 (`<｜｜DSML｜｜tool_calls>`)。 */
const BAR = '[｜|]{1,2}';
const OPEN_INVOKE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>`, 'g');
const CLOSE_INVOKE = new RegExp(`</${BAR}DSML${BAR}invoke\\s*>`);
const PARAM = new RegExp(
  `<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter\\s*>`,
  'g',
);
/** 整段的外壳 —— 连同它一起从正文里摘掉, 别让残壳留在气泡里。 */
const WRAPPER = new RegExp(
  `<${BAR}DSML${BAR}tool_calls\\s*>|</${BAR}DSML${BAR}tool_calls\\s*>`,
  'g',
);
/** 只用来判断"这段文本里有没有 DSML 的影子" —— 便宜的前置检查, 不匹配就直接返回。 */
const SNIFF = new RegExp(`<${BAR}DSML${BAR}`);

export interface ParsedDsmlToolCall {
  name: string;
  /** 已经序列化好的 JSON, 直接就是 tool_calls[].function.arguments */
  arguments: string;
}

export interface DsmlParseResult {
  /** 解析出的调用; 一个都没有时是空数组 */
  calls: ParsedDsmlToolCall[];
  /** 摘掉 DSML 之后剩下的正文 (模型有时会在标记前后说人话, 那部分要留着) */
  text: string;
  /** 见到过 DSML 标记但没能解析出完整调用 —— 调用方据此判断"这轮废了, 别把残骸给用户" */
  sawIncomplete: boolean;
}

/** `string="false"` 的值按 JSON 解析 (布尔/数字/对象); 解析不了就当字符串, 不丢信息。 */
function coerce(raw: string, isString: string | undefined): unknown {
  if (isString === 'true') return raw;
  const trimmed = raw.trim();
  if (isString === 'false' || /^(true|false|null|-?\d|[[{"])/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { /* 不是合法 JSON 就按字符串走 */ }
  }
  return raw;
}

/**
 * 从助手正文里抽出 DSML 形态的工具调用。
 *
 * 没有 DSML 痕迹时原样返回 (零开销), 所以可以无条件调用。
 */
export function parseDsmlToolCalls(content: string): DsmlParseResult {
  const src = content ?? '';
  if (!src || !SNIFF.test(src)) {
    return { calls: [], text: src, sawIncomplete: false };
  }

  const calls: ParsedDsmlToolCall[] = [];
  let sawIncomplete = false;
  /* 逐个 invoke 扫: 每找到一个开标签, 就在它后面找**最近的**结束标签。
   * 找不到 = 这个调用被截断了, 记一笔然后停 —— 后面的内容都在截断线之外, 不可信。 */
  const openRe = new RegExp(OPEN_INVOKE.source, 'g');
  const consumed: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(src)) !== null) {
    const name = m[1]!;
    const bodyStart = m.index + m[0].length;
    const rest = src.slice(bodyStart);
    const closeMatch = CLOSE_INVOKE.exec(rest);
    if (!closeMatch) {
      sawIncomplete = true;
      consumed.push([m.index, src.length]);
      break;
    }
    const body = rest.slice(0, closeMatch.index);
    const args: Record<string, unknown> = {};
    const paramRe = new RegExp(PARAM.source, 'g');
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      args[p[1]!] = coerce(p[3]!, p[2]);
    }
    /* 有开有闭但一个参数都没解析出来 —— 多半是格式又变了。当作不完整, 不猜。 */
    if (Object.keys(args).length === 0 && body.includes('parameter')) {
      sawIncomplete = true;
    } else {
      calls.push({ name, arguments: JSON.stringify(args) });
    }
    consumed.push([m.index, bodyStart + closeMatch.index + closeMatch[0].length]);
  }

  /* 从正文里摘掉已消费的区段 + 外层 tool_calls 壳, 剩下的才是模型说的人话。 */
  let text = '';
  let cursor = 0;
  for (const [s, e] of consumed) {
    text += src.slice(cursor, s);
    cursor = e;
  }
  text += src.slice(cursor);
  text = text.replace(new RegExp(WRAPPER.source, 'g'), '').trim();

  if (calls.length === 0 && consumed.length === 0) {
    /* 有 DSML 痕迹却连一个 invoke 开标签都没匹配上 —— 也算不完整, 别静默放行残骸 */
    sawIncomplete = true;
  }

  return { calls, text, sawIncomplete };
}
