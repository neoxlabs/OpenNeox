#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep, posix } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, 'config', 'edition-boundaries.json');
const EXPORT_SPEC = join(REPO_ROOT, 'scripts', 'public-export.json');

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const update = argv.includes('--update');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node scripts/check-edition-boundaries.mjs [--verbose] [--update]');
  process.exit(0);
}

/* ── 商业目录: 从导出规格的 exclude 段推导, 不另维护名单 ──────────────────────
 *   exclude 里是正则, 但真正表达"整棵子树不导出"的是 `^packages/<name>/` 这种形态。
 *   这里只取那类前缀式条目, 加上渲染层里按目录排除的商业 UI。 */
function commercialDirs() {
  const spec = JSON.parse(readFileSync(EXPORT_SPEC, 'utf8'));
  const dirs = new Set();
  for (const rule of spec.exclude ?? []) {
    /* 只取 `^packages/<名字>/` 这种"整包不导出"的条目。包名限定为字母数字与连字符,
     * 否则 `^packages/[^/]+/CHANGELOG\.md$` 这类正则会把 `[^` 当成目录名。 */
    const m = /^\^packages\/([A-Za-z0-9-]+)\/$/.exec(rule);
    if (m) dirs.add(`packages/${m[1]}`);
  }
  /* 渲染层/主进程里的商业 UI —— 这些在导出规格里是按文件逐个排除的, 这里按目录收口。 */
  for (const d of [
    'apps/desktop/src/ui/renderer/billing',
    'apps/desktop/src/ui/renderer/auth',
    'apps/desktop/src/ui/renderer/cloud-session',
    'apps/desktop/src/ui/renderer/notifications',
    'apps/desktop/src/ui/renderer/feedback',
    /* 发行版注册目录: editionSlots.ts 经 import.meta.glob 找它 (不是静态 import), 公开树里整个不存在 */
    'apps/desktop/src/ui/renderer/modules/shell/edition',
    /* 按文件排除的商业 UI (不带扩展名 —— import 说明符里没有扩展名, 判定时两边都去掉) */
    'apps/desktop/src/ui/renderer/modules/shell/CloudBadge',
    'apps/desktop/src/ui/renderer/modules/shell/NotificationMenu',
    'apps/desktop/src/plugins/marketplace',
    'apps/desktop/src/ui/electron/cloud-session',
    'apps/cli/src/auth',
    'packages/core/src/cloud-runtime',
  ]) dirs.add(d);
  return [...dirs].sort();
}

const COMMERCIAL = commercialDirs();

/* 扫描范围: 只扫会被导出的那几个包 —— 商业包内部怎么引都行, 不进树。 */
const SCAN_ROOTS = [
  'packages/kernel/src',
  'packages/platform/src',
  'packages/core/src',
  'packages/sdk/src',
  'packages/sandbox/src',
  'apps/cli/src',
  'apps/desktop/src',
  'packages/devtools/src',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'target', '__tests__', '__harness__']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, acc);
    } else if (e.isFile() && CODE_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) {
      acc.push(p);
    }
  }
  return acc;
}

/** 该文件是否属于商业目录 (属于则它引谁都不管)。 */
const stripExt = (p) => p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');

function isCommercial(rel) {
  const p = stripExt(rel.split(sep).join(posix.sep));
  return COMMERCIAL.some((d) => p === d || p.startsWith(`${d}/`));
}

