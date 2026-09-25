/**
 * Tool arguments parser for non-standard model outputs.
 *
 * Goals:
 * 1) Keep normal JSON fast-path
 * 2) Best-effort repair common formatting issues
 * 3) Return structured parse info for runner decisions
 */

export interface ParsedToolArguments {
  ok: boolean;
  args: Record<string, any>;
  raw: string;
  normalized: string;
  repaired: boolean;
  reason?: string;
}

type AliasRule = {
  canonical: string;
  aliases: string[];
  tools?: string[];
};

const TOOL_ARG_ALIAS_RULES: AliasRule[] = [
  { canonical: 'file_path', aliases: ['path', 'filePath', 'file'], tools: ['edit', 'write_file', 'git_blame', 'analyze_code'] },
  { canonical: 'old_string', aliases: ['old'] },
  { canonical: 'new_string', aliases: ['new'] },
  { canonical: 'change_context', aliases: ['changeContext', 'context'] },
  { canonical: 'start_line', aliases: ['startLine'] },
  { canonical: 'replace_all', aliases: ['replaceAll'] },
  { canonical: 'expected_hash', aliases: ['expectedHash', 'content_hash', 'contentHash', 'snapshot_hash', 'snapshotHash'] },
  { canonical: 'source_path', aliases: ['source', 'from', 'old_path'] },
  { canonical: 'destination_path', aliases: ['destination', 'destinationPath', 'to', 'new_path'] },
  { canonical: 'file_pattern', aliases: ['filePattern'] },
  { canonical: 'include_pattern', aliases: ['includePattern'] },
  { canonical: 'exclude_pattern', aliases: ['excludePattern'] },
  { canonical: 'file_type', aliases: ['fileType'] },
  { canonical: 'include_hidden', aliases: ['includeHidden'] },
  { canonical: 'case_insensitive', aliases: ['caseInsensitive'] },
  { canonical: 'context_lines', aliases: ['contextLines'] },
  { canonical: 'max_matches', aliases: ['maxMatches'] },
  { canonical: 'count_only', aliases: ['countOnly'] },
  { canonical: 'max_results', aliases: ['maxResults'] },
  { canonical: 'max_length', aliases: ['maxLength'] },
  { canonical: 'extract_links', aliases: ['extractLinks'] },
];

function normalizeToolName(toolName?: string): string {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (['edit_file', 'modify_file', 'patch_file'].includes(normalized)) return 'edit';
  if (['write', 'create_file'].includes(normalized)) return 'write_file';
  return normalized;
}

export function normalizeToolArgumentAliases(args: Record<string, any>, toolName?: string): Record<string, any> {
  const normalized = { ...args };
  const normalizedToolName = normalizeToolName(toolName);

  for (const rule of TOOL_ARG_ALIAS_RULES) {
    if (normalized[rule.canonical] !== undefined) {
      continue;
    }
    if (rule.tools && (!normalizedToolName || !rule.tools.includes(normalizedToolName))) {
      continue;
    }

    const matchedAlias = rule.aliases.find((alias) => normalized[alias] !== undefined);
    if (matchedAlias) {
      normalized[rule.canonical] = normalized[matchedAlias];
    }
  }

  if (
    normalizedToolName === 'call_tool'
    && normalized.name
    && normalized.args
    && typeof normalized.args === 'object'
    && !Array.isArray(normalized.args)
  ) {
    normalized.args = normalizeToolArgumentAliases(normalized.args, normalized.name);
  }

  return normalized;
}

function normalizeJsonString(input: string): string {
  return input
    .replace(/\uFEFF/g, '')                      // BOM
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')   // zero-width chars
    .replace(/[""]/g, '"')                        // smart double quotes
    .replace(/['']/g, "'")                        // smart single quotes
    .replace(/,\s*([}\]])/g, '$1')                // trailing comma before } or ]
    .replace(/([{[,])\s*,/g, '$1')                // double/leading comma after { or [
    .replace(/\r\n/g, '\n')                       // normalize CRLF
    .trim();
}

/**
 * 从第一个 `{` 起做**括号配平扫描**, 返回第一个完整的顶层对象。
 *
 * A balanced scan returns the first complete top-level object and ignores trailing
 * text or a second concatenated object.
 *
 * 扫描必须认字符串和转义, 否则 `{"s":"}"}` 会在字符串里的 `}` 上提前收尾。
 * 没配平上 (真被截断了) 返回 null, 交给截断修复那一级。
 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractJsonCandidate(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const balanced = extractBalancedObject(text);
  if (balanced) return balanced;

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  return null;
}

/** Repair unescaped quotes and raw control characters inside JSON strings.
 * The heuristic is accepted only when the repaired text parses successfully. */
function repairStringLiterals(input: string): string | null {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }

    if (ch === '"') {
      /* 往后看第一个非空白字符, 决定这个引号是"收尾"还是"内容" */
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      const next = j < input.length ? input[j]! : '';
      if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
        changed = true;
      }
      continue;
    }

    /* 字符串里的裸控制字符 —— JSON 不允许, 转义掉 */
    if (ch === '\n') { out += '\\n'; changed = true; continue; }
    if (ch === '\r') { out += '\\r'; changed = true; continue; }
    if (ch === '\t') { out += '\\t'; changed = true; continue; }
    if (ch < ' ') { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; changed = true; continue; }

    out += ch;
  }

  if (!changed) return null;
  try {
    const parsed = JSON.parse(out);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return out;
  } catch { /* 猜错了, 交给下一级 */ }
  return null;
}

