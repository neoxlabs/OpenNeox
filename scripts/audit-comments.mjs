#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOTS = ['apps', 'packages'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html']);
const EXCLUDED_PARTS = new Set(['node_modules', 'dist', 'out', 'vendor']);
const CATEGORIES = ['date', 'user-quote', 'provenance', 'process', 'emoji', 'history'];

const patterns = {
  date: /20\d\d-\d\d-\d\d/u,
  'user-quote': /用户[:：]|用户说|用户反馈|拍板/u,
  /* 只有"照着某个产品做"才算来源标注; 把产品名当作集成对象、协议名或支持的服务商提及是正当的技术引用, 不在此列。 */
  provenance: /(?=.*(?:对标|照抄|抄自|吸收|仿照|学(?:一下|的就是)|同款|参考.*实现|对齐.*惯例|跟.{0,12}(?:一样|保持一致)))(?=.*(?:Claude Code|Codex|Cursor|ChatGPT|JetBrains|IDEA|VS ?Code|VSCode|Xcode|Notion|Figma|Linear|Raycast|OpenRouter|微信|WeChat|\bQQ\b|Slack|Telegram|Discord|Warp|iTerm|Obsidian|\bCC\b))/isu,
  process: /实锤|改进#\d+|修[:：]|ratchet/iu,
  emoji: /(?![↔-↙↩↪■-◿⬅-⬇⬛⬜⭐])\p{Extended_Pictographic}/u,
};

const historyPatterns = [
  /实拍|真机|踩(?:过|到)|实测|抓到|根因|修\s*bug|差点|拍板|用户(?:说|反馈|要求|确定)|原话/iu,
  /\b(?:T|BUG)-\d+\b|\bP0-[A-Z]\b|(?<![0-9a-fA-F#])#(?!(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F]))\d+(?![0-9a-fA-F])|刀\d+|image\s+\d+|dogfood/iu,
  /这次|那次|上次|铁证/iu,
  /(?:^|[，。；：、\s(（])(?:原来|之前|以前|旧版)(?=[^。！？\n]*(?:改|换|迁|删|加|漏|只|不|没|会|是|写|用|指|留|停|落|存|走|认|有|无))/u,
];

// These phrases describe a value or protocol at runtime rather than repository history.
const historyWhitelist = [/原来的值/u, /原始值/u, /原始输入/u];

function matchesHistory(comment) {
  if (historyWhitelist.some((pattern) => pattern.test(comment))) return false;
  return historyPatterns.some((pattern) => pattern.test(comment));
}

/** 一条注释 (已去掉 // 或 /* *\/ 外壳) 命中了哪些类别; 空数组 = 可以公开 */
export function commentCategories(comment) {
  return CATEGORIES.filter((category) => (category === 'history' ? matchesHistory(comment) : patterns[category].test(comment)));
}

function isExcluded(filePath) {
  const parts = filePath.split(sep);
  return parts.some((part) => EXCLUDED_PARTS.has(part)) || filePath.endsWith('.generated.ts');
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(extname(filePath)) && !isExcluded(filePath);
}

async function collectFiles(inputPaths = ROOTS, cwd = process.cwd()) {
  const files = [];
  async function visit(input) {
    const absolute = resolve(cwd, input);
    let stat;
    try {
      stat = await (await import('node:fs/promises')).stat(absolute);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (isSourceFile(relative(cwd, absolute))) files.push(absolute);
      return;
    }
    if (!stat.isDirectory() || isExcluded(relative(cwd, absolute))) return;
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(resolve(absolute, entry.name));
    }
  }
  for (const input of inputPaths) await visit(input);
  return files.sort();
}

/** TS/TSX 源码里所有注释的位置 (含 JSX 里 `{/* … *\/}` 那种) */
export function commentRanges(sourceFile) {
  const text = sourceFile.getFullText();
  const ranges = new Map();
  const add = (range) => {
    if (range) ranges.set(`${range.pos}:${range.end}`, range);
  };
  /* 走 getChildren() 而不是 forEachChild：JSX 里的 `{/* … *\/}` 是 JsxExpression
   * 内部那个闭合花括号的前导 trivia，forEachChild 不下放到 token 级就整段扫不到。 */
  const inspect = (node) => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) add(range);
    for (const child of node.getChildren(sourceFile)) inspect(child);
  };
  inspect(sourceFile);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos);
}

