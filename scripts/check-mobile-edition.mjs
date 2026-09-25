#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'apps/mobile';
const APP_ABS = join(REPO_ROOT, APP);
const EXPORT_SPEC = join(REPO_ROOT, 'scripts', 'public-export.json');
const OVERLAY_MAIN = join(REPO_ROOT, 'scripts', 'public-overlay', 'files', APP, 'lib', 'main.dart');

/** 唯一允许 import 商业目录的共享文件, 以及它唯一允许 import 的那个文件。 */
const REGISTRATION_FILE = `${APP}/lib/main.dart`;
const REGISTRATION_TARGET = `${APP}/lib/commercial/commercial_edition.dart`;
const OPEN_ENTRY = `${APP}/lib/main_open.dart`;

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const analyze = argv.includes('--analyze');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node scripts/check-mobile-edition.mjs [--analyze] [--verbose]');
  process.exit(0);
}

if (!existsSync(APP_ABS)) {
  console.log(`[mobile-edition] 没有 ${APP}, 跳过`);
  process.exit(0);
}
if (!existsSync(EXPORT_SPEC)) {
  /* 公开树里没有导出规格 (它本身就不导出), 也就没有商业目录可查 */
  console.log('[mobile-edition] 没有 scripts/public-export.json (公开树), 跳过');
  process.exit(0);
}

/* ── 商业目录: 取 exclude 里 `^apps/mobile/<dir>/` 形态的条目 ─────────────── */
function commercialDirs() {
  const spec = JSON.parse(readFileSync(EXPORT_SPEC, 'utf8'));
  const dirs = [];
  for (const rule of spec.exclude ?? []) {
    const m = /^\^(apps\/mobile\/[A-Za-z0-9_./-]+)\/$/.exec(rule);
    if (m) dirs.push(m[1]);
  }
  return dirs.sort();
}

const COMMERCIAL = commercialDirs();
if (COMMERCIAL.length === 0) {
  console.error('[mobile-edition] ✗ public-export.json 的 exclude 里一条 ^apps/mobile/<dir>/ 都没有 —— 名单丢了?');
  process.exit(2);
}

const toPosix = (p) => p.split(sep).join(posix.sep);
const inCommercial = (rel) => COMMERCIAL.find((d) => rel === d || rel.startsWith(`${d}/`));

const SKIP_DIRS = new Set(['.dart_tool', 'build', '.git', 'ios', 'android', 'macos', 'linux', 'windows', 'web']);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, acc);
    } else if (e.isFile() && e.name.endsWith('.dart')) {
      acc.push(p);
    }
  }
  return acc;
}

