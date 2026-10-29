#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PURGE_CREDS = process.env.NEOX_UNINSTALL_PURGE_CREDS === '1';

// 永远清 — 这些是无 owner 进程的孤儿, 留着没用还可能阻塞下次启动
const SOCK_PATHS = [
  path.join(HOME, '.neox-lite', 'command-helper.sock'),
  path.join(HOME, '.neox-lite', 'command-helper.meta.json'),
];

// 仅在 PURGE_CREDS=1 时清
const CRED_PATHS = [
  path.join(HOME, '.neox-lite', 'auth.enc'),
  path.join(HOME, '.neox-lite', 'gateway-key.enc'),
  path.join(HOME, 'Library', 'Application Support', 'Neox', 'auth.enc'),
  path.join(HOME, 'Library', 'Application Support', 'Neox', 'gateway-key.enc'),
];

function safeRm(target) {
  try {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

// 1) 总是清 socket / pid 文件 (无副作用)
let sockCleaned = 0;
for (const p of SOCK_PATHS) if (safeRm(p)) sockCleaned++;

// 2) 仅 PURGE_CREDS=1 时清凭据
let credCleaned = 0;
if (PURGE_CREDS) {
  for (const p of CRED_PATHS) if (safeRm(p)) credCleaned++;
}

// 3) 打印提示让用户知道怎么继续清
//    用 stderr 而非 stdout 防干扰其它工具
console.error('');
if (PURGE_CREDS) {
  console.error(`  ✓ Neox: 已清理 ${credCleaned} 个凭据 + ${sockCleaned} 个 socket 文件`);
  console.error('  历史会话 / 配置 / 日志保留. 完全清除请手动:');
  console.error(`    rm -rf ~/.neox  ~/Library/Application\\ Support/Neox`);
} else {
  console.error('  Neox: 已卸载 binary. 用户数据 (~/.neox/) 保留以便重装恢复.');
  console.error('  如需清理:');
  console.error('    ⓘ 不卸载只清凭据:        neox uninstall --keep-data   (需重装后跑)');
  console.error('    ⓘ 完全清除 (含历史):     rm -rf ~/.neox  ~/Library/Application\\ Support/Neox');
  console.error('    ⓘ 升级时强制清凭据:      NEOX_UNINSTALL_PURGE_CREDS=1 npm uninstall -g @neoxlabs/cli');
}
console.error('');

process.exit(0);
