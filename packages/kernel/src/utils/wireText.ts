/**
 * Neox Wire Text — 发给 LLM / 严格 JSON 上游之前的字符串契约.
 *
 * =============================================================================
 * 为什么要有「自己的方案」()
 * =============================================================================
 * JS string 是 UTF-16. 裸 `s.slice(0, N)` 会切断 emoji 代理对 → JSON.stringify
 * 产出 `\ud83d` 孤立 escape → ECMAScript JSON.parse 仍绿, Anthropic/RFC8259 直接
 * 400 "lone leading surrogate". Codex/OpenClaw 后来用 `truncateUtf16Safe` 扫 call
 * site; 我们不跟抄散点修复, 定三条硬规则:
 *
 *   R1 截断: 只许走本模块的 truncate* / takeTail* / truncateMiddle*
 *       (禁止在 LLM-bound 路径裸 slice; 旧「UTF-8 continuation bit」探测作废)
 *   R2 出口: 进供应商 body 前必须 sanitizeUnicodeDeep (runner 收口 + 本模块)
 *   R3 验收: 回归用 assertStrictJsonSafe, 禁止用 JSON.parse(JSON.stringify)
 *       当「供应商会收」的证明
 *
 * 预算语义: 仍按 UTF-16 code unit 计数 (与既有 length/阈值兼容), 仅在边界回退
 * 1 unit 避免切断 surrogate pair. 不改成 code-point 预算, 避免阈值静默缩水.
 */

// ─── well-formed ────────────────────────────────────────────────────────────

/** 孤立 UTF-16 surrogate → U+FFFD. */
export function toWellFormedString(input: string): string {
  if (!input) return input;
  if (typeof (input as string & { toWellFormed?: () => string }).toWellFormed === 'function') {
    return (input as string & { toWellFormed: () => string }).toWellFormed();
  }
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += input[i]! + input[i + 1]!;
        i++;
      } else {
        out += '\uFFFD';
      }
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      out += '\uFFFD';
    } else {
      out += input[i]!;
    }
  }
  return out;
}

export function hasLoneSurrogate(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

// ─── slice / truncate (UTF-16 unit budget, surrogate-safe edges) ─────────────

/** [start, end) — end 落在 high 上则回退; start 落在 low 上则前进. */
export function sliceUtf16Safe(input: string, start = 0, end = input.length): string {
  let s = Math.max(0, Math.min(start, input.length));
  let e = Math.max(s, Math.min(end, input.length));
  if (s < input.length && input.charCodeAt(s) >= 0xDC00 && input.charCodeAt(s) <= 0xDFFF) {
    s += 1;
  }
  if (e > s) {
    const last = input.charCodeAt(e - 1);
    if (last >= 0xD800 && last <= 0xDBFF) e -= 1;
  }
  return input.slice(s, Math.max(s, e));
}

export function truncateUtf16Safe(input: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (input.length <= maxUnits) return input;
  return sliceUtf16Safe(input, 0, maxUnits);
}

export function takeUtf16SafeTail(input: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (input.length <= maxUnits) return input;
  return sliceUtf16Safe(input, input.length - maxUnits, input.length);
}

export interface TruncateMiddleOptions {
  /** 总 UTF-16 unit 预算 (头+尾+marker 之外的内容预算口径与历史 truncateToolOutput 一致:
   *  头尾各 floor(max*0.4), marker 另加). */
  maxUnits: number;
  headRatio?: number;
  tailRatio?: number;
  marker?: string | ((info: { removedChars: number; totalChars: number; totalLines: number }) => string);
}

/**
 * 头尾保留、中间替换 marker. LLM tool-result / snip 的标准截断.
 * 边界保证 well-formed; 输出再过一遍 toWellFormed 防输入本身已脏.
 */
export function truncateMiddleUtf16Safe(input: string, opts: TruncateMiddleOptions): string {
  const maxUnits = opts.maxUnits;
  if (!input || input.length <= maxUnits) return input;

  const headRatio = opts.headRatio ?? 0.4;
  const tailRatio = opts.tailRatio ?? 0.4;
  const headBudget = Math.floor(maxUnits * headRatio);
  const tailBudget = Math.floor(maxUnits * tailRatio);

  const head = truncateUtf16Safe(input, headBudget);
  const tail = takeUtf16SafeTail(input, tailBudget);
  const removedChars = Math.max(0, input.length - head.length - tail.length);
  const totalLines = input.split('\n').length;

  const marker =
    typeof opts.marker === 'function'
      ? opts.marker({ removedChars, totalChars: input.length, totalLines })
      : opts.marker ??
        `\n\n…[${removedChars} chars truncated in middle, total ${totalLines} lines] ` +
          `— 用 readfile(path, start_line=N, num_lines=M) 或 search(pattern=...) 取回具体片段。…\n\n`;

  return toWellFormedString(head + marker + tail);
}

// ─── deep sanitize (LLM wire) ───────────────────────────────────────────────

/**
 * 递归清洗 JSON 树字符串字段. runner 发请求前的收口点.
 * 跳过非 plain object (Date/Map/Buffer…); LLM payload 全是 plain data.
 */
export function sanitizeUnicodeDeep<T>(value: T): T {
  if (typeof value === 'string') return toWellFormedString(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = sanitizeUnicodeDeep(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = sanitizeUnicodeDeep(v);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/** runner / provider 共用: messages → 可上电线. */
export function prepareMessagesForWire<T>(messages: T): T {
  return sanitizeUnicodeDeep(messages);
}

// ─── strict JSON acceptance (≠ JS JSON.parse) ───────────────────────────────

const LONE_SURROGATE_ESCAPE =
  /\\u[Dd][89ABab][0-9A-Fa-f]{2}(?!\\u[Dd][C-Fc-f][0-9A-Fa-f]{2})/;

export function isStrictJsonSafe(value: unknown): boolean {
  try {
    const body = JSON.stringify(value);
    if (body == null) return false;
    return !LONE_SURROGATE_ESCAPE.test(body);
  } catch {
    return false;
  }
}

export function assertStrictJsonSafe(value: unknown, label = 'payload'): void {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch (err: any) {
    throw new Error(`${label}: not JSON-serializable: ${err?.message || err}`);
  }
  if (body == null) throw new Error(`${label}: not JSON-serializable`);
  const m = body.match(LONE_SURROGATE_ESCAPE);
  if (m) {
    const idx = body.indexOf(m[0]!);
    const around = body.slice(Math.max(0, idx - 40), idx + 40);
    throw new Error(
      `${label}: lone surrogate escape ${m[0]} (strict JSON would 400). around=…${around}…`,
    );
  }
}
