#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NM = path.join(ROOT, 'node_modules');
const HOST = os.arch() === 'arm64' ? 'arm64' : 'x64';
const LIPO_NAME = { arm64: 'arm64', x64: 'x86_64' };
const RUST_TRIPLE = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const STATE_FILE = path.join(ROOT, '.neox-mac-arch-state.json');

/* 平台子包: 包名里带架构, 另一架构的那份不能进包, 目标架构的那份必须在。 */
const PLATFORM_PKGS = [
  (a) => `@img/sharp-darwin-${a}`,
  (a) => `@img/sharp-libvips-darwin-${a}`,
  (a) => `@parcel/watcher-darwin-${a}`,
];
/* 按 Electron ABI 编的原生模块 (同 scripts/electron-rebuild.cjs) + 包内必须是目标架构的文件 */
const ELECTRON_NATIVE = [
  { name: 'better-sqlite3', files: ['build/Release/better_sqlite3.node'] },
  { name: 'better-sqlite3-multiple-ciphers', files: ['build/Release/better_sqlite3.node'] },
  { name: 'keytar', files: ['build/Release/keytar.node'] },
  { name: 'node-pty', files: ['build/Release/pty.node', 'build/Release/spawn-helper'] },
];

const other = (arch) => (arch === 'arm64' ? 'x64' : 'arm64');
const log = (...a) => console.log('[mac-arch]', ...a);
function die(msg) {
  console.error(`❌ [mac-arch] ${msg}`);
  process.exit(1);
}

/* ── Mach-O 工具 ──────────────────────────────────────────────────────── */

const MACHO_MAGIC = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca']);

function readMagic(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    if (fs.readSync(fd, b, 0, 4, 0) < 4) return null;
    return b.toString('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** lipo -archs → ['arm64','x86_64'];不是 Mach-O 返回 null */
function lipoArchs(file) {
  const r = spawnSync('lipo', ['-archs', file], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split(/\s+/).filter(Boolean);
  const o = spawnSync('otool', ['-hv', file], { encoding: 'utf8' });
  if (o.status !== 0) return null;
  const m = /\n\s*MH_MAGIC(?:_64)?\s+(\w+)\s/.exec(o.stdout);
  if (!m) return null;
  return [{ X86_64: 'x86_64', ARM64: 'arm64' }[m[1]] ?? m[1].toLowerCase()];
}

function hasArch(file, arch) {
  const a = lipoArchs(file);
  return !!a && a.includes(LIPO_NAME[arch]);
}

/* ── 闸: 包内每个 Mach-O 都含目标架构 ──────────────────────────────────── */

/**
 * @param {string} appPath  .../Neox.app
 * @param {'arm64'|'x64'|'universal'} arch
 * @returns {{ checked: number, multiArchSkipped: number, violations: string[], table: Map<string, number> }}
 */
function checkMacAppArch(appPath, arch) {
  if (!fs.existsSync(appPath)) return { checked: 0, multiArchSkipped: 0, violations: [`app 不存在: ${appPath}`], table: new Map() };
  const wanted = arch === 'universal' ? ['arm64', 'x64'] : [arch];
  const violations = [];
  const table = new Map();
  let checked = 0;
  let multiArchSkipped = 0;

  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // framework 的 Versions/Current 等, 真文件会被走到
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.isFile()) continue;
      const magic = readMagic(p);
      if (!magic || !MACHO_MAGIC.has(magic)) continue;
      const archs = lipoArchs(p);
      if (!archs) {
        /* cafebabe 也是 Java class 的 magic —— lipo 不认就不是 Mach-O */
        if (magic === 'cafebabe' || magic === 'bebafeca') continue;
        violations.push(`lipo 读不出架构: ${path.relative(appPath, p)}`);
        continue;
      }
      checked++;
      const key = archs.join(' ');
      table.set(key, (table.get(key) || 0) + 1);
      const rel = path.relative(appPath, p);
      if (wanted.every((w) => archs.includes(LIPO_NAME[w]))) continue;

      /* 带另一架构标记的多架构预编译 (prebuilds/darwin-arm64/、koffi/darwin_arm64/ …):
       * 放行, 但同级必须有目标架构那份 —— 否则就是"只有另一架构" */
      if (arch !== 'universal') {
        const segs = rel.split(path.sep);
        const foreign = other(arch);
        const re = new RegExp(`darwin([-_.])${foreign}(?![a-z0-9])`);
        const idx = segs.findIndex((s) => re.test(s));
        if (idx >= 0) {
          const siblingSegs = segs.slice(0, idx + 1);
          siblingSegs[idx] = segs[idx].replace(re, `darwin$1${arch}`);
          const sibling = path.join(appPath, ...siblingSegs);
          if (fs.existsSync(sibling)) { multiArchSkipped++; continue; }
          violations.push(`[${key}] ${rel}  (只有 ${foreign} 版, 缺同级 ${siblingSegs.join('/')})`);
          continue;
        }
      }
      violations.push(`[${key}] ${rel}`);
    }
  };
  walk(appPath);
  if (checked === 0) violations.push(`一个 Mach-O 都没找到 —— 路径不对或 app 是空的: ${appPath}`);
  return { checked, multiArchSkipped, violations, table };
}

