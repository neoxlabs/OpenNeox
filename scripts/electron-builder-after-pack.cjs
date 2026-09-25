'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function inferWinArch(context) {
  const outDir = String(context.appOutDir || '').toLowerCase();
  return outDir.includes('arm64') ? 'arm64' : 'x64';
}

function resolvePrebuildInstallBin(appDir) {
  return require.resolve('prebuild-install/bin.js', {
    paths: [appDir, process.cwd()],
  });
}

function resolveElectronVersion(context, appDir) {
  const fromContext = String(context.electronVersion || '').trim();
  if (fromContext) return fromContext;

  try {
    const electronPkgPath = require.resolve('electron/package.json', {
      paths: [appDir, process.cwd()],
    });
    const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8'));
    const version = String(electronPkg.version || '').trim();
    if (version) return version;
  } catch {}

  try {
    const projectPkgPath = path.join(__dirname, '..', 'package.json');
    const projectPkg = JSON.parse(fs.readFileSync(projectPkgPath, 'utf8'));
    const declared =
      projectPkg?.devDependencies?.electron ||
      projectPkg?.dependencies?.electron ||
      '';
    const matched = String(declared).match(/\d+\.\d+\.\d+/);
    if (matched) return matched[0];
  } catch {}

  return '';
}

//   source map (.map) 或 Neox 源码。所有平台打包后查一遍, 命中即中止构建。手动读 asar 头部
//   (JSON 文件清单, 不依赖外部 asar 模块), 在头里扫 ".map" 文件项 + Neox 源码路径。
function assertNoPackageBloat(context) {
  const script = path.join(__dirname, 'check-package-bloat.cjs');
  if (!fs.existsSync(script)) return;
  const candidates = [path.join(context.appOutDir, 'resources', 'app.asar')];
  try {
    for (const e of fs.readdirSync(context.appOutDir)) {
      if (e.endsWith('.app')) candidates.push(path.join(context.appOutDir, e, 'Contents', 'Resources', 'app.asar'));
    }
  } catch { /* 目录读不到就交给下面的 find 兜底 */ }
  const asarPath = candidates.find((p) => fs.existsSync(p));
  if (!asarPath) { console.warn('[afterPack] no app.asar found, skip bloat guard'); return; }
  /* 失败要让打包整体失败 —— 体积回归没有别的信号, 放过去就发出去了 */
  execFileSync(process.execPath, [script, asarPath], { stdio: 'inherit' });
}

