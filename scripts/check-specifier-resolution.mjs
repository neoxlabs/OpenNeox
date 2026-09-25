#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'packages');
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'release', 'coverage']);
const EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/* ── 各包的 exports 表 ──
 * 宿主收进 apps/ 之后, apps/cli 与 apps/desktop 同样是 workspace 包, 它们的 exports
 * 也要进表 —— 否则别人 import @neoxlabs/cli/xxx 会被判成"解析不到"。 */
const PKG_DIRS = [PKG_DIR, path.join(ROOT, 'apps')].filter((d) => fs.existsSync(d));
const exportsOf = new Map();
for (const dir of PKG_DIRS) {
  for (const d of fs.readdirSync(dir)) {
    const p = path.join(dir, d, 'package.json');
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.name) exportsOf.set(j.name, j.exports);
    } catch { /* 坏 package.json 交给别的闸 */ }
  }
}

/* ── 收集深引 ── */
const SPEC_RE = /['"](@(?:neoxlabs|mk-co)\/[^'"]+)['"]/g;
/** 去掉块注释与行注释, 但保留行数 (报错要指行号)。跟 check-import-boundaries 同一手法。 */
function stripComments(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const found = new Map();  // spec -> Set<file:line>
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name));
      continue;
    }
    if (!EXT.has(path.extname(e.name))) continue;
    /* 闸门脚本自己不算数: check-import-boundaries.mjs 等在注释/用例里写了
     * "@neoxlabs/core/platform/x.js" 这种示例规格, 扫进来是纯误报。 */
    if (/^check-.*\.(mjs|cjs|js|ts)$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes('@neoxlabs/')) continue;
    stripComments(text).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(SPEC_RE)) {
        const key = m[1];
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(`${path.relative(ROOT, file)}:${i + 1}`);
      }
    });
  }
}
for (const d of ['apps', 'packages', 'scripts']) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) walk(p);
}

/* ── 按 Node exports 语义判定 ── */
function resolves(spec) {
  const parts = spec.split('/');
  const name = parts.slice(0, 2).join('/');
  const sub = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
  if (!exportsOf.has(name)) return null;          // 非本仓库包 → 不管
  const ex = exportsOf.get(name);
  if (ex == null) return null;                    // 没有 exports 字段 → 老式解析, 放行
  if (typeof ex === 'string') return sub === '.';
  if (Object.prototype.hasOwnProperty.call(ex, sub)) return true;
  for (const k of Object.keys(ex)) {              // 通配 './foo/*'
    const star = k.indexOf('*');
    if (star === -1) continue;
    const pre = k.slice(0, star), suf = k.slice(star + 1);
    if (sub.length >= pre.length + suf.length && sub.startsWith(pre) && sub.endsWith(suf)) return true;
  }
  return false;
}

const broken = [];
for (const [spec, locs] of [...found].sort()) {
  if (resolves(spec) === false) broken.push([spec, [...locs].sort()]);
}

if (broken.length === 0) {
  console.log(`[specifiers] ✓ 干净 — ${found.size} 个 @neoxlabs 规格全部能被目标包的 exports 解析`);
  process.exit(0);
}

console.error(`\n[specifiers] ❌ ${broken.length} 个规格【不在目标包的 exports 里】\n`);
console.error('  后果: esbuild 解析不到 → 退化成运行时才抛的 dynamic require shim。');
console.error('  tsc/eslint/打包全都不会报, 只有跑打包版才炸, 且多数在 try/catch 里静默失效。\n');
for (const [spec, locs] of broken) {
  console.error(`  ✗ ${spec}`);
  for (const l of locs.slice(0, 6)) console.error(`       ${l}`);
  if (locs.length > 6) console.error(`       … 另外 ${locs.length - 6} 处`);
}
const pkgs = [...new Set(broken.map(([s]) => s.split('/').slice(0, 2).join('/')))];
console.error(`\n  修: 给 ${pkgs.join(' / ')} 的 exports 补上对应子路径 (带 .js 和不带各一条,`);
console.error('      跟清单里既有条目同款), 或者改调用方走已导出的入口。\n');
process.exit(1);