function cmdCheck(appPath, arch) {
  if (!appPath || !arch) die('用法: mac-arch.cjs check <Neox.app> --arch arm64|x64|universal');
  const r = checkMacAppArch(path.resolve(appPath), arch);
  log(`架构闸 ${appPath} (目标 ${arch}): ${r.checked} 个 Mach-O`);
  for (const [k, n] of r.table) log(`  ${k.padEnd(14)} ${n}`);
  if (r.multiArchSkipped) log(`  (${r.multiArchSkipped} 个另一架构的预编译, 同级都有 ${arch} 版, 放行)`);
  if (r.violations.length) {
    console.error(`❌ [mac-arch] ${r.violations.length} 个 Mach-O 不含 ${arch} —— 这个包在 ${arch} 机器上会崩, 不许发:`);
    for (const v of r.violations.slice(0, 80)) console.error('   ' + v);
    process.exit(1);
  }
  log(`✓ 全部含 ${arch}`);
}

/* ── prepare / restore ───────────────────────────────────────────────── */

function electronVersion() {
  return JSON.parse(fs.readFileSync(path.join(NM, 'electron', 'package.json'), 'utf8')).version;
}

function electronBinary(dist) {
  return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
}

async function ensureElectronDist(arch) {
  const version = electronVersion();
  if (arch === HOST && !process.env[`NEOX_ELECTRON_MAC_${arch.toUpperCase()}_DIST`]) {
    const dist = path.join(NM, 'electron', 'dist');
    if (!hasArch(electronBinary(dist), arch)) die(`node_modules/electron/dist 不是 ${arch} (本机架构) —— 重装 electron`);
    return dist;
  }
  const dist = process.env[`NEOX_ELECTRON_MAC_${arch.toUpperCase()}_DIST`]
    || path.join(os.homedir(), `.neox-electron-darwin-${arch}`, 'dist');
  const versionOk = () => {
    try { return fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '') === version; } catch { return false; }
  };
  if (!(fs.existsSync(electronBinary(dist)) && versionOk() && hasArch(electronBinary(dist), arch))) {
    log(`Electron ${version} darwin-${arch} dist 缺失/版本不符 → 下载到 ${dist}`);
    const { downloadArtifact } = require(path.join(NM, '@electron', 'get'));
    const zip = await downloadArtifact({ version, platform: 'darwin', arch, artifactName: 'electron' });
    const tmp = `${dist}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    /* ditto 保留 framework 里的符号链接; unzip 在某些 zip 上会把链接展开成副本 → 签名失败 */
    execFileSync('ditto', ['-x', '-k', zip, tmp], { stdio: 'inherit' });
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dist), { recursive: true });
    fs.renameSync(tmp, dist);
  }
  if (!versionOk()) die(`${dist}/version 不是 ${version}`);
  if (!hasArch(electronBinary(dist), arch)) die(`${electronBinary(dist)} 不含 ${arch}`);
  return dist;
}

function lockVersion(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  return lock.packages?.[`node_modules/${name}`]?.version || null;
}

function installedVersion(name) {
  try { return JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8')).version; } catch { return null; }
}

function ensurePlatformPackages(arch) {
  for (const mk of PLATFORM_PKGS) {
    const name = mk(arch);
    const hostName = mk(HOST);
    /* 本机那份没装 = 这个依赖已经不用了, 不强塞 */
    if (!fs.existsSync(path.join(NM, hostName))) { log(`  跳过 ${name} (本机的 ${hostName} 也没装)`); continue; }
    const want = lockVersion(name) || installedVersion(hostName);
    if (!want) die(`读不出 ${name} 应装的版本`);
    if (installedVersion(name) === want) { log(`  ✓ ${name}@${want}`); continue; }
    log(`  装 ${name}@${want} (npm pack, 不动 package.json / lock)`);
    const cache = path.join(os.homedir(), '.neox-mac-arch-cache', 'npm');
    fs.mkdirSync(cache, { recursive: true });
    const out = execFileSync('npm', ['pack', `${name}@${want}`, '--pack-destination', cache, '--silent'], { encoding: 'utf8', cwd: cache }).trim().split('\n').pop();
    const tgz = path.join(cache, out);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-mac-arch-'));
    execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
    const dest = path.join(NM, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(tmp, 'package'), dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (installedVersion(name) !== want) die(`${name} 装完版本不对`);
  }
}

function ensureElectronNative(arch) {
  const rebuildCli = path.join(NM, '@electron', 'rebuild', 'lib', 'cli.js');
  for (const m of ELECTRON_NATIVE) {
    const dir = path.join(NM, m.name);
    if (!fs.existsSync(dir)) continue;
    const exact = (f) => {
      const a = lipoArchs(path.join(dir, f));
      return !!a && a.length === 1 && a[0] === LIPO_NAME[arch];
    };
    if (m.files.every(exact)) { log(`  ✓ ${m.name} 已是 ${arch}`); continue; }
    log(`  重编 ${m.name} → electron ${electronVersion()} / ${arch}`);
    execFileSync(process.execPath, [rebuildCli, '--only', m.name, '-f', '--arch', arch, '--version', electronVersion()], { cwd: ROOT, stdio: 'inherit' });
    for (const f of m.files) if (!exact(f)) die(`${m.name}/${f} 重编后仍不是 ${arch}: ${lipoArchs(path.join(dir, f))}`);
  }
}

function ensureNeoxNative(arch) {
  const dir = path.join(ROOT, 'packages', 'native');
  const archFile = path.join(dir, `neox-native.darwin-${arch}.node`);
  if (arch !== HOST || !fs.existsSync(archFile)) {
    /* 非本机架构每次都编 (cargo 增量, 没改过几秒钟) —— 旧的 .node 可能是上个版本的源码 */
    log(`  编 neox-native (${RUST_TRIPLE[arch]})`);
    execFileSync('rustup', ['target', 'add', RUST_TRIPLE[arch]], { stdio: 'inherit' });
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'build-native.cjs'), 'build', '--platform', '--release', '--strip', '--target', RUST_TRIPLE[arch]], { cwd: dir, stdio: 'inherit' });
  }
  if (!hasArch(archFile, arch)) die(`${archFile} 不含 ${arch}`);
  /* main.ts 走固定名 require('@neoxlabs/native/neox-native.node') */
  fs.copyFileSync(archFile, path.join(dir, 'neox-native.node'));
  log(`  ✓ neox-native.node ← neox-native.darwin-${arch}.node`);
}

function ensureRipgrep(arch) {
  const rg = path.join(NM, '@vscode', 'ripgrep', 'bin', 'rg');
  if (fs.existsSync(rg) && hasArch(rg, arch)) { log(`  ✓ rg 已含 ${arch}`); return; }
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ensure-ripgrep.cjs'), '--platform', 'darwin', '--arch', arch, '--force', '--strict'], { stdio: 'inherit' });
  if (!hasArch(rg, arch)) die(`rg 下载后仍不含 ${arch}`);
}

function assertBundledResources(arch) {
  const bins = [
    'apps/desktop/resources/mac-speech/neox-mac-speech',
    'apps/desktop/resources/mac-speech/NeoxMacSpeech.app/Contents/MacOS/neox-mac-speech',
    'apps/desktop/resources/os-bridge/neox-os-bridge',
  ];
  for (const rel of bins) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    if (!hasArch(p, arch)) {
      die(`${rel} 不含 ${arch} (${lipoArchs(p)})。mac-speech 编 universal: bash apps/desktop/native/mac-speech/build.sh universal`);
    }
  }
  log(`  ✓ extraResources 里的二进制含 ${arch}`);
}

/**
 * 用**目标架构的 Electron** 真去加载每个原生模块。lipo 只说明架构, 说明不了 ABI
 * (node ABI 编出来的 .node 在 Electron 里照样 "compiled against a different Node.js version")。
 */
function verifyLoad(arch, dist) {
  const probe = `
    const r = [];
    const t = (n, f) => { try { f(); r.push('ok   ' + n); } catch (e) { r.push('FAIL ' + n + ': ' + String(e && e.message || e).split('\\n')[0]); } };
    t('better-sqlite3', () => { const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); });
    t('better-sqlite3-multiple-ciphers', () => { const D = require('better-sqlite3-multiple-ciphers'); new D(':memory:').prepare('select 1').get(); });
    t('keytar', () => require('keytar'));
    /* 真 spawn 一次: spawn-helper 架构不对只有这里才炸 */
    t('node-pty', () => { const p = require('node-pty').spawn('/bin/echo', ['ok'], {}); try { p.kill(); } catch {} });
    t('@parcel/watcher', () => require('@parcel/watcher'));
    t('sharp', () => require('sharp'));
    t('neox-native', () => require('@neoxlabs/native/neox-native.node'));
    console.log('arch=' + process.arch + ' abi=' + process.versions.modules);
    console.log(r.join('\\n'));
    process.exit(r.some((x) => x.startsWith('FAIL')) ? 1 : 0);
  `;
  const r = spawnSync('arch', [`-${LIPO_NAME[arch]}`, electronBinary(dist), '-e', probe], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const out = (r.stdout || '').trimEnd();
  if (out) console.log(out.replace(/^/gm, '[mac-arch]   '));
  if (r.status !== 0) die(`用 ${arch} Electron 加载原生模块失败 (status=${r.status})\n${r.stderr || ''}`);
}

/** 改写 electron-builder.json: 只出这一个架构 + 该架构的 Electron + 排除另一架构的平台子包 */
function writeBuilderConfig(arch, dist) {
  const file = path.join(ROOT, 'electron-builder.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.mac.target = j.mac.target.map((t) => ({ ...(typeof t === 'string' ? { target: t } : t), arch: [arch] }));
  j.electronDist = path.relative(ROOT, dist).startsWith('..') ? dist : path.relative(ROOT, dist);
  const f = other(arch);
  const excludes = [
    ...PLATFORM_PKGS.map((mk) => `!**/node_modules/${mk(f)}/**`),
    `!**/node_modules/@neoxlabs/native/neox-native.darwin-${f}.node`,
    `!**/node_modules/node-pty/bin/darwin-${f}-*/**`,
    /* better-sqlite3 的测试夹具 (运行时零引用); @electron/rebuild 走 prebuild 时不会重下它,
     * 于是 x64 包里留着一份 arm64 的 —— 直接不打进包 */
    '!**/node_modules/better-sqlite3*/build/Release/test_extension.node',
  ];
  j.files = [...j.files.filter((p) => !excludes.includes(p)), ...excludes];
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  log(`  ✓ electron-builder.json: mac.target.arch=[${arch}] electronDist=${j.electronDist}`);
}

