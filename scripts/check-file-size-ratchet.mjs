#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, 'config', 'file-size-baseline.json');

/** 只管这个体量以上的文件 —— 小文件长大是正常演化, 不值得拦。 */
const WATCH_THRESHOLD = 2500;
/** 新文件的硬上限: 没在基线里的文件不允许一上来就超过这个行数。 */
const NEW_FILE_LIMIT = 2500;

/* 宿主收进 apps/ 之后, 大文件同样会长在 apps/cli、apps/desktop 里 —— 只扫 packages 会漏。 */
const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'vendor', '__snapshots__']);
/** 生成物 / 第三方内联产物不算我们的债 */
const SKIP_FILE = /\.(d\.ts|generated\.ts)$/;
/** 打包产物目录 (lite 壳里塞的 vite 产物等) —— 是构建结果不是源码 */
const SKIP_PATH = /(src-tauri\/resources|\/resources\/ui\/assets\/|\/monaco-editor\/)/;

const relKey = (p) => relative(REPO_ROOT, p).split(sep).join('/');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(join(dir, entry.name), out);
      continue;
    }
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) continue;
    if (SKIP_FILE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (SKIP_PATH.test(full)) continue;
    out.push(full);
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((r) => {
  const abs = join(REPO_ROOT, r);
  return existsSync(abs) && statSync(abs).isDirectory() ? walk(abs) : [];
});

const measured = new Map();
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n').length;
  if (lines >= WATCH_THRESHOLD) measured.set(relKey(f), lines);
}

const update = process.argv.includes('--update');
const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { _comment: '', threshold: WATCH_THRESHOLD, files: {} };

if (update) {
  const next = {};
  for (const [file, lines] of [...measured].sort()) {
    const prev = baseline.files?.[file];
    /* 只允许调小 —— --update 不该变成"把超标洗白"的按钮 */
    next[file] = prev === undefined ? lines : Math.min(prev, lines);
  }
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({
      _comment: '大文件行数棘轮基线: 只准变小。新增内容请放新文件, 不要往这些文件里继续堆。',
      generatedFrom: 'scripts/check-file-size-ratchet.mjs --update',
      threshold: WATCH_THRESHOLD,
      files: next,
    }, null, 2)}\n`,
  );
  console.log(`[filesize] 基线已写入 ${Object.keys(next).length} 个文件`);
  process.exit(0);
}

const grew = [];
const newOversized = [];
const shrank = [];
for (const [file, lines] of measured) {
  const prev = baseline.files?.[file];
  if (prev === undefined) {
    if (lines > NEW_FILE_LIMIT) newOversized.push({ file, lines });
    continue;
  }
  if (lines > prev) grew.push({ file, lines, prev });
  else if (lines < prev) shrank.push({ file, lines, prev });
}

if (shrank.length) {
  const saved = shrank.reduce((n, s) => n + (s.prev - s.lines), 0);
  console.log(`[filesize] ℹ ${shrank.length} 个文件变短了 (共 -${saved} 行), 基线可收紧: node scripts/check-file-size-ratchet.mjs --update`);
}

if (!grew.length && !newOversized.length) {
  console.log(`[filesize] ✓ 干净 — ${measured.size} 个大文件都没有变大 (阈值 ${WATCH_THRESHOLD} 行)`);
  process.exit(0);
}

console.error('\n[filesize] ✗ 有文件在变大 —— 这几个文件已经是"改一处要手写四遍"的量级, 不能再堆了。\n');
for (const g of grew) {
  console.error(`  ${g.file}`);
  console.error(`      ${g.prev} → ${g.lines} 行 (+${g.lines - g.prev})`);
}
for (const n of newOversized) {
  console.error(`  ${n.file}`);
  console.error(`      新文件 ${n.lines} 行, 超过新文件上限 ${NEW_FILE_LIMIT}`);
}
console.error('\n  怎么办: 把这次新增的内容放到一个新模块里, 从这个文件 import 过去。');
console.error('  确实无法拆分 (例如整段是数据表), 再手动改 config/file-size-baseline.json 并在 PR 里说明。\n');
process.exit(1);
