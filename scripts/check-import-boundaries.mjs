#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS_DIR = join(REPO_ROOT, 'packages');
const BASELINE_PATH = join(REPO_ROOT, 'config', 'import-boundaries.json');

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const update = argv.includes('--update');

const RATCHETED = ['@neoxlabs/core', '@neoxlabs/kernel', '@neoxlabs/platform'];

/** renderer 跑在浏览器: 这些一律不许出现 (当前基线为 0 违规, 所以是硬闸不是棘轮). */
const RENDERER_DIR = join('apps', 'desktop', 'src', 'ui', 'renderer');
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'child_process', 'crypto', 'net', 'http', 'https', 'worker_threads',
  'stream', 'util', 'events', 'url', 'zlib', 'tty', 'readline', 'module', 'v8', 'vm',
]);
const RENDERER_FORBIDDEN_PKGS = new Set(['electron', 'better-sqlite3', 'node-pty', 'keytar']);

const SRC_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs']);
/* __tests__ 【不】跳过: 测试也走 exports map 解析 (vitest 同款), 它引到的深引路径同样属于
 * 必须被 exports 白名单放行的表面。漏掉它们 = 收窄 exports 时单测才炸。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'publish-templates']);

const failures = [];
const notes = [];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      if (dot >= 0 && SRC_EXT.has(e.name.slice(dot))) out.push(p);
    }
  }
  return out;
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]|\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

/* 注释里的 import 不算数 —— 这仓库的注释里大量写着"别这么 import"的反例路径
 * (如 platform/routingState.ts 记录 singleton 双份坑时引的 @neoxlabs/core/platform/database.js),
 * 不剔掉就会把文档判成依赖。只剔块注释和整行注释, 不动行尾 `//` (代码行里可能是 URL)。 */
function stripComments(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

function specifiersOf(file) {
  const txt = stripComments(readFileSync(file, 'utf8'));
  const out = [];
  for (const m of txt.matchAll(SPEC_RE)) out.push(m[1] ?? m[2]);
  return out;
}

/** '@neoxlabs/core/platform/x.js' → { pkg, sub } ; 'react' → { pkg:'react', sub:'' } */
function splitSpecifier(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = spec.slice(pkg.length).replace(/^\//, '');
  return { pkg, sub };
}

// ══════════════════════════════════════════════════════════════════════════
// 收集: 每个 workspace 包用了哪些包 / 深引了哪些路径
// ══════════════════════════════════════════════════════════════════════════
/* 宿主收进 apps/ 之后, apps/cli 与 apps/desktop 也是 workspace 包 —— 它们同样要参与
 * 依赖方向判定 (apps 可以依赖 packages, 反向不行), 只扫 packages 会把最大的两个消费者漏掉。 */
const WORKSPACE_ROOTS = [PKGS_DIR, join(REPO_ROOT, 'apps')].filter((d) => existsSync(d));
const pkgEntries = WORKSPACE_ROOTS.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'package.json')))
    .map((e) => ({ dir: join(root, e.name), name: e.name, root })));

const workspaceNames = new Map(); // pkgName -> dirName
for (const { dir, name } of pkgEntries) {
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  workspaceNames.set(meta.name, name);
}

/** dirName -> { meta, usedWorkspacePkgs:Set, deepImports:Set('@neoxlabs/core/utils/config.js') } */
const usage = new Map();
const deepImportOwners = new Map(); // 'pkg/sub' -> Set(consumer dir)

for (const { dir: pkgDir, name: d } of pkgEntries) {
  const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const srcDir = join(pkgDir, 'src');
  const files = existsSync(srcDir) ? walk(srcDir) : [];
  const vendorDir = join(pkgDir, 'vendor');
  if (existsSync(vendorDir)) files.push(...walk(vendorDir));
  try {
    for (const e of readdirSync(pkgDir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot >= 0 && SRC_EXT.has(e.name.slice(dot))) files.push(join(pkgDir, e.name));
    }
  } catch { /* 目录读不了就算了, 别把闸门自己搞挂 */ }
  const used = new Set();
  const deep = new Set();

  for (const file of files) {
    const relFile = relative(REPO_ROOT, file);
    const inRenderer = relFile.startsWith(RENDERER_DIR + sep);

    for (const spec of specifiersOf(file)) {
      const split = splitSpecifier(spec);
      if (!split) continue;
      const { pkg, sub } = split;

      if (inRenderer && !/[\\/]__tests__[\\/]|[\\/]__harness__[\\/]|\.test\.[cm]?[tj]sx?$|scanRulesOfHooks\.mjs$/.test(relFile)) {
        const bare = pkg.startsWith('node:') ? pkg.slice('node:'.length) : pkg;
        if (spec.startsWith('node:') || NODE_BUILTINS.has(bare) || RENDERER_FORBIDDEN_PKGS.has(pkg)) {
          failures.push({
            rule: 'renderer-purity',
            detail: `${relFile} → '${spec}' (renderer 跑在浏览器, 不许引 node 内建 / 主进程模块)`,
          });
        }
      }

      if (!workspaceNames.has(pkg)) continue;
      /* 自引 (包内用绝对名, 如 core/src/server/client-agent/hostContext.ts) 不算跨包依赖,
       * 但它【一样走 exports map 解析】(Node self-reference), 所以深引面必须算它 ——
       * 否则收窄 exports 时会把 core 自己打断。 */
      const selfRef = pkg === meta.name;
      if (!selfRef) used.add(pkg);
      if (sub && RATCHETED.includes(pkg)) {
        const key = `${pkg}/${sub}`;
        deep.add(key);
        if (!deepImportOwners.has(key)) deepImportOwners.set(key, new Set());
        deepImportOwners.get(key).add(d);
      }
    }
  }
  usage.set(d, { meta, used, deep });
}

