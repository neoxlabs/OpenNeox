#!/usr/bin/env tsx
/**
 * build-cli-binaries — 把 apps/cli 编译成 5 个 platform 的 Bun single-file binary,
 *                     连同 thin wrapper 一起 populate 到 release/cli-publish/ 准备 publish.
 *
 *   设计思路:
 *     1. 不动 apps/cli 本体 (workspace 持续 work)
 *     2. 从 publish-templates 拷贝模板 + 注入 __VERSION__ / __PLATFORM__ 等占位
 *     3. 跑 bun build --compile --target=bun-<platform> 产出 binary 到对应 platform dir
 *     4. release/cli-publish/main/ + 5 个 platform/ 全部 ready 可 npm publish
 *
 *   用法:
 *     npm run build:cli-binaries                         # 5 个 platform 全 build
 *     npm run build:cli-binaries -- --platform=current   # 只 build 当前 platform
 *     npm run build:cli-binaries -- --platform=linux-x64,darwin-arm64
 *     npm run build:cli-binaries -- --version=2.2.0      # 显式 version (默认从 apps/cli/package.json)
 *     npm run build:cli-binaries -- --skip-binary        # 只 populate thin wrapper, 不跑 bun (调试用)
 *
 *   产出:
 *     release/cli-publish/
 *       main/                       @neoxlabs/cli (thin, 20KB)
 *         package.json              (from main/package.json.tpl + VERSION)
 *         bin/neox                  (placeholder, postinstall 替换)
 *         install.cjs               (postinstall)
 *         cli-wrapper.cjs           (wrapper)
 *         README.md
 *       platforms/
 *         darwin-arm64/             @neoxlabs/cli-darwin-arm64
 *           package.json
 *           neox                    (Mach-O arm64 binary, 70-100MB)
 *           README.md
 *         darwin-x64/...
 *         linux-x64/...
 *         linux-arm64/...
 *         win32-x64/...             @neoxlabs/cli-win32-x64
 *           package.json
 *           neox.exe
 *           README.md
 *
 *   不在 scope (后续 phase):
 *     · macOS notarize / Windows Authenticode signing — release 前在 CI 加
 *     · npm publish 真发布 — 由 .github/workflows/release-cli.yml 处理
 */

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, chmodSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
/* CLI 入口按发行版二选一 (商业 auth/cliEntry.ts / 公开 main.ts), 判据见 scripts/cli-entry.mjs */
import { resolveCliEntry } from './cli-entry.mjs';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);
const REPO_ROOT = join(_dirname, '..');

const CLI_PKG_DIR = join(REPO_ROOT, 'apps', 'cli');
const TEMPLATES_DIR = join(CLI_PKG_DIR, 'publish-templates');
const PUBLISH_OUT = join(REPO_ROOT, 'release', 'cli-publish');

const PLATFORMS: { id: string; bunTarget: string; os: string; cpu: string; exe: string }[] = [
  /* darwin-x64 (Intel Mac) + linux-arm64 暂移除: macos-13 runner 排队卡 publish / 设备少.
   * 要加回直接补这两行 + 同步 publish-templates/main 的 optionalDependencies & install.cjs. */
  { id: 'darwin-arm64',  bunTarget: 'bun-darwin-arm64',  os: 'darwin', cpu: 'arm64', exe: 'neox' },
  { id: 'linux-x64',     bunTarget: 'bun-linux-x64',     os: 'linux',  cpu: 'x64',   exe: 'neox' },
  { id: 'win32-x64',     bunTarget: 'bun-windows-x64',   os: 'win32',  cpu: 'x64',   exe: 'neox.exe' },
];

