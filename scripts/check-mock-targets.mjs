#!/usr/bin/env node

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'vendor']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name)) walk(p, out); continue; }
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/* 宿主收进 apps/ 之后测试同样长在那边, 两个根都要扫。 */
const scanRoots = ['apps', 'packages'].map((d) => join(REPO_ROOT, d));
const testFiles = scanRoots.flatMap((dir) => (existsSync(dir) && statSync(dir).isDirectory() ? walk(dir) : []));

const broken = [];
for (const file of testFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/vi\.mock\(\s*'([^']+)'/g)) {
    const spec = m[1];
    /* 只校验相对路径 —— 包说明符由 exports 闸 (check:specifiers) 负责 */
    if (!spec.startsWith('.')) continue;
    const abs = resolve(dirname(file), spec).replace(/\.js$/, '');
    const exists = existsSync(`${abs}.ts`) || existsSync(`${abs}.tsx`)
      || existsSync(join(abs, 'index.ts')) || existsSync(abs);
    if (!exists) broken.push({ file: relative(REPO_ROOT, file), spec });
  }
}

if (!broken.length) {
  console.log(`[mock-targets] ✓ 干净 — ${testFiles.length} 个测试文件里的相对 vi.mock 目标都存在`);
  process.exit(0);
}

console.error('\n[mock-targets] ✗ 这些 vi.mock 指向了不存在的模块 —— 它们不会报错, 只是**完全没有生效**:\n');
for (const b of broken) console.error(`  ${b.file}\n      vi.mock('${b.spec}')`);
console.error('\n  多半是源码 import 改了位置而 mock 没跟着改。把路径改成源码现在真正 import 的那个说明符。\n');
process.exit(1);
