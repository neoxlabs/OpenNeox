#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = {
  'darwin-arm64': '@neoxlabs/cli-darwin-arm64',
  'linux-x64': '@neoxlabs/cli-linux-x64',
  'win32-x64': '@neoxlabs/cli-win32-x64',
  // darwin-x64 / linux-arm64 本版未发布; 落到"平台不支持"友好提示。
};

function log(msg) { process.stdout.write(`[neox-cli postinstall] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[neox-cli postinstall] ⚠ ${msg}\n`); }

function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const pkgName = SUPPORTED[platformKey];

  if (!pkgName) {
    warn(`不支持当前平台 ${platformKey}.`);
    warn(`支持的平台: ${Object.keys(SUPPORTED).join(', ')}`);
    warn(`你的 neox 命令会找不到二进制, 请到 https://github.com/neoxlabs/OpenNeox/issues 反馈需要的平台.`);
    return; /* 不退 1 */
  }

  let subPkgRoot;
  try {
    subPkgRoot = path.dirname(require.resolve(`${pkgName}/package.json`));
  } catch {
    log(`平台子包 ${pkgName} 未自动装 (npm optional skip), 自动补装中...`);
    try {
      const { spawnSync } = require('node:child_process');
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      /* -g 跟主包同 scope, --no-save 不污染 user 项目 package.json */
      const res = spawnSync(npmCmd, ['install', '-g', '--no-save', pkgName], {
        stdio: 'inherit',
        shell: process.platform === 'win32', /* Win 需要 shell:true 让 npm.cmd 解析 */
        timeout: 5 * 60 * 1000, /* 5 min 大包 (100MB+) 网络慢的 buffer */
      });
      if (res.status !== 0) {
        warn(`自动安装 ${pkgName} 失败 (exit ${res.status}).`);
        warn(`手动安装: npm install -g ${pkgName}`);
        return;
      }
      /* 再次 resolve 校验 */
      try { subPkgRoot = path.dirname(require.resolve(`${pkgName}/package.json`)); }
      catch (e2) {
        warn(`自动装完仍 resolve 不到 ${pkgName}: ${e2?.message ?? e2}`);
        warn(`手动: npm install -g ${pkgName}`);
        return;
      }
      log(`✓ ${pkgName} 已自动补装`);
    } catch (e) {
      warn(`自动补装出错: ${e?.message ?? e}`);
      warn(`手动: npm install -g ${pkgName}`);
      return;
    }
  }
  const exeName = process.platform === 'win32' ? 'neox.exe' : 'neox';
  const binarySrc = path.join(subPkgRoot, exeName);
  if (!fs.existsSync(binarySrc)) {
    warn(`平台子包已装但 binary 不在 ${binarySrc} — 可能 publish 出错.`);
    return;
  }

  /* 预热缓存 (copy 二进制到 ~/.neox/bin/neox-<版本>)。失败不致命 — launcher 首次跑时会兜底 copy。 */
  try {
    const { prewarm } = require('./cli-wrapper.cjs');
    prewarm();
    log(`ready (${platformKey}) — 二进制已缓存到 ~/.neox/bin, 跑 neox 即可。`);
  } catch (e) {
    warn(`缓存预热失败 (非致命, 首次跑 neox 时会自动补): ${e?.message || e}`);
  }
}

try { main(); } catch (e) {
  warn(`unexpected: ${e?.message || String(e)}`);
  /* 仍然 exit 0, 不让 npm install 失败 */
}