/** import / export / part 指令里的 URI (含条件导入的 if (...) 'uri' 分支)。 */
function directiveUris(src) {
  const out = [];
  /* 去掉注释, 免得注释里举例的路径被当成 import */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const re = /(?:^|;|\n)\s*(?:import|export|part)\s+([^;]+);/g;
  for (const m of code.matchAll(re)) {
    for (const u of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.push(u[1]);
  }
  return out;
}

/** URI → 仓库相对路径; 不是本包的 (dart:/别的 package:) 返回 null。 */
function resolveUri(fromRel, uri) {
  if (uri.startsWith('package:neox_app/')) return `${APP}/lib/${uri.slice('package:neox_app/'.length)}`;
  if (uri.startsWith('package:') || uri.startsWith('dart:')) return null;
  return posix.normalize(posix.join(posix.dirname(fromRel), uri));
}

const violations = [];
let scanned = 0;
for (const root of ['lib', 'test', 'integration_test', 'tool']) {
  for (const file of walk(join(APP_ABS, root))) {
    const rel = toPosix(relative(REPO_ROOT, file));
    if (inCommercial(rel)) continue;
    scanned++;
    for (const uri of directiveUris(readFileSync(file, 'utf8'))) {
      const target = resolveUri(rel, uri);
      if (!target) continue;
      const hit = inCommercial(target);
      if (!hit) continue;
      if (rel === REGISTRATION_FILE && target === REGISTRATION_TARGET) continue;
      violations.push({ file: rel, uri, dir: hit });
    }
  }
}

/* ── 开源入口 与 导出覆盖层 ───────────────────────────────────────────────── */
const problems = [];
const openEntryAbs = join(REPO_ROOT, OPEN_ENTRY);
if (!existsSync(openEntryAbs)) {
  problems.push(`缺开源入口 ${OPEN_ENTRY}`);
} else if (!existsSync(OVERLAY_MAIN)) {
  problems.push(`缺导出覆盖层 ${toPosix(relative(REPO_ROOT, OVERLAY_MAIN))} (导出时它顶替 lib/main.dart)`);
} else if (readFileSync(openEntryAbs, 'utf8') !== readFileSync(OVERLAY_MAIN, 'utf8')) {
  problems.push(
    `${OPEN_ENTRY} 与 ${toPosix(relative(REPO_ROOT, OVERLAY_MAIN))} 不一致 —— 改了一个就要同步另一个 (后者是前者的逐字副本)`,
  );
}

if (verbose) {
  console.log(`[mobile-edition] 扫描 ${scanned} 个共享 Dart 文件 · 商业目录 ${COMMERCIAL.length} 个:`);
  for (const d of COMMERCIAL) console.log(`  · ${d}/`);
}

if (violations.length || problems.length) {
  if (violations.length) {
    console.error(`\n[mobile-edition] ✗ 共享 Dart 文件引用了商业目录 (${violations.length} 处):\n`);
    for (const v of violations) console.error(`  ${v.file}\n      import '${v.uri}'  → ${v.dir}/`);
    console.error('\n修法: 需要商业能力就在 lib/core/edition/edition.dart 加一个接缝 (带"没有这项能力"时的默认实现),');
    console.error('      商业实现放 lib/commercial/, 在 CommercialEdition 里覆盖。唯一的注册 import 在 lib/main.dart。\n');
  }
  for (const p of problems) console.error(`[mobile-edition] ✗ ${p}`);
  process.exit(1);
}
console.log(`[mobile-edition] ✓ ${scanned} 个共享 Dart 文件, 没有引用 ${COMMERCIAL.length} 个商业目录`);

/* ── --analyze: 真删一遍 ──────────────────────────────────────────────────── */
if (analyze) {
  const tmp = mkdtempSync(join(tmpdir(), 'neox-mobile-open-'));
  const copy = join(tmp, 'mobile');
  try {
    cpSync(APP_ABS, copy, {
      recursive: true,
      filter: (src) => {
        const r = toPosix(relative(APP_ABS, src));
        return !/^(build|ios\/Pods|android\/\.gradle)(\/|$)/.test(r);
      },
    });
    for (const d of COMMERCIAL) rmSync(join(copy, d.slice(APP.length + 1)), { recursive: true, force: true });
    writeFileSync(join(copy, 'lib', 'main.dart'), readFileSync(openEntryAbs, 'utf8'));
    console.log(`[mobile-edition] 真删: ${copy} (去掉 ${COMMERCIAL.length} 个商业目录, main.dart = 开源入口)`);
    const r = spawnSync('flutter', ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings'], {
      cwd: copy,
      encoding: 'utf8',
    });
    if (r.error?.code === 'ENOENT') {
      console.error('[mobile-edition] ✗ 找不到 flutter —— --analyze 需要本机 Flutter SDK');
      process.exit(2);
    }
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const errors = out.split('\n').filter((l) => /^\s*error •/.test(l));
    const summary =
      out.split('\n').find((l) => /issues? found|No issues found/.test(l))?.trim() ?? `exit ${r.status}`;
    if (errors.length) {
      console.error(`[mobile-edition] ✗ 删掉商业目录后 flutter analyze 有 ${errors.length} 个 error:`);
      for (const l of errors.slice(0, 40)) console.error(`  ${l.trim()}`);
      process.exit(1);
    }
    console.log(`[mobile-edition] ✓ 删掉商业目录后 flutter analyze 无 error (${summary})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