function tryParseObject(raw: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, any> };
    }
    return { ok: false, error: 'arguments should be a JSON object' };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'invalid JSON' };
  }
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets/braces.
 * Handles common LLM streaming truncation where JSON is cut mid-value.
 */
function repairTruncatedJson(input: string): string | null {
  let s = input.trim();
  if (!s) return null;

  // Remove any trailing incomplete string (unmatched quote)
  // e.g. {"key":"val  ← truncated string
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    // Find last unmatched quote and truncate the incomplete value
    const lastQuote = s.lastIndexOf('"');
    // Try closing the string first
    s = s + '"';
  }

  // Remove any trailing comma or colon (invalid endings)
  s = s.replace(/[,:\s]+$/, '');

  // Count unclosed brackets and braces
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return null; // Not truncated, nothing to repair

  // Close all unclosed brackets/braces in reverse order
  const closing = stack.reverse().join('');
  const repaired = s + closing;

  // Verify it actually parses
  try {
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object') {
      return repaired;
    }
  } catch {
    // Try more aggressive repair: strip the last incomplete key-value pair
    // e.g. {"questions":[{"question":"text","options":[{"label":"A","description":"desc
    // Strip everything after the last successfully closed element
    const lastGoodComma = s.lastIndexOf(',');
    if (lastGoodComma > 0) {
      const truncated = s.substring(0, lastGoodComma);
      const stack2: string[] = [];
      let inStr2 = false;
      let esc2 = false;
      for (let i = 0; i < truncated.length; i++) {
        const ch = truncated[i];
        if (esc2) { esc2 = false; continue; }
        if (ch === '\\' && inStr2) { esc2 = true; continue; }
        if (ch === '"') { inStr2 = !inStr2; continue; }
        if (inStr2) continue;
        if (ch === '{') stack2.push('}');
        else if (ch === '[') stack2.push(']');
        else if (ch === '}' || ch === ']') {
          if (stack2.length > 0 && stack2[stack2.length - 1] === ch) stack2.pop();
        }
      }
      const closing2 = stack2.reverse().join('');
      const repaired2 = truncated + closing2;
      try {
        const parsed2 = JSON.parse(repaired2);
        if (parsed2 && typeof parsed2 === 'object') {
          return repaired2;
        }
      } catch { /* give up */ }
    }
  }

  return null;
}