function assertAsarNoSourceMaps(context) {
  const candidates = [path.join(context.appOutDir, 'resources', 'app.asar')]; // win/linux
  try { // mac: <*.app>/Contents/Resources/app.asar
    for (const e of fs.readdirSync(context.appOutDir)) {
      if (e.endsWith('.app')) candidates.push(path.join(context.appOutDir, e, 'Contents', 'Resources', 'app.asar'));
    }
  } catch {}
  const asarPath = candidates.find((p) => fs.existsSync(p));
  if (!asarPath) { console.warn('[afterPack] no app.asar found, skip source map guard'); return; }

  let headerStr;
  try {
    const fd = fs.openSync(asarPath, 'r');
    try {
      const lead = Buffer.alloc(16);
      fs.readSync(fd, lead, 0, 16, 0);
      const jsonLen = lead.readUInt32LE(12);
      if (!jsonLen || jsonLen > 512 * 1024 * 1024) throw new Error('asar jsonLen 不合理: ' + jsonLen);
      const headerBuf = Buffer.alloc(jsonLen);
      fs.readSync(fd, headerBuf, 0, jsonLen, 16);
      headerStr = headerBuf.toString('utf8'); // 头是 JSON 文件清单, 含所有文件名
    } finally { fs.closeSync(fd); }
  } catch (e) {
    console.warn('[afterPack] asar header read failed, skip source map guard: ' + e.message);
    return;
  }

  let fileList = null;
  try {
    const start = headerStr.indexOf('{');
    const end = headerStr.lastIndexOf('}');
    const tree = JSON.parse(headerStr.slice(start, end + 1));
    const acc = [];
    (function walk(node, prefix) {
      const files = node && node.files;
      if (!files) return;
      for (const name of Object.keys(files)) {
        const child = files[name];
        const p = prefix ? prefix + '/' + name : name;
        if (child && child.files) walk(child, p);
        else acc.push(p);
      }
    })(tree, '');
    fileList = acc;
    console.log('[afterPack] asar header parsed - ' + fileList.length + ' files listed');
  } catch (e) {
    throw new Error(
      '[afterPack] asar header 解析失败, 源码泄漏闸无法工作, 中止构建: ' + e.message
      + '\n  (asar 头应为 pickle: [u32=4][u32 headerSize][u32 payloadSize][u32 jsonLen][JSON])',
    );
  }

  let hasMap;
  let hasNeoxSrc;
  let hasTsSource;
  let hasPromptAsset = false;
  const isPromptAsset = (p) =>
    !/(^|\/)node_modules\//.test(p) && !/(^|\/)vendor\//.test(p) &&
    (/(^|\/)SKILL\.md$/.test(p) || (/(^|\/)(skills|prompts)\//.test(p) && /\.(md|txt|json)$/.test(p)));
  if (fileList) {
    hasMap = fileList.some((p) => p.endsWith('.map'));
    hasPromptAsset = fileList.some(isPromptAsset);
    hasNeoxSrc = fileList.some((p) => /(?:apps|packages)\/(?:core|cli|kernel|sdk)\/src\//.test(p));
    /* 判据锚在 apps/ 或 packages/ 前缀: 第三方 .tsx (react 的 use-effect-event.tsx 等) 不误报;
     * .d.ts 是类型声明不算源码。 */
    hasTsSource = fileList.some((p) =>
      /^.*(?:apps|packages)\/[a-z-]+\//.test(p) &&
      (/\.(tsx|mts|cts)$/.test(p) || (/\.ts$/.test(p) && !/\.d\.ts$/.test(p))));
  } else {
    /* 回退: 旧正则 (拼接路径两条在嵌套头上永不命中, 仅 .map 文件名闸有效 — 保底) */
    hasMap = /\.map"\s*:/.test(headerStr);
    hasNeoxSrc = /(?:apps|packages)[\\/]+(?:core|cli|kernel|sdk)[\\/]+src[\\/]/.test(headerStr);
    hasTsSource = /(?:apps|packages)[\\/]+[a-z-]+[\\/][^"]*\.(tsx|mts|cts)"\s*:/.test(headerStr)
      || /(?:apps|packages)[\\/]+[a-z-]+[\\/][^"]*(?<!\.d)\.ts"\s*:/.test(headerStr);
  }
  if (hasMap || hasNeoxSrc || hasTsSource || hasPromptAsset) {
    const offenders = fileList ? fileList.filter(isPromptAsset).slice(0, 10) : [];
    throw new Error(
      '[afterPack] source leak in app.asar (map=' + hasMap + ', neoxSrc=' + hasNeoxSrc +
      ', tsSource=' + hasTsSource + ', promptAsset=' + hasPromptAsset +
      '). 查 electron-builder.json files 的 .map / .ts* 排除与 @neoxlabs 源码包排除' +
      (offenders.length ? '\n  prompt 明文: ' + offenders.join(', ') +
        '\n  修: 别把 skills/prompts 明文拷进 dist/ui-electron —— 运行时走烘焙快照 (bake-skills.mjs)' : ''),
    );
  }
  console.log('[afterPack] source guard passed - app.asar has no .map / no TS source / no Neox src / no prompt 明文');

  let sensitiveHit;
  if (fileList) {
    const sensitiveChecks = [
      (p) => p.endsWith('/test-account.json') || p === 'test-account.json',
      (p) => p.endsWith('/.env') || p === '.env',
      (p) => /(^|\/)\.env\.[a-z]+$/.test(p),
      (p) => p.includes('.neox-secrets/'),
      (p) => /release-suite\/.*creds/.test(p),
    ];
    sensitiveHit = sensitiveChecks
      .map((fn, i) => {
        const hit = fileList.find(fn);
        return hit ? 'pattern#' + i + '(' + hit + ')' : null;
      })
      .filter(Boolean);
  } else {
    const sensitivePatterns = [
      /"[^"]*test-account\.json"\s*:/,
      /"[^"]*\.env"\s*:/,
      /"[^"]*\.env\.[a-z]+"\s*:/,
      /"[^"]*\.neox-secrets[\\/][^"]*"\s*:/,
      /"[^"]*release-suite[\\/][^"]*creds"\s*:/,
    ];
    sensitiveHit = sensitivePatterns
      .map((r, i) => (r.test(headerStr) ? `pattern#${i}` : null))
      .filter(Boolean);
  }
  if (sensitiveHit.length > 0) {
    throw new Error(
      '[afterPack] 🔴 敏感文件进 asar (' + sensitiveHit.join(',') + '). 打包中止. ' +
      '检查 electron-builder.json files 段的 exclude, 以及本地 apps/cli/dist 有没有误挪进 evals/creds/env 文件.',
    );
  }
  console.log('[afterPack] sensitive-file guard passed - no test-account/.env/creds in app.asar');

}

function assertMacAppArch(context) {
  /* context.arch 是 builder-util 的 Arch 枚举 (x64=1, arm64=3, universal=4) */
  const ARCH_NAMES = { 1: 'x64', 3: 'arm64', 4: 'universal' };
  const arch = ARCH_NAMES[context.arch];
  if (!arch) throw new Error(`[afterPack] 不认识的 mac 架构枚举 ${context.arch}, 架构闸无法工作 —— 不许发`);
  const app = fs.readdirSync(context.appOutDir).find((e) => e.endsWith('.app'));
  if (!app) throw new Error(`[afterPack] ${context.appOutDir} 里没有 .app, 架构闸无法工作`);
  const { checkMacAppArch } = require('./publish/mac-arch.cjs');
  const appPath = path.join(context.appOutDir, app);
  const r = checkMacAppArch(appPath, arch);
  if (r.violations.length) {
    throw new Error(
      `[afterPack] 🧬 ${r.violations.length} 个 Mach-O 不含 ${arch} —— 这个包在 ${arch} Mac 上会崩:\n  `
      + r.violations.slice(0, 40).join('\n  ')
      + '\n  mac 出包走 scripts/publish/desktop.sh (按架构 prepare), 别直接 electron-builder --mac --x64',
    );
  }
  console.log(`[afterPack] mac arch guard passed - ${r.checked} 个 Mach-O 全含 ${arch} (另一架构预编译且同级有 ${arch} 版: ${r.multiArchSkipped})`);
}

module.exports = async function afterPack(context) {
  assertAsarNoSourceMaps(context);

  assertNoPackageBloat(context);

  if (context.electronPlatformName === 'darwin') assertMacAppArch(context);

  if (context.electronPlatformName !== 'win32') return;

  const iconIco = path.join(context.appOutDir, 'resources', 'icon.ico');
  if (!fs.existsSync(iconIco)) {
    throw new Error(
      'afterPack: resources/icon.ico missing — Win10 任务栏/开始菜单会掉回 Electron 原子标',
    );
  }

  const appDir = context.appDir || context.packager?.appDir || process.cwd();
  const arch = inferWinArch(context);
  const electronVersion = resolveElectronVersion(context, appDir);
  if (!electronVersion) {
    throw new Error('afterPack: missing electronVersion');
  }

  const moduleDir = path.join(appDir, 'node_modules', 'better-sqlite3');
  const sourceBinary = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
  const packagedBinary = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );

  if (!fs.existsSync(packagedBinary)) {
    console.warn(`[afterPack] skip better-sqlite3 replace: missing ${packagedBinary}`);
    return;
  }

  const backupFile = path.join(os.tmpdir(), `neox-better-sqlite3-${Date.now()}-${process.pid}.node`);
  const hasSourceBinary = fs.existsSync(sourceBinary);

  try {
    if (hasSourceBinary) fs.copyFileSync(sourceBinary, backupFile);

    console.log(`[afterPack] fetching better-sqlite3 prebuild for win32/${arch}, electron ${electronVersion}`);
    const prebuildBin = resolvePrebuildInstallBin(appDir);
    execFileSync(
      process.execPath,
      [
        prebuildBin,
        '--runtime',
        'electron',
        '--target',
        electronVersion,
        '--platform',
        'win32',
        '--arch',
        arch,
      ],
      {
        cwd: moduleDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_build_from_source: 'false',
        },
      },
    );

    if (!fs.existsSync(sourceBinary)) {
      throw new Error(`afterPack: prebuild missing ${sourceBinary}`);
    }

    fs.copyFileSync(sourceBinary, packagedBinary);
    console.log(`[afterPack] replaced packaged better_sqlite3.node for win32/${arch}`);
  } finally {
    if (hasSourceBinary && fs.existsSync(backupFile)) {
      fs.copyFileSync(backupFile, sourceBinary);
      fs.unlinkSync(backupFile);
    }
  }
};
