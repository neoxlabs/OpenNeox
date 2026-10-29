#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/*
 * node-pty ships a platform prebuild in prebuilds/win32-x64. It is verified
 * against the pinned Electron runtime during the Windows release preflight.
 * Rebuilding it on Windows requires the optional MSVC Spectre libraries,
 * while the remaining modules need their Electron-specific binaries rebuilt.
 */
const modules = [
  'better-sqlite3',
  'better-sqlite3-multiple-ciphers',
  'keytar',
];

if (process.platform !== 'win32') modules.push('node-pty');

const rebuildCli = path.join(__dirname, '..', 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
for (const moduleName of modules) {
  console.log(`[electron-rebuild] ${moduleName}`);
  execFileSync(process.execPath, [rebuildCli, '--only', moduleName, '-f'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    windowsHide: true,
  });
}

execFileSync(process.execPath, [path.join(__dirname, 'fix-native-module-signatures.cjs')], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});
execFileSync(process.execPath, [path.join(__dirname, 'patch-electron-name.cjs')], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});
