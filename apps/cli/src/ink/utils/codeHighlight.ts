import chalk from 'chalk';
import { NeoxTheme } from '../theme.js';

const KEYWORDS = new Set([
  // JS / TS
  'import', 'export', 'from', 'default', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'class', 'extends', 'implements', 'new', 'this', 'super', 'await', 'async',
  'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'type', 'interface', 'enum', 'as', 'readonly',
  'public', 'private', 'protected', 'static', 'yield', 'delete', 'void',
  // Python / Go / Rust / Shell
  'def', 'lambda', 'pass', 'with', 'elif', 'not', 'and', 'or', 'is', 'raise', 'except', 'global', 'nonlocal',
  'func', 'package', 'struct', 'go', 'defer', 'chan', 'map', 'range', 'fn', 'pub', 'mut', 'impl', 'use', 'mod', 'match',
  'then', 'fi', 'done', 'esac', 'echo', 'local',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN']);

const paint = (c: string) => (s: string) => (c.startsWith('#') ? chalk.hex(c)(s) : ((chalk as any)[c]?.(s) ?? s));

/** 一行代码 → 带 ANSI 颜色的字符串 */
export function highlightLine(line: string): string {
  if (chalk.level === 0) return line;
  const ids = NeoxTheme.identity ?? [];
  const kw = paint(ids[3] ?? NeoxTheme.brand.purple);
  const str = paint(NeoxTheme.functional.success);
  const num = paint(ids[1] ?? NeoxTheme.brand.blue);
  const lit = paint(ids[1] ?? NeoxTheme.brand.blue);
  const com = paint(NeoxTheme.text.faint);

  let out = '';
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    /* 注释: // 或 # (# 前面是空白或行首, 免得把 CSS 颜色 #fff 当注释) 到行尾 */
    const c = /^(\/\/.*|#(?![0-9a-fA-F]{3,8}\b).*)$/.exec(rest);
    if (c && (rest.startsWith('//') || i === 0 || /\s/.test(line[i - 1]!))) { out += com(c[0]); break; }
    /* 字符串: '..' ".." `..` (行内闭合; 没闭合就吃到行尾) */
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let j = 1;
      while (j < rest.length && rest[j] !== q) j += rest[j] === '\\' ? 2 : 1;
      const s = rest.slice(0, Math.min(rest.length, j + 1));
      out += str(s); i += s.length; continue;
    }
    /* 数字 */
    const n = /^\d[\d_]*(\.\d+)?/.exec(rest);
    if (n && (i === 0 || !/[\w$]/.test(line[i - 1]!))) { out += num(n[0]); i += n[0].length; continue; }
    /* 单词 */
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      const word = w[0];
      out += KEYWORDS.has(word) ? kw(word) : LITERALS.has(word) ? lit(word) : word;
      i += word.length; continue;
    }
    out += rest[0]; i += 1;
  }
  return out;
}
