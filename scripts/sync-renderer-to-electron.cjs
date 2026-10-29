#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
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