function packageName(filePath, cwd = process.cwd()) {
  const parts = relative(cwd, filePath).split(sep);
  if (parts[0] === 'apps' || parts[0] === 'packages') return `${parts[0]}/${parts[1] ?? '(root)'}`;
  return parts[0] ?? '(root)';
}

/* .css / .html 没有 AST 可用, 但它们的注释只有一种形态 —— 逐个扫出来即可。
 * html 里 `<!-- -->` 之外还有内联 <style>/<script>, 那两段的 `/* * /` 一并扫到。 */
export function nonSourceCommentRanges(text, filePath) {
  const patternsForFile = filePath.endsWith('.html')
    ? [/<!--([\s\S]*?)-->/gu, /\/\*([\s\S]*?)\*\//gu]
    : [/\/\*([\s\S]*?)\*\//gu];
  const out = [];
  for (const re of patternsForFile) {
    for (const m of text.matchAll(re)) out.push({ pos: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** 行号只用于报告, 按换行数直接算, 不依赖任何解析器。 */
function lineAt(text, pos) {
  let line = 1;
  for (let i = 0; i < pos; i++) if (text[i] === '\n') line++;
  return line;
}

export function commentBody(raw) {
  return raw.replace(/^<!--|-->$|^\/\/|^\/\*|\*\/$/gu, '').trim();
}

function auditNonSource(text, filePath, cwd) {
  const hits = [];
  for (const range of nonSourceCommentRanges(text, filePath)) {
    const comment = commentBody(text.slice(range.pos, range.end));
    for (const category of commentCategories(comment)) {
      hits.push({ file: relative(cwd, resolve(cwd, filePath)), line: lineAt(text, range.pos), category, text: comment });
    }
  }
  return hits;
}

export function auditSource(text, filePath = 'source.ts', cwd = process.cwd()) {
  if (filePath.endsWith('.css') || filePath.endsWith('.html')) {
    return auditNonSource(text, filePath, cwd);
  }
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const hits = [];
  for (const range of commentRanges(sourceFile)) {
    const comment = commentBody(text.slice(range.pos, range.end));
    for (const category of commentCategories(comment)) {
      const start = sourceFile.getLineAndCharacterOfPosition(range.pos);
      hits.push({ file: relative(cwd, resolve(cwd, filePath)), line: start.line + 1, category, text: comment });
    }
  }
  return hits;
}

export async function auditFiles(files, cwd = process.cwd()) {
  const results = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    results.push(...auditSource(text, file, cwd).map((hit) => ({ ...hit, package: packageName(file, cwd) })));
  }
  return results;
}

function summaryRows(results) {
  const counts = new Map();
  for (const hit of results) {
    const key = `${hit.package}\0${hit.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [pkg, category] = key.split('\0');
      return { package: pkg, category, count };
    })
    .sort((a, b) => a.package.localeCompare(b.package) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}

function parseArgs(argv) {
  const flags = new Set();
  const paths = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg);
    else paths.push(arg);
  }
  return { flags, paths };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, paths } = parseArgs(argv);
  const files = await collectFiles(paths.length ? paths : ROOTS);
  const results = await auditFiles(files);
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const hit of results) process.stdout.write(`${hit.file}:${hit.line} [${hit.category}] ${hit.text}\n`);
  }
  if (flags.has('--summary')) {
    process.stdout.write('\nSummary (package x category)\n');
    for (const row of summaryRows(results)) process.stdout.write(`${row.package}\t${row.category}\t${row.count}\n`);
  }
  return flags.has('--report-only') || results.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
