#!/usr/bin/env node
/**
 * codemod-test-paths — 修正测试里"退到仓库根再拼包路径"的相对引用。
 *
 *   布局把 packages/neox-{cli,desktop} 收进 apps/{cli,desktop} 之后, 测试文件自身的
 *   深度变了 (packages/neox-desktop/src/... → apps/desktop/src/..., 深度相同),
 *   但它们**指向的**包路径也变了 (packages/kernel 不变, 而 neox-desktop 变成 apps/desktop)。
 *
 *   这类引用写成 `resolve(HERE, '../../../../../kernel/src/...')` —— 退级数按当时
 *   的文件深度手算, 布局一动就静默指向不存在的文件 (报 ENOENT 才知道)。
 *
 *   做法: 对每个测试文件, 先算出它到仓库根的相对前缀, 再把所有
 *   `<若干 ../><包目录>/...` 重写成 `<到根的相对前缀><新包路径>/...`。
 *
 *   用法:
 *     node scripts/codemod-test-paths.mjs --dry-run
 *     node scripts/codemod-test-paths.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/** 包目录 → 新位置 (相对仓库根)。未列出的包位置不变。 */
const MOVED = {
  'neox-cli': 'apps/cli',
  'neox-desktop': 'apps/desktop',
};

/** 所有包目录名 (用于识别"这是指向某个包的相对路径")。 */
const PKG_DIRS = new Set(
  execFileSync('git', ['ls-files', 'packages', 'apps'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((p) => p.split('/'))
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts[1])
    .filter((n) => n && n !== 'node_modules'),
);

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(test|spec)\.tsx?$/.test(f));

let changedFiles = 0;
let changedRefs = 0;

for (const rel of tracked) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  const fromDir = posix.dirname(rel.split(sep).join(posix.sep));

  /* 该文件到仓库根的相对前缀, 例如 apps/desktop/src/ui/renderer/__tests__ → ../../../../.. */
  const depth = fromDir.split('/').length;
  const toRoot = '../'.repeat(depth);

  let out = src;
  /* 匹配 '<../ 若干>neox-xxx/...' 或 '<../ 若干>packages/neox-xxx/...' */
  out = out.replace(/((?:\.\.\/)+)((?:packages\/)?)(neox-[a-z0-9-]+)\//g, (m, dots, mid, pkg) => {
    if (!PKG_DIRS.has(pkg)) return m;
    const target = MOVED[pkg] ?? `packages/${pkg}`;
    /* 只有当这段相对路径确实是从本文件出发时才改写 —— 用深度核对:
     * 原写法退的级数应当等于"本文件深度"或"本文件深度 - 1"(少退一级表示指向 packages/ 内)。 */
    const up = dots.split('../').length - 1;
    const looksFromThisFile = up === depth || up === depth - 1 || up === depth + 1;
    if (!looksFromThisFile) return m;
    return `${toRoot}${target}/`;
  });

  if (out !== src) {
    const n = (src.match(/(?:\.\.\/)+(?:packages\/)?neox-[a-z0-9-]+\//g) ?? []).length;
    changedFiles += 1;
    changedRefs += n;
    console.log(`  ${n}  ${rel}`);
    if (!dryRun) writeFileSync(abs, out);
  }
}

console.log(`[test-paths] ${dryRun ? 'DRY RUN — ' : ''}${changedFiles} 个文件, ${changedRefs} 处引用`);
