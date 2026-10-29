'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const PKG = require('../package.json');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'neox.exe' : 'neox';
/* 跟主程序一起放的附件: 搜索用的 rg、文件监听 watcher.node (程序按自身所在目录找它们) */
const SIDECARS = IS_WIN ? ['rg.exe', 'watcher.node'] : ['rg', 'watcher.node'];
const DL_BASE = (process.env.NEOX_CLI_DOWNLOAD_BASE || 'https://dl.neox-dev.com/cli').replace(/\/+$/, '');

function installDir() {
  return process.env.NEOX_INSTALL_DIR || path.join(os.homedir(), '.neox', 'bin');
}
function binPath() { return path.join(installDir(), EXE); }
function markerPath() { return path.join(installDir(), 'neox.version'); }
function platformKey() { return `${process.platform}-${process.arch}`; }

/** 语义版本比较: a>b → 1, a<b → -1, 相等 → 0 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function installedVersion() {
  try {
    if (!fs.existsSync(binPath())) return null;
    return fs.readFileSync(markerPath(), 'utf8').trim() || null;
  } catch { return null; }
}

/** 本地已有同版本或更新的程序 (比如 `neox update` 升过) 就不用再下 */
function needsInstall() {
  const v = installedVersion();
  return !v || cmpVersion(v, (PKG.neoxBinary || {}).version || PKG.version) < 0;
}

/* ── 下载 (支持代理) ───────────────────────────────────────── */

function proxyFor(url) {
  const env = process.env;
  const noProxy = (env.NO_PROXY || env.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
  const host = new URL(url).hostname;
  if (noProxy.some(p => p === '*' || host === p.replace(/^\./, '') || host.endsWith(p.startsWith('.') ? p : `.${p}`))) return null;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw || !/^https?:\/\//i.test(raw)) return null; /* socks 之类不认, 直连 */
  return new URL(raw);
}

function connectTunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${target.hostname}:443` };
    if (proxy.username) {
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    }
    const req = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: `${target.hostname}:443`, headers,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`Proxy refused CONNECT (${res.statusCode})`)); return; }
      resolve(socket);
    });
    req.once('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Proxy connection timed out')));
    req.end();
  });
}

async function get(url, onProgress, redirects = 0) {
  const target = new URL(url);
  const proxy = proxyFor(url);
  const socket = proxy ? await connectTunnel(proxy, target) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: target.hostname, path: target.pathname + target.search,
      headers: { 'user-agent': `neox-npm-launcher/${PKG.version}` },
      ...(socket ? { socket, agent: false, servername: target.hostname } : {}),
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode}): ${url}`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', c => { chunks.push(c); got += c.length; if (onProgress) onProgress(got, total); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
  });
}

/* ── 解 tar (只取需要的几个文件) ─────────────────────────────── */

function untar(buf, wanted) {
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const field = (s, n) => header.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '');
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = off + 512;
    const base = name.replace(/^\.\//, '').replace(/^package\//, '');
    if ((type === '0' || type === '\0') && wanted.includes(base)) out[base] = buf.subarray(body, body + size);
    off = body + Math.ceil(size / 512) * 512;
  }
  return out;
}

/* ── 落地 ─────────────────────────────────────────────────── */

/** 把文件放到 dest: 旧文件 (可能正在跑) 先改名挪开, 再把新文件改名到位 */
function placeFile(dest, data, mode) {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.new-${process.pid}`);
  fs.writeFileSync(tmp, data, { mode });
  if (fs.existsSync(dest)) {
    const old = path.join(dir, `.${path.basename(dest)}.old-${Date.now()}`);
    try { fs.renameSync(dest, old); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    try { fs.rmSync(old, { force: true }); } catch { /* 正在跑, 下次清 */ }
  }
  fs.renameSync(tmp, dest);
}

function sweepOld() {
  try {
    for (const f of fs.readdirSync(installDir())) {
      if (/^\..+\.(old|new)-\d+$/.test(f)) { try { fs.rmSync(path.join(installDir(), f), { force: true }); } catch { /* 还在用 */ } }
    }
  } catch { /* 目录不存在 */ }
}

async function install({ quiet = false } = {}) {
  const key = platformKey();
  const meta = PKG.neoxBinary || {};
  const sha = meta.digests && meta.digests[key];
  if (!sha) {
    const have = Object.keys(meta.digests || {}).join(', ') || 'none';
    throw new Error(`No Neox CLI build for ${key} (available: ${have})`);
  }
  const version = meta.version || PKG.version;
  const url = `${DL_BASE}/${version}/${key}.tar.gz`;
  const say = m => { if (!quiet) process.stderr.write(`[neox] ${m}\n`); };

  say(`Downloading Neox CLI ${version} (${key}) ...`);
  let lastPct = -1;
  const tgz = await get(url, (got, total) => {
    if (quiet || !total || !process.stderr.isTTY) return;
    const pct = Math.floor((got / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stderr.write(`\r[neox] ${pct}%`); }
  });
  if (!quiet && process.stderr.isTTY && lastPct >= 0) process.stderr.write('\n');

  const actual = crypto.createHash('sha256').update(tgz).digest('hex');
  if (actual !== sha) throw new Error(`Checksum mismatch, not installing (expected ${sha}, got ${actual})`);

  const files = untar(zlib.gunzipSync(tgz), [EXE, ...SIDECARS]);
  if (!files[EXE]) throw new Error(`${EXE} not found in the download`);

  fs.mkdirSync(installDir(), { recursive: true });
  sweepOld();
  for (const name of SIDECARS) if (files[name]) placeFile(path.join(installDir(), name), files[name], 0o755);
  placeFile(binPath(), files[EXE], 0o755);
  fs.writeFileSync(markerPath(), `${version}\n`);
  say(`Installed to ${binPath()}`);
}

module.exports = { install, needsInstall, binPath, installDir, cmpVersion, untar, platformKey };
