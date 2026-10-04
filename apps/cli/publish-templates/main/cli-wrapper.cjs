#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SUPPORTED = {
  'darwin-arm64': '@neoxlabs/cli-darwin-arm64',
  'darwin-x64': '@neoxlabs/cli-darwin-x64',
  'linux-x64': '@neoxlabs/cli-linux-x64',
  'linux-arm64': '@neoxlabs/cli-linux-arm64',
  'win32-x64': '@neoxlabs/cli-win32-x64',
};

const EXE = process.platform === 'win32' ? 'neox.exe' : 'neox';

/** 解析 node_modules 里的平台二进制 (源) + 其版本号。失败返回 { error }。 */
function resolveSource() {
  const key = `${process.platform}-${process.arch}`;
  const pkg = SUPPORTED[key];
  if (!pkg) return { error: `不支持当前平台 ${key} (支持: ${Object.keys(SUPPORTED).join(', ')})` };
  try {
    const root = path.dirname(require.resolve(`${pkg}/package.json`));
    const bin = path.join(root, EXE);
    if (fs.existsSync(bin)) {
      let version = '0';
      try { version = require(`${pkg}/package.json`).version || '0'; } catch { /* keep 0 */ }
      return { bin, version };
    }
  } catch { /* fall through */ }
  return { error: `平台子包 ${pkg} 未安装 (可能用了 --no-optional)。修复: npm install -g ${pkg}` };
}

const SIDECARS = ['rg', 'rg.exe', 'watcher.node'];

/** copy 一个 sidecar 到缓存目录 (存在且同大小则跳过)。失败静默 —— 缺了只是降级, 不该挡住启动。 */
function copySidecar(srcDir, cacheDir, name) {
  try {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) return;
    const dest = path.join(cacheDir, name);
    try {
      if (fs.statSync(dest).size === fs.statSync(src).size) return;
    } catch { /* dest 不存在 → 继续 copy */ }
    const tmp = path.join(cacheDir, `.tmp-${process.pid}-${Date.now()}-${name}`);
    fs.copyFileSync(src, tmp);
    if (process.platform !== 'win32' && name !== 'watcher.node') {
      try { fs.chmodSync(tmp, 0o755); } catch { /* ignore */ }
    }
    try { fs.renameSync(tmp, dest); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  } catch { /* 单个 sidecar 失败不影响其它 */ }
}

/**
 * 把源二进制 copy 到缓存 ~/.neox/bin/neox-<版本>(.exe), 返回缓存路径。
 *   · 已存在且大小一致 → 跳过 copy
 *   · 原子: 临时文件 + rename (rename 失败说明被同版本 daemon 锁着, 即已存在, 直接用)
 *   · sidecar (rg / watcher.node) 一并进缓存 —— 见上方说明
 *   · 清理旧版本缓存 (best-effort; 锁着就跳过)
 *   · 任何失败 → 回落直接返回源路径 (退化成旧行为, 至少能跑)
 */
function ensureCached(src, version) {
  const cacheDir = path.join(os.homedir(), '.neox-lite', 'bin');
  const name = process.platform === 'win32' ? `neox-${version}.exe` : `neox-${version}`;
  const dest = path.join(cacheDir, name);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    let need = true;
    try {
      if (fs.statSync(dest).size === fs.statSync(src).size) need = false; // 已缓存好
    } catch { /* dest 不存在 → need=true */ }
    if (need) {
      const tmp = path.join(cacheDir, `.tmp-${process.pid}-${Date.now()}-${name}`);
      fs.copyFileSync(src, tmp);
      if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o755); } catch { /* ignore */ } }
      try {
        fs.renameSync(tmp, dest);
      } catch {
        // dest 被同版本运行中的 daemon 锁住 → 它已存在且就是对的, 删临时文件用现有的
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
    }
    /* sidecar 跟着进缓存 —— 二进制按 execPath 同目录找它们 */
    for (const sc of SIDECARS) copySidecar(path.dirname(src), cacheDir, sc);

    // 清理旧版本缓存 (锁着的旧 daemon 二进制跳过, 下次再清)
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (f === name || f.startsWith('.tmp-') || !f.startsWith('neox-')) continue;
        try { fs.rmSync(path.join(cacheDir, f), { force: true }); } catch { /* 锁着, 跳过 */ }
      }
    } catch { /* ignore */ }
    if (fs.existsSync(dest)) return dest;
  } catch { /* 缓存整体失败 → 回落源路径 */ }
  return src;
}

/** 安装期预热: 把当前平台二进制 copy 进缓存, 让首次 `neox` 不用现 copy。失败静默。 */
function prewarm() {
  try {
    const s = resolveSource();
    if (s.bin) ensureCached(s.bin, s.version);
  } catch { /* best-effort */ }
}

/** 真正启动: 解析源 → 确保缓存 → 跑缓存二进制 (透传 argv / stdio / signals)。 */
function run() {
  const s = resolveSource();
  if (s.error) { process.stderr.write(`neox: ${s.error}\n`); process.exit(1); return; }
  const target = ensureCached(s.bin, s.version);

  const child = spawn(target, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
  const pass = (sig) => () => { try { child.kill(sig); } catch { /* ignore */ } };
  process.on('SIGINT', pass('SIGINT'));
  process.on('SIGTERM', pass('SIGTERM'));
  process.on('SIGHUP', pass('SIGHUP'));
  child.on('exit', (code, sig) => {
    if (sig) process.kill(process.pid, sig); // 让 parent 也以同 signal 死, shell 能正确 detect Ctrl-C
    else process.exit(code ?? 0);
  });
  child.on('error', (e) => { process.stderr.write(`neox: 无法启动 binary: ${e.message}\n`); process.exit(2); });
}

module.exports = { run, prewarm, resolveSource, ensureCached };

/* 作为 binary 直接跑 (bin/neox → require(this).run())。被 require 当 module 用时不自动跑。 */
if (require.main === module) run();
