#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
/* 🔥 canonical dist 在 apps/cli/dist (tsup OUT_DIR + vite outDir 都写这), 不是 repo-root dist.
 *   之前用 root/dist → 生产构建末尾 "Renderer build output missing" 真凶 (dev 模式走 dev-server 不走这). */
const base = path.join(root, 'apps', 'cli', 'dist');
const srcDir = path.join(base, 'ui', 'renderer');
const destDir = path.join(base, 'ui-electron', 'renderer');
const indexFile = path.join(destDir, 'index.html');

if (!fs.existsSync(srcDir)) {
  console.error(`❌ Renderer build output missing: ${srcDir}`);
  process.exit(1);
}

fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destDir), { recursive: true });
fs.cpSync(srcDir, destDir, { recursive: true });

if (!fs.existsSync(indexFile)) {
  console.error(`❌ Synced renderer missing index.html: ${indexFile}`);
  process.exit(1);
}

console.log(`✅ Synced renderer: ${srcDir} -> ${destDir}`);
