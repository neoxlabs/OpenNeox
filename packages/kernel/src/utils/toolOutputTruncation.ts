/**
 * Tool output truncation — Neox 唯一实现.
 *
 * 所有平台统一使用 wireText 的 UTF-16 安全中段截断, 避免在代理项边界切分文本。
 */

import { truncateMiddleUtf16Safe, truncateUtf16Safe, takeUtf16SafeTail, toWellFormedString } from './wireText.js';

/** 默认 tool output 预算 (~16k code units). */
export const TOOL_OUTPUT_MAX_BYTES = 16_000;

/** Anthropic / 紧代理更保守. */
export const ANTHROPIC_TOOL_OUTPUT_MAX_BYTES = 15_000;

/**
 * 发线 (组请求体) 时 tool 结果的上限 —— 只防失控。
 *
 * runner 根据模型窗口控制工具结果预算, 本层使用同一上限约束最终请求体, 使账本记录
 * 与模型实际收到的内容一致。
 */
export const WIRE_TOOL_OUTPUT_MAX_UNITS = 160_000;

export const REQUEST_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const REQUEST_BODY_WARNING_THRESHOLD = 1.5 * 1024 * 1024;

const DEFAULT_MARKER = (info: {
  removedChars: number;
  totalChars: number;
  totalLines: number;
}) =>
  `\n\n…[${info.removedChars} chars truncated in middle, total ${info.totalLines} lines] ` +
  `— 如需完整内容, 用 readfile(path, start_line=N, num_lines=M) 按行范围读, ` +
  `或 search(pattern=..., path=..) 精准定位关键片段。…\n\n`;

/* ────────────────────────────────────────────────────────────────────────────
 * 错误行对齐截断
 *
 * 头尾各留 40% 的老策略把**中段整个丢掉**, 而测试失败、编译报错、stack trace
 * 恰恰最常落在中段 (前面是命令回显与进度, 后面是汇总行)。模型看不到失败真相,
 * 就只能凭汇总行猜, 于是重跑/乱改 —— 这是空转的一大来源。
 *
 * 现在: 截断前先扫"失败证据行", 命中就把保留窗口往错误簇上对齐;
 * 没命中则完全走老路径 (行为不变)。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 失败证据关键词 — 要求成词, 避免 "errorHandler" / "failsafe" 这类命名误伤。 */
const ERROR_LINE_RE =
  /(?:^|[\s[({<"'|:])(?:error|errors|failed|failing|failure|failures|exception|traceback|fatal|panic|assertionerror|segfault)(?:[\s\]})>"':,.]|$)|\bE\d{3,}\b|^\s*at\s+\S+\s*\(.+:\d+:\d+\)/i;

/** "零失败"表述 — 汇总行里的 `0 errors` / `failures: 0` 不算证据。 */
const ZERO_FAILURE_RE = /\b(?:0|no)\s+(?:errors?|failures?|failed|problems?)\b|\b(?:errors?|failures?|failed)\s*[:=]\s*0\b/i;

/** 单行超过这个长度多半是 base64 / minified / 数据行, 不是人读的错误摘要。 */
const MAX_ERROR_LINE_LEN = 2000;
/** 错误行往前多留几行上下文 (通常是"哪个用例/哪个文件"). */
const ERROR_CONTEXT_LINES = 3;

function isErrorLine(line: string): boolean {
  if (!line || line.length > MAX_ERROR_LINE_LEN) return false;
  if (ZERO_FAILURE_RE.test(line)) return false;
  return ERROR_LINE_RE.test(line);
}

/**
 * 命中失败证据时返回错误对齐的截断结果; 不适用时返回 null (调用方走常规中段截断)。
 *
 * 预算: 头 15% (命令/上下文) + 错误窗口 60% + 尾 25% (汇总/退出码)。
 */
function truncateErrorAligned(content: string, maxUnits: number): string | null {
  const headBudget = Math.floor(maxUnits * 0.15);
  const tailBudget = Math.floor(maxUnits * 0.25);
  const windowBudget = maxUnits - headBudget - tailBudget;
  if (windowBudget <= 0) return null;

  const lines = content.split('\n');
  /* 行首偏移 —— 行边界永远不会落在 surrogate pair 中间, 可安全 slice */
  let firstErrorLine = -1;
  let offset = 0;
  const lineOffsets: number[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    if (firstErrorLine < 0 && isErrorLine(lines[i])) firstErrorLine = i;
    offset += lines[i].length + 1;
  }
  if (firstErrorLine < 0) return null;

  const anchorLine = Math.max(0, firstErrorLine - ERROR_CONTEXT_LINES);
  const windowStart = lineOffsets[anchorLine];

  /* 错误已经落在常规头/尾保留区里 → 老策略本来就能带上它, 不必特殊处理 */
  if (windowStart < headBudget) return null;
  const tailStart = content.length - tailBudget;
  if (windowStart >= tailStart) return null;

  const window = truncateUtf16Safe(
    content.slice(windowStart, Math.min(windowStart + windowBudget, tailStart)),
    windowBudget,
  );
  if (!window) return null;

  const head = truncateUtf16Safe(content, headBudget);
  const tail = takeUtf16SafeTail(content, tailBudget);
  const removed = Math.max(0, content.length - head.length - window.length - tail.length);
  /* 明确标出错误窗口, 让调用方可以直接使用已保留的失败证据。 */
  const gapOpen =
    `\n\n…[error_aligned=true · 跳过中段 ${removed} chars (全文 ${lines.length} 行)。` +
    `↓↓ 下面这段是对齐到第 ${firstErrorLine + 1} 行失败证据的窗口, ` +
    `失败原因就在其中 —— 不必重读整份输出 ↓↓]…\n\n`;
  const gapClose = `\n\n…[↑↑ 失败证据窗口结束; 下面是输出末尾 ↑↑]…\n\n`;

  return toWellFormedString(head + gapOpen + window + gapClose + tail);
}

export function truncateToolOutput(
  content: string,
  maxBytes: number = TOOL_OUTPUT_MAX_BYTES,
): string {
  if (!content || content.length <= maxBytes) return content;
  const errorAligned = truncateErrorAligned(content, maxBytes);
  if (errorAligned) return errorAligned;
  return truncateMiddleUtf16Safe(content, {
    maxUnits: maxBytes,
    headRatio: 0.4,
    tailRatio: 0.4,
    marker: DEFAULT_MARKER,
  });
}

export function needsTruncation(content: string, maxBytes: number = TOOL_OUTPUT_MAX_BYTES): boolean {
  return Boolean(content && content.length > maxBytes);
}

export function getTruncationStats(original: string, truncated: string) {
  return {
    originalSize: original.length,
    truncatedSize: truncated.length,
    savedBytes: original.length - truncated.length,
    compressionRatio: truncated.length / original.length,
    wasTruncated: original.length !== truncated.length,
  };
}

export function estimateObjectSize(obj: unknown): number {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return 0;
  }
}

export function formatResponseHeaders(headers: any, maxLength: number = 2000): string {
  const headerObj =
    headers && typeof headers.toJSON === 'function' ? headers.toJSON() : headers;
  let serialized = '';
  try {
    serialized = JSON.stringify(headerObj ?? {}, null, 2);
  } catch {
    serialized = String(headerObj ?? '');
  }
  if (!serialized) return 'No headers';
  if (serialized.length > maxLength) {
    return `${truncateUtf16Safe(serialized, maxLength)}\n...[truncated ${serialized.length - maxLength} chars]`;
  }
  return serialized;
}
