#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;
const entry = join(pkgRoot, 'src', 'index.ts');
const src = readFileSync(entry, 'utf8');

const PATTERN = /export const VERSION = '[^']*';/;
if (!PATTERN.test(src)) {
  console.error('[sdk] src/index.ts 里找不到 `export const VERSION = ...`, 无法同步。');
  process.exit(1);
}

const next = src.replace(PATTERN, `export const VERSION = '${version}';`);
const inSync = next === src;

if (process.argv.includes('--check')) {
  if (inSync) {
    console.log(`[sdk] VERSION 与 package.json 一致 — ${version}`);
    process.exit(0);
  }
  const current = src.match(PATTERN)?.[0] ?? '(none)';
  console.error(`[sdk] VERSION 漂移: package.json=${version}, src/index.ts=${current}`);
  console.error('      跑 `npm run version:sync -w @neoxlabs/sdk` 修正。');
  process.exit(1);
}

if (inSync) {
  console.log(`[sdk] VERSION 已是 ${version}, 无需改动。`);
} else {
  writeFileSync(entry, next, 'utf8');
  console.log(`[sdk] VERSION 已同步 → ${version}`);
}