interface Args {
  platforms: string[];
  version: string;
  skipBinary: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const eqPrefix = `${k}=`;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === k && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
      if (argv[i].startsWith(eqPrefix)) return argv[i].slice(eqPrefix.length);
    }
    return undefined;
  };
  const skipBinary = argv.includes('--skip-binary');

  let platforms: string[];
  const platArg = get('--platform');
  if (!platArg) {
    platforms = PLATFORMS.map((p) => p.id);
  } else if (platArg === 'current') {
    const id = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
    platforms = [id];
  } else {
    platforms = platArg.split(',').map((s) => s.trim());
  }

  let version = get('--version') || '';
  if (!version) {
    const pkg = JSON.parse(readFileSync(join(CLI_PKG_DIR, 'package.json'), 'utf8'));
    version = pkg.version;
    if (!version) throw new Error('version 缺: apps/cli/package.json 没 version');
  }
  return { platforms, version, skipBinary };
}

/* ── 交叉编译用: 取目标平台的 sidecar ────────────────────────────────────────
 * 两个都从公开源拿, 不需要目标平台的机器。下载失败一律返回 null (调用方退回"不带"), 不阻塞出包。 */

const RIPGREP_RELEASE = 'v15.0.0'; // 跟 node_modules/@vscode/ripgrep/lib/postinstall.js 的 VERSION 同步
const RIPGREP_TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

/** 目标平台的 @parcel/watcher 平台包名 (linux 带 libc 后缀)。 */
function parcelWatcherPkgFor(p: { os: string; cpu: string }): string {
  return p.os === 'linux'
    ? `@parcel/watcher-${p.os}-${p.cpu}-glibc`
    : `@parcel/watcher-${p.os}-${p.cpu}`;
}

