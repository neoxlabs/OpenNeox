#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_NATIVE = path.join(ROOT, 'apps', 'cli', 'dist', 'native');
const DIST_NATIVE_REL = path.relative(ROOT, DIST_NATIVE);

const FILES = [
  ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'better_sqlite3.node'],
  ['node_modules/node-pty/build/Release/pty.node', 'pty.node'],
];

if (!fs.existsSync(DIST_NATIVE)) {
  fs.mkdirSync(DIST_NATIVE, { recursive: true });
}

for (const [src, dest] of FILES) {
  const srcPath = path.join(ROOT, src);
  const destPath = path.join(DIST_NATIVE, dest);
  if (!fs.existsSync(srcPath)) {
    console.log(`  ⚠ ${src} not found, skipping`);
    continue;
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ ${dest} → ${DIST_NATIVE_REL}/ (Electron ABI)`);
}

// macOS: re-sign
if (process.platform === 'darwin') {
  for (const [, dest] of FILES) {
    const destPath = path.join(DIST_NATIVE, dest);
    if (!fs.existsSync(destPath)) continue;
    try {
      execSync(`codesign --force --sign - "${destPath}"`, { stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }
  console.log(`  ✓ Signed ${DIST_NATIVE_REL}/*.node`);
}
