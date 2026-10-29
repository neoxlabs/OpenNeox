/**
 * 极小 TOML 段解析 —— 只为读 Codex 的 `[mcp_servers.*]`。
 *
 *   为什么不装个 toml 依赖: neox-core 的 dependencies 只有 10 个, 全是干重活的
 *   (playwright / pptx / undici)。为了读几个 `key = value` 引一个解析器不划算,
 *   而且 Codex 那几段的形状是固定的:
 *
 *     [mcp_servers.node_repl]
 *     command = "/Applications/ChatGPT.app/.../node_repl"
 *     args = [ "mcp" ]
 *     enabled = false
 *     [mcp_servers.foo.env]
 *     TOKEN = "xxx"
 *
 *    这**不是**一个通用 TOML 解析器, 别拿它去读别的文件:
 *     · 不支持多行字符串 / 行内表 / 日期 / 嵌套数组
 *     · 不支持数组表 [[x]]
 *   够用即止 —— 读不懂的行直接跳过, 宁可少认出一个 server, 也不要猜错一个命令去执行。
 */

export type TomlScalar = string | number | boolean | string[];

/** 段名 -> { key: value }。段名是原文, 例 `mcp_servers.node_repl` */
export function parseTomlSections(text: string): Map<string, Record<string, TomlScalar>> {
  const out = new Map<string, Record<string, TomlScalar>>();
  let current: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      if (!out.has(current)) out.set(current, {});
      continue;
    }
    if (!current) continue;   /* 顶层裸键 —— 这里用不到 */

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const value = parseValue(line.slice(eq + 1).trim());
    if (key && value !== undefined) out.get(current)![key] = value;
  }
  return out;
}

/** 去掉行尾注释, 但**不能**动引号里的 `#` (路径和 URL 里有 # 很正常) */
function stripComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw: string): TomlScalar | undefined {
  if (!raw) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) return undefined;      /* 跨行数组 —— 不支持, 跳过 */
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    for (const part of splitTopLevel(inner)) {
      const s = unquote(part.trim());
      if (s !== undefined) items.push(s);
    }
    return items;
  }

  const s = unquote(raw);
  if (s !== undefined) return s;

  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 按逗号切, 但不切引号内部的逗号 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') { buf += ch + (inner[++i] ?? ''); continue; }
      if (ch === inStr) inStr = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      inStr = ch; buf += ch;
    } else if (ch === ',') {
      parts.push(buf); buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function unquote(raw: string): string | undefined {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\nrt])/g, (_, c) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
  }
  if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) {
    return raw.slice(1, -1);   /* TOML literal string: 不转义 */
  }
  return undefined;
}