/** 解析 import 的模块说明符 —— 只看静态 import/export from 与 require。 */
const SPEC_RE = /(?:^|[^\w.])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function specifiers(src) {
  const out = [];
  for (const m of src.matchAll(SPEC_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}

/** 相对说明符 → 仓库相对路径 (解析掉 ./ 与 ../)。 */
function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = posix.dirname(fromRel.split(sep).join(posix.sep));
  const joined = posix.normalize(posix.join(base, spec));
  return joined;
}

/* ── 发行版分叉文件: 共享路径上、导出时被 overlay 同名文件整体替换的那几个 ──────
 *   例: apps/desktop/src/ui/electron/mainEdition.ts —— 商业版在里面把 cloud-session /
 *   plugins/marketplace 接上共享代码的口子, 公开树里是 overlay 提供的空实现。
 *   它引商业目录是设计本身 (整棵树里唯一允许的地方), 所以不算越界; 但要守住两件事:
 *     · overlay 那份自己不许引商业目录 (它才是公开树里真正编译的那份)
 *     · 两份导出的名字一致 (否则公开树里调用方编译不过, 而这边永远看不到) */
const OVERLAY_ROOT = (() => {
  const spec = JSON.parse(readFileSync(EXPORT_SPEC, 'utf8'));
  return spec.overlay ? join(REPO_ROOT, spec.overlay) : null;
})();

function overlayCounterpart(rel) {
  if (!OVERLAY_ROOT) return null;
  const p = join(OVERLAY_ROOT, rel);
  return existsSync(p) ? p : null;
}

const EXPORT_NAME_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
const exportedNames = (src) => [...src.matchAll(EXPORT_NAME_RE)].map((m) => m[1]).sort();

const violations = [];
const forkProblems = [];
const scanned = [];

function scanImports(rel, src, label = rel) {
  for (const spec of specifiers(src)) {
    const resolved = resolveRel(rel, spec);
    if (!resolved) continue;
    /* 按文件排除的商业 UI (CloudBadge 等) 在清单里不带扩展名, 说明符可能带 —— 两边都去掉 */
    const target = stripExt(resolved);
    /* 命中商业目录: 精确到目录边界, 避免 billing-utils 这种同前缀误判。 */
    const hit = COMMERCIAL.find((d) => target === d || target.startsWith(`${d}/`));
    if (hit) violations.push({ file: label.split(sep).join(posix.sep), spec, target, dir: hit });
  }
}

for (const root of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, root);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = relative(REPO_ROOT, file);
    scanned.push(rel);
    if (isCommercial(rel)) continue;
    const src = readFileSync(file, 'utf8');
    const fork = overlayCounterpart(rel);
    if (fork) {
      const forkSrc = readFileSync(fork, 'utf8');
      /* overlay 那份按它在公开树里的位置解析相对路径 */
      scanImports(rel, forkSrc, `${relative(REPO_ROOT, fork)}`);
      const a = exportedNames(src).join(', ');
      const b = exportedNames(forkSrc).join(', ');
      if (a !== b) forkProblems.push(`${rel}: 导出 [${a}] ≠ overlay [${b}]`);
      continue;
    }
    scanImports(rel, src);
  }
}

if (forkProblems.length) {
  console.error(`\n[edition] ✗ 发行版分叉文件与 overlay 空实现不一致 ${forkProblems.length} 处:\n`);
  for (const p of forkProblems) console.error(`  ${p}`);
  console.error('\n修法: 两份导出同一组名字 —— 公开树里编译的是 overlay 那份。\n');
  process.exit(1);
}

/* ── 棘轮比对 ─────────────────────────────────────────────────────────────── */
const keyOf = (v) => `${v.file} -> ${v.dir}`;
const current = [...new Set(violations.map(keyOf))].sort();

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({
    $comment: [
      '发行版边界基线 —— check-edition-boundaries.mjs 读它。',
      '共享文件引用商业目录的存量清单。**只减不增**: 每把一处改成插槽注册就收一次基线,',
      '看到红不要顺手 --update, 那等于把闸拆了。',
    ],
    generatedAt: new Date().toISOString(),
    entries: current,
  }, null, 2)}\n`);
  console.log(`[edition] 基线已写入 ${relative(REPO_ROOT, BASELINE_PATH)}: ${current.length} 条`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH)
  ? new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries ?? [])
  : new Set();

const added = current.filter((k) => !baseline.has(k));
const removed = [...baseline].filter((k) => !current.includes(k));

if (verbose) {
  console.log(`[edition] 扫描 ${scanned.length} 个文件 · 商业目录 ${COMMERCIAL.length} 个`);
  for (const d of COMMERCIAL) console.log(`  · ${d}`);
}

if (added.length) {
  console.error(`\n[edition] ✗ 新增越界 ${added.length} 条 —— 共享文件引用了商业目录:\n`);
  for (const k of added) {
    const [file, dir] = k.split(' -> ');
    console.error(`  ${file}`);
    console.error(`      → ${dir}`);
  }
  console.error('\n修法: 商业能力走插槽 / 契约, 不要在共享文件里直接 import。');
  console.error('  渲染层: modules/shell/uiSlots.tsx 的 registerUiSlot');
  console.error('  能力层: packages/cloud 的 registerCloud');
  console.error('  主进程: apps/desktop/src/ui/electron/mainEdition.ts (唯一分叉文件, 公开树里换成 overlay 空实现)');
  console.error('  确实必须新增 (例如迁移中), 人工确认后跑 --update 收进基线。\n');
  process.exit(1);
}

if (removed.length) {
  console.log(`[edition] ✓ 无新增越界。另有 ${removed.length} 条已修复, 可跑 --update 收基线:`);
  for (const k of removed.slice(0, 10)) console.log(`  - ${k}`);
  if (removed.length > 10) console.log(`  … 还有 ${removed.length - 10} 条`);
}

console.log(`[edition] ✓ 边界干净 (存量 ${baseline.size} 条, 扫描 ${scanned.length} 个文件)`);
process.exit(0);