function crossCacheDir(id: string): string {
  const dir = join(REPO_ROOT, '.tmp-cross-sidecar', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 下载目标平台的 ripgrep, 返回本地路径; 失败返 null。 */
function fetchCrossRipgrep(p: { id: string; os: string; cpu: string; exe: string }): string | null {
  const target = RIPGREP_TARGETS[p.id];
  if (!target) return null;
  const dir = crossCacheDir(p.id);
  const rgName = p.os === 'win32' ? 'rg.exe' : 'rg';
  const out = join(dir, rgName);
  if (existsSync(out)) return out;
  const isZip = p.os === 'win32';
  const asset = `ripgrep-${RIPGREP_RELEASE}-${target}.${isZip ? 'zip' : 'tar.gz'}`;
  const url = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RIPGREP_RELEASE}/${asset}`;
  const archive = join(dir, asset);
  try {
    execSync(`curl -fsSL -o "${archive}" "${url}"`, { stdio: 'pipe', timeout: 120000 });
    if (isZip) execSync(`unzip -o -q "${archive}" -d "${dir}"`, { stdio: 'pipe', timeout: 120000 });
    else execSync(`tar xzf "${archive}" -C "${dir}"`, { stdio: 'pipe', timeout: 120000 });
    if (!existsSync(out)) return null;
    chmodSync(out, 0o755);
    return out;
  } catch {
    return null;
  }
}

/** 下载目标平台的 watcher.node, 返回本地路径; 失败返 null。 */
function fetchCrossWatcher(p: { id: string; os: string; cpu: string }): string | null {
  const dir = crossCacheDir(p.id);
  const out = join(dir, 'watcher.node');
  if (existsSync(out)) return out;
  const pkg = parcelWatcherPkgFor(p);
  try {
    const packed = execSync(`npm pack ${pkg} --pack-destination "${dir}"`, {
      encoding: 'utf8', stdio: 'pipe', timeout: 180000,
    }).trim().split('\n').pop()!.trim();
    execSync(`tar xzf "${join(dir, packed)}" -C "${dir}"`, { stdio: 'pipe', timeout: 120000 });
    const extracted = join(dir, 'package', 'watcher.node');
    if (!existsSync(extracted)) return null;
    cpSync(extracted, out);
    return out;
  } catch {
    return null;
  }
}

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function ensureBun() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const sep = process.platform === 'win32' ? ';' : ':';
    if (home) {
      const bunDir = join(home, '.bun', 'bin');
      const bunExe = join(bunDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
      if (existsSync(bunExe) && !(process.env.PATH || '').split(sep).includes(bunDir)) {
        process.env.PATH = bunDir + sep + (process.env.PATH || '');
        log('env', `prepended ${bunDir} to PATH`);
      }
    }
  } catch { /* 非致命 */ }
  try {
    const v = execSync('bun --version', { encoding: 'utf8' }).trim();
    log('env', `bun ${v}`);
  } catch {
    console.error('❌ 没装 bun. 装: https://bun.sh (装后在 ~/.bun/bin, 本脚本会自动找)');
    process.exit(2);
  }
}

function injectTpl(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`__${k}__`, v),
    content,
  );
}

function populateMainPackage(version: string) {
  const outDir = join(PUBLISH_OUT, 'main');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'bin'), { recursive: true });

  /* 1. package.json (注入 version) */
  const pkgTpl = readFileSync(join(TEMPLATES_DIR, 'main', 'package.json.tpl'), 'utf8');
  writeFileSync(join(outDir, 'package.json'), injectTpl(pkgTpl, { VERSION: version }));

  cpSync(join(TEMPLATES_DIR, 'main', 'install.cjs'), join(outDir, 'install.cjs'));
  cpSync(join(TEMPLATES_DIR, 'main', 'uninstall.cjs'), join(outDir, 'uninstall.cjs'));
  cpSync(join(TEMPLATES_DIR, 'main', 'cli-wrapper.cjs'), join(outDir, 'cli-wrapper.cjs'));

  /* 3. bin/neox = JS launcher 入口 (永远走 cli-wrapper, 不再被 postinstall 换成指向 node_modules
   *    二进制的 symlink/copy — 那是 Windows EBUSY 的根源)。cli-wrapper.run() 把二进制 copy 到
   *    ~/.neox/bin 缓存再跑缓存那份, npm 重装永不锁文件。 */
  const launcher = `#!/usr/bin/env node\nrequire('../cli-wrapper.cjs').run();\n`;
  writeFileSync(join(outDir, 'bin', 'neox'), launcher);
  chmodSync(join(outDir, 'bin', 'neox'), 0o755);

  /* 4. README.md */
  const readmeTpl = readFileSync(join(TEMPLATES_DIR, 'main', 'README.md.tpl'), 'utf8');
  writeFileSync(join(outDir, 'README.md'), injectTpl(readmeTpl, { VERSION: version }));

  /* 5. LICENSE (从根 LICENSE 拷, 如果有) */
  const rootLicense = join(REPO_ROOT, 'LICENSE');
  if (existsSync(rootLicense)) cpSync(rootLicense, join(outDir, 'LICENSE'));

  log('main', `populated → ${outDir} (version=${version})`);
}

function syncFixedNameNativeNode(): void {
  const nativeDir = join(REPO_ROOT, 'packages', 'native');
  if (!existsSync(nativeDir)) return;
  let src = '';
  try {
    src = readdirSync(nativeDir)
      .filter((f) => f.startsWith('neox-native.') && f.endsWith('.node') && f !== 'neox-native.node')
      .map((f) => join(nativeDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? '';
  } catch { /* 目录读不到就跳过 */ }
  if (!src) {
    log('native', '⚠ 没找到 neox-native.<triple>.node — napi build 可能没跑');
    return;
  }
  const dest = join(nativeDir, 'neox-native.node');
  cpSync(src, dest);
  log('native', `固定名同步: ${src.split('/').pop()} → neox-native.node`);
}

/**
 * 构建后清洗: 把二进制里残留的构建机 home 路径换成中性占位符。
 *
 * 【为什么还要这一步】前面已经从源头修了两处 (Rust --remap-path-prefix、macOS LC_ID_DYLIB),
 * 但 bun --compile 还会把若干 JS 依赖在打包时算出的绝对路径内联进来:
 *     node_modules/{playwright-core,node-pty,electron,@vscode/ripgrep}/lib …
 * 这些路径在用户机器上根本不存在, 运行时必然走 fallback (否则装完就跑不起来),
 * 所以替换它们不影响功能 —— 它们纯粹是构建产物里的噪声, 却带出了开发者身份和目录结构。
 *
 * 【为什么等长替换】直接原地改字节, 不动文件长度和任何偏移 —— bun 二进制内部有大量
 * 基于偏移的结构 (嵌入资源表等), 长度一变就全废。把用户名换成同样长度的占位符最安全。
 *
 * 这一步同时是**兜底**: 将来再冒出新的路径泄漏来源, 不用逐个去猜, 这里统一扫干净。
 */
function scrubBuildPaths(binPath: string): void {
  if (!existsSync(binPath)) return;
  const home = homedir();
  const user = home.split(/[/\\]/).filter(Boolean).pop() || '';
  if (!user || user.length < 2) return;

  /* 要清两段, 都用等长占位符替换:
   *   1. 用户名           exampleuser        → neoxbuilder
   *   2. home 到仓库根之间 AI/OpenNeox         → neox-build
   * 只清 1 的话路径会变成 /Users/neoxbuilder/AI/OpenNeox/... —— 用户名是没了,
   * 但内部目录结构仍然摊在那里。两段都换掉才真正中性。 */
  const buf = readFileSync(binPath);
  const targets: Array<[string, string]> = [];

  const mkPlaceholder = (src: string, seed: string) => seed.padEnd(src.length, 'x').slice(0, src.length);
  targets.push([user, mkPlaceholder(user, 'neoxbuilder')]);

  /* 仓库根相对于 home 的那一段 (含分隔符归一) */
  const rel = REPO_ROOT.startsWith(home) ? REPO_ROOT.slice(home.length).replace(/^[/\\]+/, '') : '';
  if (rel && rel.length >= 3 && rel !== user) {
    targets.push([rel, mkPlaceholder(rel, 'neox-build')]);
  }

  let hits = 0;
  for (const [fromStr, toStr] of targets) {
    const from = Buffer.from(fromStr, 'utf8');
    const to = Buffer.from(toStr, 'utf8');
    if (from.length !== to.length) continue;
    let idx = buf.indexOf(from);
    while (idx !== -1) {
      to.copy(buf, idx);
      hits++;
      idx = buf.indexOf(from, idx + from.length);
    }
  }
  if (hits > 0) {
    writeFileSync(binPath, buf);
    log('scrub', `构建机路径清洗: ${targets.map(([f, t]) => `${f}→${t}`).join(', ')} (${hits} 处)`);

    if (process.platform === 'darwin') {
      const res = spawnSync('codesign', ['--force', '--sign', '-', binPath], { stdio: 'pipe' });
      if (res.status === 0) log('scrub', '已重新 ad-hoc 签名 (改字节后必须重签, 否则被 SIGKILL)');
      else throw new Error(`codesign 失败, 二进制会被系统杀掉: ${res.stderr?.toString().trim()}`);
    }
  }
}

function buildPlatformBinary(p: typeof PLATFORMS[number], version: string, skipBinary: boolean) {
  syncFixedNameNativeNode();
  const outDir = join(PUBLISH_OUT, 'platforms', p.id);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const rgName = p.os === 'win32' ? 'rg.exe' : 'rg';

  /* 1. package.json */
  const pkgTpl = readFileSync(join(TEMPLATES_DIR, 'platform', 'package.json.tpl'), 'utf8');
  writeFileSync(join(outDir, 'package.json'), injectTpl(pkgTpl, {
    PLATFORM: p.id, VERSION: version, OS: p.os, CPU: p.cpu, EXE_NAME: p.exe, RG_NAME: rgName,
  }));

  /* 2. README.md */
  const readmeTpl = readFileSync(join(TEMPLATES_DIR, 'platform', 'README.md.tpl'), 'utf8');
  writeFileSync(join(outDir, 'README.md'), injectTpl(readmeTpl, {
    PLATFORM: p.id, EXE_NAME: p.exe, BUN_TARGET: p.bunTarget.replace(/^bun-/, ''),
  }));

  /* 3. LICENSE */
  const rootLicense = join(REPO_ROOT, 'LICENSE');
  if (existsSync(rootLicense)) cpSync(rootLicense, join(outDir, 'LICENSE'));

  /* 4. Bun --compile binary */
  if (skipBinary) {
    log(p.id, `skip-binary mode, 跳过 bun build (只产 package metadata)`);
    return;
  }

  const t0 = Date.now();
  const outBinary = join(outDir, p.exe);
  log(p.id, `bun build --compile --target=${p.bunTarget} ... (耗时 1-3 分钟, 取决于 cross-compile)`);

  try {
    const bunBin = process.platform === 'win32' ? 'bun.exe' : 'bun';
    execFileSync(
      bunBin,
      [
        /* bun 在 apps/cli 下跑 → 入口转成相对 apps/cli 的路径 (src/main.ts 或 src/auth/cliEntry.ts) */
        'build', relative(CLI_PKG_DIR, join(REPO_ROOT, resolveCliEntry())).split('\\').join('/'), '--compile',
        `--target=${p.bunTarget}`,
        `--outfile=${outBinary}`,
        '--minify',
        '--define', `__NEOX_VERSION__="${version}"`,
        '--external', 'chromium-bidi/*',
      ],
      {
        cwd: CLI_PKG_DIR,
        stdio: ['inherit', 'pipe', 'inherit'],
        encoding: 'utf8',
      },
    );
  } catch (e: any) {
    console.error(`[${p.id}] ❌ bun build 失败: ${e.message}`);
    throw e;
  }

  if (!existsSync(outBinary)) {
    throw new Error(`[${p.id}] bun build 跑完但没产出 ${outBinary}`);
  }

  {
    const txt = readFileSync(outBinary).toString('latin1');
    // 纯 indexOf (不用正则/模板, 避免 esbuild 解析坑): 真 sourcemap 的 sources/sourcesContent 才会
    // 出现 packages/<pkg>/src/ 或 apps/cli/src/ 路径, 库代码字符串不会带 -> 命中即 Neox 源码 map 泄漏。
    const pkgs = ['packages/core', 'apps/cli', 'packages/kernel', 'packages/sdk'];
    const hasNeoxSrc = pkgs.some((n) => txt.indexOf(n + '/src/') >= 0);
    if (hasNeoxSrc) {
      throw new Error('[' + p.id + '] source map leak: binary has Neox source paths (check bun --sourcemap / dep inline map)');
    }
    log(p.id, 'source map guard passed - binary has no Neox source map');
  }

  scrubBuildPaths(outBinary);
  {
    const home = homedir();
    const user = home.split(/[/\\]/).filter(Boolean).pop() || '';
    if (user && user.length >= 2) {
      const txt = readFileSync(outBinary).toString('latin1');
      if (txt.indexOf(user) >= 0) {
        throw new Error(`[${p.id}] build path leak: binary still contains builder username "${user}"`);
      }
      const relPath = REPO_ROOT.startsWith(home) ? REPO_ROOT.slice(home.length).replace(/^[/\\]+/, '') : '';
      if (relPath && relPath.length >= 3 && txt.indexOf(relPath) >= 0) {
        throw new Error(`[${p.id}] build path leak: binary still contains repo path "${relPath}"`);
      }
      log(p.id, 'build path guard passed - no builder machine paths');
    }
  }

  if (p.id === `${process.platform}-${process.arch}`) {
    const probe = spawnSync(outBinary, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    if (probe.status !== 0 || !/\d+\.\d+\.\d+/.test(probe.stdout || '')) {
      throw new Error(
        `[${p.id}] binary smoke test failed (exit=${probe.status}, signal=${probe.signal}) — ` +
        `产物无法运行, 拒绝发布。输出: ${(probe.stdout || probe.stderr || '(空)').slice(0, 200)}`,
      );
    }
    log(p.id, `binary smoke test passed - ${(probe.stdout || '').trim()}`);
  }

  {
    const bakedTs = join(REPO_ROOT, 'packages', 'kernel', 'src', 'schemas', 'bakedSchemas.generated.ts');
    if (!existsSync(bakedTs)) {
      throw new Error(`[${p.id}] 缺 ${bakedTs} — 先跑 node scripts/bake-schemas.mjs (或 npm run build:packages)`);
    }
    /* 从 .generated.ts 里取 _b64 常量的中段做指纹 (中段避开首尾被 minify 拼接影响) */
    const m = readFileSync(bakedTs, 'utf8').match(/const _b64 = '([A-Za-z0-9+/=]+)'/);
    if (!m) throw new Error(`[${p.id}] bakedSchemas.generated.ts 格式异常, 取不到 _b64 常量`);
    const b64 = m[1];
    const probe = b64.slice(Math.floor(b64.length / 2), Math.floor(b64.length / 2) + 64);
    const txt = readFileSync(outBinary).toString('latin1');
    if (txt.indexOf(probe) < 0) {
      throw new Error(
        `[${p.id}] schema 内嵌护栏失败: binary 里找不到烘焙的 schemas 快照。` +
          `多半是 kernel dist 陈旧 — 跑 npm run build:packages 后重来。`,
      );
    }
    log(p.id, 'schema embed guard passed - baked schemas snapshot found in binary');
  }

  if (p.os !== 'win32') chmodSync(outBinary, 0o755);

  const hostId = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  const isNativeTarget = p.id === hostId;
  const rgSrc = isNativeTarget
    ? join(REPO_ROOT, 'node_modules', '@vscode', 'ripgrep', 'bin', rgName)
    : fetchCrossRipgrep(p);
  if (!rgSrc) {
    log(p.id, `⚠ 没拿到 ${p.id} 的 rg — 该平台包 search 会退化到系统 rg (装了才有)。`);
  } else if (existsSync(rgSrc)) {
    const rgDest = join(outDir, rgName);
    cpSync(rgSrc, rgDest);
    if (p.os !== 'win32') chmodSync(rgDest, 0o755);
    log(p.id, `✓ sidecar ripgrep → ${rgDest}`);
  } else {
    log(p.id, `⚠⚠ ripgrep 没找到 (${rgSrc}) — search 工具将不可用! CI 必须先下载 @vscode/ripgrep 的 rg (postinstall)。`);
  }

  /* 6. sidecar watcher.node — 文件监听用, 同 ripgrep 的道理。
   *   @parcel/watcher 的 index.js 是 `require('@parcel/watcher-<platform>-<arch>')`, 失败再试
   *   ./build/Release/watcher.node —— 这两条在 $bunfs 里都不存在, 编译版必然加载失败, 表现为
   *   WatchCoordinator 静默降级 (subscribers 收不到任何 fs 事件)。WatchCoordinator 会按 execPath
   *   同目录找这份 sidecar, 自己套 wrapper.js。
   *   注意: 只有【本机平台】的 .node 装在 node_modules 里, 交叉编译的目标平台拿不到 —— 那种情况
   *   跳过并明说, 别让 CI 以为发出去的包带了监听能力。 */
  /* linux 的平台包名带 libc 后缀 (-glibc / -musl), 另两个平台不带。 */
  const watcherPkg = parcelWatcherPkgFor(p);
  const localWatcher = join(REPO_ROOT, 'node_modules', watcherPkg, 'watcher.node');
  /* 本机装了就用本机的 (省一次网络); 交叉编译时从 npm 取目标平台那份 */
  const watcherSrc = existsSync(localWatcher) ? localWatcher : (fetchCrossWatcher(p) ?? localWatcher);
  if (existsSync(watcherSrc)) {
    const watcherDest = join(outDir, 'watcher.node');
    cpSync(watcherSrc, watcherDest);
    /* 跟 native 备份同一个坑: copy 过来的 adhoc+linker-signed 签名内核不认, 加载即 SIGKILL。 */
    if (p.os === 'darwin') {
      try { execSync(`codesign --force --sign - "${watcherDest}"`, { stdio: 'pipe' }); } catch { /* 非 mac 构建机没有 codesign */ }
    }
    log(p.id, `✓ sidecar watcher.node → ${watcherDest}`);
  } else {
    log(p.id, `⚠ 没有 ${p.os}-${p.cpu} 的 watcher.node (${watcherSrc}) — 该平台包的文件监听会降级 (交叉编译时正常)`);
  }

  /* 6.5 闸门: 随包发的可执行文件必须是【目标平台】的格式。
   *   靠 magic bytes 判, 不调 `file` (Windows 构建机没有)。装错平台的二进制不会在构建期报错,
   *   只会在用户机器上变成 "Exec format error", 所以这道闸必须在出包时就拦。 */
  {
    const MAGIC: Record<string, (b: Buffer) => boolean> = {
      /* ELF: 7f 45 4c 46 */
      linux: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
      /* Mach-O 64 little-endian: cf fa ed fe (也接受 fat: ca fe ba be) */
      darwin: (b) =>
        (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
        (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe),
      /* PE: 'MZ' */
      win32: (b) => b[0] === 0x4d && b[1] === 0x5a,
    };
    const check = MAGIC[p.os];
    const execNames = [p.exe, rgName];
    for (const nm of execNames) {
      const f = join(outDir, nm);
      if (!existsSync(f)) continue;
      const head = Buffer.alloc(4);
      const fd = openSync(f, 'r');
      try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
      if (check && !check(head)) {
        throw new Error(
          `[${p.id}] ${nm} 不是 ${p.os} 平台的可执行格式 (magic=${head.toString('hex')})\n` +
          `  → 多半是把构建机平台的二进制拷进了别的平台包; 发出去会是 "Exec format error"。`,
        );
      }
    }
    log(p.id, `binary format guard passed - 随包可执行文件都是 ${p.os} 格式`);
  }

  {
    const pkgPath = join(outDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files?: string[] };
    const declared = new Set(pkg.files ?? []);
    const shipped = readdirSync(outDir).filter((f) => f !== 'package.json' && f !== 'LICENSE');
    const missing = shipped.filter((f) => !declared.has(f));
    if (missing.length > 0) {
      throw new Error(
        `[${p.id}] 平台包目录里有文件没进 package.json 的 files: ${missing.join(', ')}\n` +
        `  → npm publish 会漏掉它们。改 apps/cli/publish-templates/platform/package.json.tpl。`,
      );
    }
    log(p.id, `files guard passed - ${shipped.length} 个随包文件都在 files 里`);
  }

  /* size 报告 — 用 fs.statSync, 别用 `ls -lh | awk` (Windows cmd 没这俩命令). */
  const sizeMb = (statSync(outBinary).size / (1024 * 1024)).toFixed(0);
  log(p.id, `✓ built ${outBinary} (${sizeMb}M) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main() {
  const args = parseArgs();
  log('env', `repo=${REPO_ROOT}`);
  log('env', `version=${args.version}`);
  log('env', `platforms=${args.platforms.join(', ')}${args.skipBinary ? ' (skip-binary)' : ''}`);

  if (!args.skipBinary) ensureBun();

  /* 1. populate main thin wrapper */
  populateMainPackage(args.version);

  /* 2. build each platform */
  const filtered = PLATFORMS.filter((p) => args.platforms.includes(p.id));
  if (filtered.length === 0) {
    console.error(`❌ 没匹配的 platform. 可选: ${PLATFORMS.map((p) => p.id).join(', ')}`);
    process.exit(2);
  }

  for (const p of filtered) {
    buildPlatformBinary(p, args.version, args.skipBinary);
  }

  console.log('');
  log('done', `release/cli-publish/ 准备完毕. publish 检查清单:`);
  console.log('  · release/cli-publish/main/                   (thin wrapper, 20KB)');
  for (const p of filtered) {
    console.log(`  · release/cli-publish/platforms/${p.id}/`);
  }
  console.log('');
  console.log('真发布前手动确认 (DRY run):');
  console.log('  cd release/cli-publish/main && npm publish --dry-run');
  console.log('  cd release/cli-publish/platforms/<platform> && npm publish --dry-run');
  console.log('');
  console.log('正式发布走 .github/workflows/release-cli.yml (CI), 别本地 publish.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
