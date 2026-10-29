#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(REPO_ROOT, 'config', 'import-boundaries.json');

const TARGETS = [
  { pkg: '@neoxlabs/core',     dir: 'core',     entry: './dist/sdk/index' },
  { pkg: '@neoxlabs/kernel',   dir: 'kernel',   entry: './dist/index' },
  { pkg: '@neoxlabs/platform', dir: 'platform', entry: './dist/index' },
];

const checkOnly = process.argv.includes('--check');

const OPEN_AREAS = [];

/* 根级单文件, 不属于任何区域 */
const ROOT_FILES = ['version.js'];

function buildExports(target) {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const prefix = target.pkg + '/';
  const subs = baseline.allowed
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

  /* 引擎侧点名清单 = 基线里不属于开放区域、也不是根文件的那些 */
  const named = [...new Set(
    subs.filter((s) => {
      const area = s.split('/')[0];
      return !OPEN_AREAS.includes(area) && !ROOT_FILES.includes(s);
    }),
  )].sort();

  const exportsMap = {
    '.': {
      types: `${target.entry}.d.ts`,
      import: `${target.entry}.js`,
      require: `${target.entry}.js`,
    },
    './package.json': './package.json',
  };

  /* 开放区域: 同时给带 .js 和不带 .js 两种形态 —— 仓库两种写法都在用
   * (如 '@neoxlabs/core/models/protocolModels' vs '.../platform/database.js') */
  for (const area of OPEN_AREAS) {
    exportsMap[`./${area}/*.js`] = {
      types: `./dist/${area}/*.d.ts`,
      import: `./dist/${area}/*.js`,
      require: `./dist/${area}/*.js`,
    };
    exportsMap[`./${area}/*`] = {
      types: `./dist/${area}/*.d.ts`,
      import: `./dist/${area}/*.js`,
      require: `./dist/${area}/*.js`,
    };
  }

  for (const f of ROOT_FILES) {
    const stem = f.replace(/\.js$/, '');
    for (const key of [`./${stem}.js`, `./${stem}`]) {
      exportsMap[key] = {
        types: `./dist/${stem}.d.ts`,
        import: `./dist/${stem}.js`,
        require: `./dist/${stem}.js`,
      };
    }
  }

  for (const sub of named) {
    const stem = sub.replace(/\.js$/, '');
    for (const key of [`./${stem}.js`, `./${stem}`]) {
      exportsMap[key] = {
        types: `./dist/${stem}.d.ts`,
        import: `./dist/${stem}.js`,
        require: `./dist/${stem}.js`,
      };
    }
  }

  return { exportsMap, namedCount: named.length, openAreas: OPEN_AREAS.length };
}

let failed = false;
for (const target of TARGETS) {
  const targetJson = join(REPO_ROOT, 'packages', target.dir, 'package.json');
  const { exportsMap, namedCount, openAreas } = buildExports(target);
  const pkg = JSON.parse(readFileSync(targetJson, 'utf8'));
  const before = JSON.stringify(pkg.exports);
  const after = JSON.stringify(exportsMap);

  if (checkOnly) {
    if (before !== after) {
      console.error(`\n[exports] 🔴 ${target.pkg} 的 exports 与基线不同步。`);
      console.error('  修: node scripts/sync-package-exports.mjs\n');
      failed = true;
      continue;
    }
    console.log(`[exports] ✓ ${target.pkg} exports 与基线同步 (${openAreas} 个开放区域 + ${namedCount} 个点名入口)`);
    continue;
  }

  pkg.exports = exportsMap;
  writeFileSync(targetJson, JSON.stringify(pkg, null, 2) + '\n');
  console.log(
    `[exports] ${relative(REPO_ROOT, targetJson)} 已重写: ` +
      `${openAreas} 个开放区域 + ${namedCount} 个点名入口` +
      `${before === after ? ' (无变化)' : ''}`,
  );
}
if (failed) process.exit(1);
