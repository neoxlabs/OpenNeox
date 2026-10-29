#!/usr/bin/env node
/**
 * bundle.mjs — esbuild bundle + mangle 每个 sdk entry.
 *
 *   作用:
 *     · 把 sdk + kernel 源码 全部 inline 进 sdk dist 各 entry
 *     · mangle 局部变量 / drop 注释 / 单行压缩 → kernel 实现细节藏起来
 *     · 第三方 npm deps (ajv / axios / zod / zod-to-json-schema) external
 *       (用户 npm install sdk 时 npm 自动一并装)
 *     · Node built-ins (crypto / fs / path / ...) external (默认行为)
 *
 *   产物:
 *     dist/
 *       index.js          ← Agent / tool / provider / Session 主 entry (含 kernel)
 *       tool.js           ← tool() helper (用户自定义 tool)
 *       provider.js       ← provider() helper
 *       session.js        ← Session 类
 *       tools/index.js    ← /tools 子入口
 *       testing/index.js  ← /testing mock provider
 *       testing/node.js   ← /testing/node 工具
 *       types/index.js    ← /types 子入口
 *
 *     .d.ts 来自 tsc 编译, 不动. (build:bundle 流程: tsc 出 .d.ts → 调本脚本覆盖 .js)
 *
 *   注意 prepack 配合:
 *     package.json scripts._build_bundle_DO_NOT_USE = tsc + bundle.
 *     正式 publish 必须把它改名 build:bundle + 改 prepack 调它. 防误发.
 */
import { build } from 'esbuild';
import { readdirSync, statSync, existsSync, rmSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const srcDir = join(pkgRoot, 'src');
const distDir = join(pkgRoot, 'dist');

/* 第三方 npm deps 不 bundle, 让用户 install 时一并装 */
const EXTERNALS = [
  'ajv',
  'axios',
  'zod',
  'zod-to-json-schema',
  'vitest',          // 测试 only, 防御性 mark external (理论上不会被 import)
];

/* 每条 entry: src 入口 → dist 输出 */
const ENTRIES = [
  { src: 'index.ts',            out: 'index.js' },
  { src: 'agent.ts',            out: 'agent.js' },
  { src: 'tool.ts',             out: 'tool.js' },
  { src: 'provider.ts',         out: 'provider.js' },
  { src: 'session.ts',          out: 'session.js' },
  { src: 'types.ts',            out: 'types.js' },
  { src: 'tools/index.ts',      out: 'tools/index.js' },
  { src: 'testing/index.ts',    out: 'testing/index.js' },
  { src: 'testing/node.ts',     out: 'testing/node.js' },
  { src: 'types/index.ts',      out: 'types/index.js' },
];

/* 1) 删旧的 .js (保留 .d.ts), 准备覆盖 */
function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listJsFiles(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const existingJs = existsSync(distDir) ? listJsFiles(distDir) : [];
for (const f of existingJs) rmSync(f);
console.log(`[bundle] cleaned ${existingJs.length} old .js files`);

/* 2) bundle 每个 entry */
let totalIn = 0;
let totalOut = 0;
for (const { src, out } of ENTRIES) {
  const entryPath = join(srcDir, src);
  if (!existsSync(entryPath)) {
    console.warn(`[bundle] SKIP missing ${src}`);
    continue;
  }
  const outPath = join(distDir, out);
  await build({
    entryPoints: [entryPath],
    outfile: outPath,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    bundle: true,
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    external: EXTERNALS,
    /* mangle 局部变量名. exports / public class member 保留 (esbuild 默认行为) */
    /* keepNames: false → class/function 名也 mangle (但 reflection 可能挂; 谨慎默认 true) */
    keepNames: true,
    treeShaking: true,
    logLevel: 'warning',
  });
  const sz = statSync(outPath).size;
  totalOut += sz;
  console.log(`[bundle] ${out.padEnd(28)} ${(sz / 1024).toFixed(1).padStart(7)} KB`);
}

console.log(`[bundle] total dist .js: ${(totalOut / 1024).toFixed(1)} KB`);
console.log(`[bundle] done — kernel + sdk source 已 inline + mangle.`);