export function parseToolArguments(rawArgs: string | undefined | null, toolName?: string): ParsedToolArguments {
  const raw = (rawArgs || '').trim();

  if (!raw) {
    return {
      ok: true,
      args: {},
      raw,
      normalized: '{}',
      repaired: false,
    };
  }

  const direct = tryParseObject(raw);
  if (direct.ok) {
    const normalizedArgs = normalizeToolArgumentAliases(direct.value, toolName);
    return {
      ok: true,
      args: normalizedArgs,
      raw,
      normalized: raw,
      repaired: false,
    };
  }

  const candidate = extractJsonCandidate(raw);
  const normalized = normalizeJsonString(candidate || raw);
  const repaired = tryParseObject(normalized);

  if (repaired.ok) {
    const normalizedArgs = normalizeToolArgumentAliases(repaired.value, toolName);
    return {
      ok: true,
      args: normalizedArgs,
      raw,
      normalized,
      repaired: normalized !== raw,
      reason: (direct as any).error,
    };
  }

  /* Repair string literals before truncation repair because balanced strings can still
   * be malformed. */
  const literalRepaired = repairStringLiterals(normalized);
  if (literalRepaired) {
    const lrResult = tryParseObject(literalRepaired);
    if (lrResult.ok) {
      const normalizedArgs = normalizeToolArgumentAliases(lrResult.value, toolName);
      return {
        ok: true,
        args: normalizedArgs,
        raw,
        normalized: literalRepaired,
        repaired: true,
        reason: `string_literal_repaired: ${(direct as any).error}`,
      };
    }
  }

  //  Third-level repair: fix truncated JSON (missing closing brackets)
  const truncRepaired = repairTruncatedJson(normalized);
  if (truncRepaired) {
    const truncResult = tryParseObject(truncRepaired);
    if (truncResult.ok) {
      const normalizedArgs = normalizeToolArgumentAliases(truncResult.value, toolName);
      return {
        ok: true,
        args: normalizedArgs,
        raw,
        normalized: truncRepaired,
        repaired: true,
        reason: `truncation_repaired: ${(direct as any).error}`,
      };
    }
  }

  //  Fourth-level repair: single-quoted JSON → double-quoted
  // LLMs sometimes generate {'question': 'text', 'options': ['A', 'B']}
  const singleQuoteRepaired = repairSingleQuotedJson(normalized);
  if (singleQuoteRepaired) {
    const sqResult = tryParseObject(singleQuoteRepaired);
    if (sqResult.ok) {
      const normalizedArgs = normalizeToolArgumentAliases(sqResult.value, toolName);
      return {
        ok: true,
        args: normalizedArgs,
        raw,
        normalized: singleQuoteRepaired,
        repaired: true,
        reason: `single_quote_repaired: ${(direct as any).error}`,
      };
    }
  }

  //  Fifth-level repair: unquoted keys {question: "text"} → {"question": "text"}
  const unquotedRepaired = repairUnquotedKeys(normalized);
  if (unquotedRepaired) {
    const uqResult = tryParseObject(unquotedRepaired);
    if (uqResult.ok) {
      const normalizedArgs = normalizeToolArgumentAliases(uqResult.value, toolName);
      return {
        ok: true,
        args: normalizedArgs,
        raw,
        normalized: unquotedRepaired,
        repaired: true,
        reason: `unquoted_keys_repaired: ${(direct as any).error}`,
      };
    }
  }

  //  Sixth-level repair: unquoted string VALUES {"name": search_files} → {"name": "search_files"}
  const unquotedValRepaired = repairUnquotedIdentifierValues(normalized);
  if (unquotedValRepaired) {
    const uvResult = tryParseObject(unquotedValRepaired);
    if (uvResult.ok) {
      const normalizedArgs = normalizeToolArgumentAliases(uvResult.value, toolName);
      return {
        ok: true,
        args: normalizedArgs,
        raw,
        normalized: unquotedValRepaired,
        repaired: true,
        reason: `unquoted_values_repaired: ${(direct as any).error}`,
      };
    }
  }

  return {
    ok: false,
    args: {},
    raw,
    normalized,
    repaired: normalized !== raw,
    reason: (repaired as any).error || (direct as any).error,
  };
}

/**
 * Repair single-quoted JSON to double-quoted.
 * e.g. {'question': 'text'} → {"question": "text"}
 */
function repairSingleQuotedJson(input: string): string | null {
  // Only attempt if the input contains single quotes used as delimiters
  if (!input.includes("'")) return null;

  let result = '';
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      result += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += '"'; // Convert to double quote
      continue;
    }
    result += ch;
  }

  // Verify the converted string is valid JSON
  if (result === input) return null; // No change made
  try {
    JSON.parse(result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Repair unquoted keys in JS object literal format.
 * e.g. {question: "text", options: ["A"]} → {"question": "text", "options": ["A"]}
 */
/**
 * 裸标识符**值** → 加引号。`{"name": search_files}` 这种。
 *
 * Bare identifier values such as `{"name": search_files}` are quoted while JSON
 * literals and numbers retain their native types.
 *
 * 只认**明确不是字面量**的裸词: true/false/null 和数字必须原样放过, 否则会把
 * `{"n": 1}` 修成 `{"n": "1"}`, 类型就悄悄变了。
 */
function repairUnquotedIdentifierValues(input: string): string | null {
  const repaired = input.replace(
    /(:\s*)([A-Za-z_][\w.-]*)(\s*[,}\]])/g,
    (whole, head: string, word: string, tail: string) => {
      if (/^(true|false|null)$/.test(word)) return whole;
      return `${head}"${word}"${tail}`;
    },
  );
  if (repaired === input) return null;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function repairUnquotedKeys(input: string): string | null {
  // Match unquoted keys: word chars before colon, not inside quotes
  const repaired = input.replace(
    /(?<=^|[{,\[]\s*)([a-zA-Z_]\w*)\s*:/g,
    '"$1":'
  );
  if (repaired === input) return null;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}