// ══════════════════════════════════════════════════════════════════════════
// 规则 A: phantom dependency —— 引了 workspace 包却没在 package.json 声明
// ══════════════════════════════════════════════════════════════════════════
for (const [d, { meta, used }] of usage) {
  const declared = new Set([
    ...Object.keys(meta.dependencies ?? {}),
    ...Object.keys(meta.devDependencies ?? {}),
    ...Object.keys(meta.peerDependencies ?? {}),
    ...Object.keys(meta.optionalDependencies ?? {}),
  ]);
  for (const pkg of [...used].sort()) {
    if (!declared.has(pkg)) {
      failures.push({
        rule: 'phantom-dependency',
        detail: `packages/${d}/package.json 没声明 ${pkg}, 但源码里 import 了 —— ` +
          `现在只是靠 workspace 提升侥幸能解析`,
      });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 规则 B: 深引棘轮 —— 对照基线, 只许减不许增
// ══════════════════════════════════════════════════════════════════════════
const current = [...deepImportOwners.keys()].sort();

if (update) {
  const payload = {
    _comment: [
      '深引基线 (scripts/check-import-boundaries.mjs 规则 B) —— 冻结外部对 core/kernel 内部路径的引用面。',
      '只减不增: 新增一条 = CI 红。修法是走公开入口 (core barrel / shared 契约), 不是往这里追加。',
      '清零路线见 2026-07-27 架构审计: platform/utils/shared 抽成 @neoxlabs/platform 后,',
      '剩下的 runtime/tools/models 深引收敛到窄 facade, core/kernel 的 exports 才能从 "./*" 收成白名单,',
      '混淆 (packages/neox-{core,kernel}/scripts/obfuscate.mjs) 才有可能开。',
    ],
    generatedFrom: 'node scripts/check-import-boundaries.mjs --update',
    count: current.length,
    allowed: current,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[boundaries] 基线已写入 ${relative(REPO_ROOT, BASELINE_PATH)} (${current.length} 条深引)`);
  console.log('[boundaries] ⚠️  请人工 review diff —— 基线只应该变短。');
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`[boundaries] 基线不存在: ${relative(REPO_ROOT, BASELINE_PATH)}`);
  console.error('  先跑一次: node scripts/check-import-boundaries.mjs --update');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const allowed = new Set(baseline.allowed ?? []);
const added = current.filter((k) => !allowed.has(k));
const removed = [...allowed].filter((k) => !current.includes(k));

for (const key of added) {
  const owners = [...deepImportOwners.get(key)].join(', ');
  failures.push({
    rule: 'new-deep-import',
    detail: `${key}  ← 新增深引 (来自 ${owners})。core/kernel 的内部路径是要被封起来的, ` +
      `请走公开入口; 确实必要就在 PR 里说明理由再 --update`,
  });
}
if (removed.length > 0) {
  notes.push(`深引减少 ${removed.length} 条 (基线可收紧: node scripts/check-import-boundaries.mjs --update)`);
  if (verbose) for (const r of removed) notes.push(`    - ${r}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 报告
// ══════════════════════════════════════════════════════════════════════════
if (verbose) {
  console.log(`[boundaries] 扫了 ${pkgDirs.length} 个 workspace 包`);
  console.log(`[boundaries] 深引面: ${current.length} 条 (基线 ${allowed.size})`);
}

if (failures.length > 0) {
  const byRule = new Map();
  for (const f of failures) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f.detail);
  }
  console.error(`\n[boundaries] 🔴 包边界违规 ${failures.length} 处\n`);
  for (const [rule, items] of byRule) {
    console.error(`  ${rule} (${items.length}):`);
    for (const it of items.slice(0, 25)) console.error(`    · ${it}`);
    if (items.length > 25) console.error(`    · … 还有 ${items.length - 25} 处`);
    console.error('');
  }
  process.exit(1);
}

for (const n of notes) console.log(`[boundaries] ℹ ${n}`);
console.log(
  `[boundaries] ✓ 干净 — 无 phantom 依赖 / 无新增深引 (${current.length} 条在基线内) / renderer 纯度 OK`,
);
