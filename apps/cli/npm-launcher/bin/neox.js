#!/usr/bin/env node
'use strict';
/**
 * `neox` 命令: 确认 ~/.neox/bin 里有程序 (没有就现下, 比如装包时跳过了 postinstall), 然后把
 * 参数 / 终端 / 退出码原样交给它。
 */

const { spawn } = require('node:child_process');
const { install, needsInstall, binPath } = require('../lib/binary.js');

async function main() {
  if (needsInstall()) {
    try {
      await install();
    } catch (e) {
      process.stderr.write(`[neox] ${e.message}\n[neox] Other ways to install: https://neox-dev.com/download\n`);
      process.exit(1);
    }
  }

  const child = spawn(binPath(), process.argv.slice(2), { stdio: 'inherit' });
  /* 终端的 Ctrl+C 会同时发给两个进程; 这里不处理, 交给程序自己决定退不退 */
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* 已退出 */ } });
  }
  child.on('exit', (code, sig) => {
    if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); }
    else process.exit(code ?? 0);
  });
  child.on('error', e => { process.stderr.write(`[neox] Failed to start: ${e.message}\n`); process.exit(2); });
}

main();