async function cmdPrepare(arch, { writeConfig }) {
  if (!LIPO_NAME[arch]) die('用法: mac-arch.cjs prepare --arch arm64|x64 [--no-config]');
  if (process.platform !== 'darwin') die('只在 macOS 上跑');
  log(`准备 ${arch} (本机 ${HOST})`);
  if (arch !== HOST) {
    const r = spawnSync('arch', ['-x86_64', '/usr/bin/true']);
    if (arch === 'x64' && r.status !== 0) die('没装 Rosetta, 没法验证 x64 原生模块: softwareupdate --install-rosetta');
  }
  const dist = await ensureElectronDist(arch);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ arch, at: new Date().toISOString() }) + '\n');
  ensurePlatformPackages(arch);
  ensureElectronNative(arch);
  ensureNeoxNative(arch);
  ensureRipgrep(arch);
  assertBundledResources(arch);
  verifyLoad(arch, dist);
  if (writeConfig) writeBuilderConfig(arch, dist);
  if (arch === HOST) fs.rmSync(STATE_FILE, { force: true });
  log(`✓ ${arch} 就绪`);
}

async function cmdRestore() {
  if (!fs.existsSync(STATE_FILE)) { log('node_modules 本来就是本机架构, 不用还原'); return; }
  log(`把原生模块切回本机架构 ${HOST}`);
  ensureElectronNative(HOST);
  ensureNeoxNative(HOST);
  ensureRipgrep(HOST);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fix-native-module-signatures.cjs')], { cwd: ROOT, stdio: 'inherit' });
  verifyLoad(HOST, path.join(NM, 'electron', 'dist'));
  fs.rmSync(STATE_FILE, { force: true });
  log(`✓ 已还原到 ${HOST}`);
}

module.exports = { checkMacAppArch, lipoArchs };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const archIdx = argv.indexOf('--arch');
  const arch = archIdx >= 0 ? argv[archIdx + 1] : undefined;
  const run = async () => {
    if (cmd === 'prepare') return cmdPrepare(arch, { writeConfig: !argv.includes('--no-config') });
    if (cmd === 'restore') return cmdRestore();
    if (cmd === 'check') return cmdCheck(argv[1], arch);
    die('用法: mac-arch.cjs prepare --arch <a> | restore | check <Neox.app> --arch <a>');
  };
  run().catch((e) => die(e && e.stack || String(e)));
}
