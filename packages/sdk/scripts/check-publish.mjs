#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'neox-sdk-publish-'));
let failed = false;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  console.log('[publish-check] 打包 (走 prepack = clean + build:bundle)');
  const out = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: pkgRoot, encoding: 'utf8' });
  const tgz = out.trim().split('\n').pop();
  execFileSync('tar', ['-xzf', join(work, tgz), '-C', work]);
  const dist = join(work, 'package');

  /* 1. dist 必须是 bundle 过的: 入口体积够大, 且没有 core/*.js 分片 */
  const indexSize = readFileSync(join(dist, 'dist', 'index.js')).length;
  if (indexSize < 100_000) fail(`dist/index.js 只有 ${(indexSize / 1024) | 0}KB —— 看着不像 bundle 过的, kernel 可能没内联`);
  else ok(`dist/index.js 已 bundle (${(indexSize / 1024) | 0}KB)`);

  /* 2. 运行时不许再引用 kernel (它从未发到 npm) */
  const grepRuntime = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return grepRuntime(p);
    if (!e.name.endsWith('.js')) return [];
    return readFileSync(p, 'utf8').includes('@neoxlabs/kernel') ? [p] : [];
  });
  const runtimeHits = grepRuntime(join(dist, 'dist'));
  if (runtimeHits.length) fail(`.js 里仍引用 @neoxlabs/kernel: ${runtimeHits.join(', ')}`);
  else ok('.js 无 kernel 外部引用');

  /* 3. 类型层同样不许引用 kernel —— 否则 TS 用户全线 TS2307 */
  const grepTypes = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return grepTypes(p);
    if (!e.name.endsWith('.d.ts')) return [];
    return readFileSync(p, 'utf8').includes('@neoxlabs/kernel') ? [p] : [];
  });
  const typeHits = grepTypes(join(dist, 'dist'));
  if (typeHits.length) fail(`.d.ts 里仍引用 @neoxlabs/kernel: ${typeHits.join(', ')}`);
  else ok('.d.ts 无 kernel 类型引用');

  /* 4. 源码泄漏闸 (examples/*.ts 是有意公开的示例, 放行 .ts) */
  execFileSync('node', [join(repoRoot, 'scripts', 'check-source-leak.mjs'), dist, '--allow-ts', '--label=@neoxlabs/sdk tarball'], { stdio: 'inherit' });
  ok('源码泄漏闸通过');

  /* 5. 版本一致性 */
  const pkgVersion = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8')).version;
  const idx = readFileSync(join(dist, 'dist', 'index.js'), 'utf8');
  if (!idx.includes(`"${pkgVersion}"`) && !idx.includes(`'${pkgVersion}'`)) {
    fail(`产物里找不到版本号 ${pkgVersion} —— VERSION 常量可能没同步`);
  } else ok(`VERSION 与 package.json 一致 (${pkgVersion})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('\n[publish-check] 🔴 有项目未通过 —— 别发。');
  process.exit(1);
}
console.log('\n[publish-check] ✓ tarball 体检通过');
