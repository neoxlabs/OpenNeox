#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* database.ts findFirst 的首选路径 — CLI(Node) 实际加载的 backup. */
const BACKUP = path.join(ROOT, 'packages', 'core', 'dist', 'native', 'better_sqlite3.node');

function backupIsNodeAbi() {
  if (!fs.existsSync(BACKUP)) return false;
  try {
    require(BACKUP); // 能被【当前 Node】dlopen = node ABI
    return true;
  } catch (e) {
    // NODE_MODULE_VERSION 不匹配 = 别的 ABI (electron); 其它错 (symbol 重复) = ABI 对
    return !(e && e.message && e.message.includes('NODE_MODULE_VERSION'));
  }
}

if (backupIsNodeAbi()) {
  console.log('✓ CLI native backup (neox-core/dist/native, node ABI) 就绪 — 不碰 node_modules, 桌面 dev 可同时跑');
  process.exit(0);
}

console.log('⚠ CLI native backup 缺/坏 → 跑 rebuild-native 生成 (这次会切 node_modules, 若桌面 dev 在跑请之后重跑 dev:desktop)');
execSync('node scripts/rebuild-native.cjs', { cwd: ROOT, stdio: 'inherit' });
