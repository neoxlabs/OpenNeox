#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

if (process.platform !== 'darwin') process.exit(0);

const root = process.cwd();
const targets = [
  join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  join(root, 'node_modules/node-pty/build/Release/pty.node'),
  join(root, 'node_modules/node-pty/bin/darwin-arm64-143/node-pty.node'),
];

for (const target of targets) {
  if (!existsSync(target)) continue;
  execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
}
