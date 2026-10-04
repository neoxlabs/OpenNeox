#!/usr/bin/env node
/**
 * 保证 @vscode/ripgrep/bin 里真有本机/目标架构的 rg(.exe)。
 *
 * Win 上这是 search / search_files 的底座。出包 extraFiles 要从这里抄 rg.exe
 * 放到 Neox.exe 旁边; 缺了 electron-builder 只打一行 "file source doesn't exist"
 * 然后装上的客户端搜什么都挂 (3.6.3/3.6.4 都踩过)。
 *
 * @vscode/ripgrep 自己的 postinstall 有两个坑:
 *   1. 只要 bin/ 目录在就当成功, 不管里面有没有二进制
 *   2. 走 Node https.get, 不认 Windows 系统代理 (Clash 开着也直连 GitHub → 超时)
 *
 * 这里用 curl (跟 download-node-runtime 一样走系统代理), 并按「文件在且够大」判据。
 *
 *   node scripts/ensure-ripgrep.cjs
 *   node scripts/ensure-ripgrep.cjs --platform win32 --arch x64 --strict
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION = 'v15.0.0';
const GITHUB_REPO = 'https://github.com/microsoft/ripgrep-prebuilt/releases/download';
const MIN_BYTES = 50 * 1024;

const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

function parseArgs(argv) {
  const out = { platform: os.platform(), arch: os.arch(), strict: false, force: false };
  if (out.arch === 'ia32') out.arch = 'x64';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) out.platform = argv[++i];
    else if (a === '--arch' && argv[i + 1]) out.arch = argv[++i];
    else if (a === '--strict') out.strict = true;
    else if (a === '--force') out.force = true;
  }
  return out;
}

function binDir() {
  return path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep', 'bin');
}

function rgName(platform) {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function rgPath(platform) {
  return path.join(binDir(), rgName(platform));
}

function present(file) {
  try {
    return fs.statSync(file).size >= MIN_BYTES;
  } catch {
    return false;
  }
}

function proxyCandidates() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const out = [];
  const seen = new Set();
  for (const p of [fromEnv, 'http://127.0.0.1:7897', 'http://127.0.0.1:7890', '']) {
    const key = p || '(direct)';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
  /* Win 上 Clash 常只写进系统代理, curl 默认直连 GitHub 会 schannel 握手失败。
   * 先跟环境变量, 再试本机常见端口, 最后直连。 */
  let lastErr;
  for (const proxy of proxyCandidates()) {
    try {
      const args = ['-fL', '--retry', '2', '--retry-delay', '1', '--max-time', '90', '-o', tmp, url];
      if (proxy) args.unshift('-x', proxy);
      if (proxy) console.log(`[ripgrep]    via ${proxy}`);
      execFileSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    }
  }
  throw lastErr || new Error('curl failed');
}

function extractArchive(archive, destDir, platform) {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform === 'win32' || archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      return;
    }
    execFileSync('unzip', ['-o', archive, '-d', destDir], { stdio: ['ignore', 'inherit', 'inherit'] });
    return;
  }
  execFileSync('tar', ['xzf', archive, '-C', destDir], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function hoistBinary(destDir, name) {
  const direct = path.join(destDir, name);
  if (present(direct)) return direct;
  for (const entry of fs.readdirSync(destDir)) {
    const sub = path.join(destDir, entry);
    if (!fs.statSync(sub).isDirectory()) continue;
    const nested = path.join(sub, name);
    if (present(nested)) {
      fs.renameSync(nested, direct);
      fs.rmSync(sub, { recursive: true, force: true });
      return direct;
    }
  }
  return null;
}

function copyLocalSidecar(dest, platform, arch) {
  if (platform !== 'win32') return false;
  if (arch !== os.arch() && !(arch === 'x64' && (os.arch() === 'x64' || os.arch() === 'ia32'))) return false;
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, 'C:\\Users\\Administrator\\AppData\\Local'].filter(Boolean);
  for (const root of roots) {
    const src = path.join(root, 'Programs', 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe');
    if (!present(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return present(dest);
  }
  return false;
}

function fail(strict, message) {
  if (strict) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.warn(`⚠️  ${message}`);
  process.exit(0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const key = `${opts.platform}-${opts.arch}`;
  const triple = TARGETS[key];
  if (!triple) {
    fail(opts.strict, `ensure-ripgrep: 不支持 ${key}`);
    return;
  }

  const dest = rgPath(opts.platform);
  if (!opts.force && present(dest)) {
    console.log(`[ripgrep] ✓ ${dest}`);
    return;
  }

  const pkgRoot = path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep');
  if (!fs.existsSync(pkgRoot)) {
    fail(opts.strict, `@vscode/ripgrep 没装, 没法落 ${rgName(opts.platform)}`);
    return;
  }

  const ext = opts.platform === 'win32' ? '.zip' : '.tar.gz';
  const url = `${GITHUB_REPO}/${VERSION}/ripgrep-${VERSION}-${triple}${ext}`;
  const tmp = path.join(os.tmpdir(), `neox-ripgrep-${triple}${ext}`);

  console.log(`[ripgrep] ⬇  ${key} ← ${url}`);
  try {
    download(url, tmp);
    fs.mkdirSync(binDir(), { recursive: true });
    for (const stale of ['rg', 'rg.exe']) {
      const p = path.join(binDir(), stale);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    extractArchive(tmp, binDir(), opts.platform);
    const got = hoistBinary(binDir(), rgName(opts.platform));
    if (got && opts.platform !== 'win32') fs.chmodSync(got, 0o755);
    if (!present(dest)) {
      fail(opts.strict, `下完了但没找到 ${rgName(opts.platform)} (解压结果不对)`);
      return;
    }
    console.log(`[ripgrep] ✓ ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    if (copyLocalSidecar(dest, opts.platform, opts.arch)) {
      console.warn(`[ripgrep] GitHub 下不下来, 先用本机已有的 rg.exe (${dest})`);
      return;
    }
    fail(opts.strict, `下载/解压 ripgrep 失败: ${err && err.message ? err.message : err}`);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

main();
