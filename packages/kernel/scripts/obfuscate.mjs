#!/usr/bin/env node
/**
 * obfuscate.mjs — 遍历 dist/**\/*.js, 用 esbuild minify + mangle in place.
 *
 *   作用:
 *     · drop 注释 (JSDoc / 行注释 / 块注释 全清)
 *     · mangle 局部变量 (a / b / c) — export name 保留 (否则外部 import 不到)
 *     · 单行压缩
 *   结果: source code 不再可读, 但 require/import 行为不变.
 *
 *   .d.ts 不动 (API surface 本就要公开).
 *   .map 不存在 (tsconfig sourceMap=false / declarationMap=false 早就关了).
 *
 *   注意:
 *     · 不 bundle. 因为 package.json `exports."./*"` 允许 deep import,
 *       bundle 后内部文件就找不到了.
 *     · 不 tree-shake. 第三方 deep import 走的 entry 可能任意一个 .js, 都不能裁.
 */
import { build } from 'esbuild';
import { readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const distDir = join(pkgRoot, 'dist');

function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(distDir);
console.log(`[obfuscate] minifying ${files.length} .js files in ${relative(pkgRoot, distDir)}/`);

let total = 0;
let totalAfter = 0;
for (const file of files) {
  const before = statSync(file).size;
  total += before;
  const tmpOut = `${file}.min`;
  await build({
    entryPoints: [file],
    outfile: tmpOut,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    minify: true,
    bundle: false,
    legalComments: 'none',
    sourcemap: false,
  });
  unlinkSync(file);
  renameSync(tmpOut, file);
  totalAfter += statSync(file).size;
}

const pct = total > 0 ? ((1 - totalAfter / total) * 100).toFixed(1) : '0';
console.log(`[obfuscate] done · ${(total / 1024).toFixed(1)}K → ${(totalAfter / 1024).toFixed(1)}K (-${pct}%)`);
