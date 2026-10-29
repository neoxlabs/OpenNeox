#!/usr/bin/env node
/**
 * Native Module 自动修复脚本
 *
 * better-sqlite3 / node-pty 都有 prebuild-install 发布预编译二进制，
 * 覆盖所有主流 Node 版本 + 平台。直接下载即可，不需要编译工具链。
 *
 * 本脚本在以下时机运行：
 * - postinstall（npm install 后）
 * - npm run build（构建时）
 * - 启动时检测到 ABI 不匹配（自动修复）
 *
 * 设计原则：必须成功，不允许降级。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const NATIVE_MODULES = ['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'node-pty'];
const ROOT = path.resolve(__dirname, '..');

function getABI() {
  return process.versions.modules;
}

/**
 * 直接用 process.dlopen 检测 .node 二进制的 ABI 是否匹配当前 Node。
 * 不走 require / require.cache，不会被内存缓存欺骗。
 */
const NATIVE_PATHS = {
  'better-sqlite3': 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'better-sqlite3-multiple-ciphers': 'node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node',
  'node-pty': 'node_modules/node-pty/build/Release/pty.node',
};

function isModuleOK(moduleName) {
  const moduleDir = path.join(ROOT, 'node_modules', moduleName);
  if (!fs.existsSync(moduleDir)) return true; // 包根本没装 (非依赖), 不归我们管

  /* 只认这个模块【特定的】native 文件名 (better_sqlite3.node / pty.node), 不能匹配任意 .node —
   * 否则 build/Release 里的无关 .node (如 better-sqlite3 的 test_extension.node) 会让缺失也误判 OK。 */
  const nativeFile = path.basename(NATIVE_PATHS[moduleName] || '');
  if (!nativeFile) return true; // 未登记的模块, 不管
  const searchDirs = [
    path.join(moduleDir, 'build', 'Release'),
    path.join(moduleDir, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
  const candidates = searchDirs
    .map((dir) => path.join(dir, nativeFile))
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) return false; // 该 native 一处都没有 → 缺失, 要修

  // 有 .node → dlopen 验 ABI (任一能 load = OK; 全部 NODE_MODULE_VERSION 不匹配才算坏)。
  for (const c of candidates) {
    try {
      process.dlopen({ exports: {} }, c);
      return true;
    } catch (e) {
      if (e.message && e.message.includes('NODE_MODULE_VERSION')) continue; // ABI 错, 试下一个
      return true; // 其他错 (如 symbol already loaded) = ABI 对, 只是重复加载
    }
  }
  return false; // 所有候选都 ABI 不匹配 → 要修
}

/** 找到 prebuild-install 的 bin.js */
function findPrebuildInstall(moduleName) {
  const moduleDir = path.join(ROOT, 'node_modules', moduleName);
  const candidates = [
    path.join(moduleDir, 'node_modules', 'prebuild-install', 'bin.js'),
    path.join(ROOT, 'node_modules', 'prebuild-install', 'bin.js'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * 用 prebuild-install 下载预编译二进制。
 * better-sqlite3 和 node-pty 都发布了覆盖所有 Node LTS 版本的 prebuilt。
 */
function prebuildInstall(moduleName) {
  const prebuildBin = findPrebuildInstall(moduleName);
  if (!prebuildBin) {
    throw new Error(`prebuild-install not found for ${moduleName} — run npm install first`);
  }

  const moduleDir = path.join(ROOT, 'node_modules', moduleName);
  const cmd = `"${process.execPath}" "${prebuildBin}" --runtime=node --target=${process.version} --arch=${process.arch} --platform=${process.platform} --verbose`;

  execSync(cmd, {
    cwd: moduleDir,
    stdio: 'inherit',
    timeout: 60000,
  });
}

/**
 * npm rebuild 兜底（需要 C++ 编译工具链，但比 prebuild-install 覆盖面更广）
 */
function npmRebuild(moduleName) {
  execSync(`npm rebuild ${moduleName}`, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 120000,
  });
}

/** macOS 签名 — rebuild 后 .node 文件需要重新签名 */
const ELECTRON_STASH_DIR = path.join(ROOT, 'node_modules', '.neox-electron-abi-stash');

/** 这个 .node 是不是"给别的 runtime 编的" (当前 Node dlopen 报 ABI 不匹配) */
function isForeignAbi(filePath) {
  try {
    process.dlopen({ exports: {} }, filePath);
    return false;
  } catch (e) {
    return !!(e && e.message && e.message.includes('NODE_MODULE_VERSION'));
  }
}

/** 把 node_modules 里"非当前 Node ABI"的 .node 存起来 → 返回 [[stashPath, origPath]] */
function stashForeignAbiBinaries() {
  const saved = [];
  for (const [, rel] of Object.entries(NATIVE_PATHS)) {
    const orig = path.join(ROOT, rel);
    if (!fs.existsSync(orig) || !isForeignAbi(orig)) continue;
    if (!fs.existsSync(ELECTRON_STASH_DIR)) {
      fs.mkdirSync(ELECTRON_STASH_DIR, { recursive: true });
    }
    /* 用相对路径当文件名, 避免不同包的同名 .node 互相覆盖 */
    const stash = path.join(ELECTRON_STASH_DIR, rel.replace(/[\\/]/g, '__'));
    fs.copyFileSync(orig, stash);
    saved.push([stash, orig]);
    console.log(`  ⇢ stashed foreign-ABI ${rel} (给桌面留着)`);
  }
  return saved;
}

/** 还原之前存起来的 Electron ABI 二进制, 让桌面继续可用 */
function restoreForeignAbiBinaries(saved) {
  if (!saved || saved.length === 0) return;
  for (const [stash, orig] of saved) {
    try {
      fs.copyFileSync(stash, orig);
      console.log(`  ⇠ restored ${path.relative(ROOT, orig)} (Electron ABI)`);
    } catch (e) {
      console.warn(`  ⚠ 还原失败 ${path.relative(ROOT, orig)}: ${e.message} — 桌面可能需要重跑 electron:rebuild`);
    }
  }
  /* 还原的是 Electron 版, 必须重新签名 (macOS 上换过内容的 .node 不签会被拒载) */
  fixSignatures();
}

/** 单个 .node 重签成普通 adhoc 签名 (macOS 专用; 别的平台无签名概念, 直接跳过)。 */
function signAdhoc(filePath) {
  if (process.platform !== 'darwin') return;
  try {
    execSync(`codesign --force --sign - "${filePath}"`, { stdio: 'pipe', timeout: 30000 });
  } catch (e) {
    /* 签不上就明说 —— 静默失败等于把 SIGKILL 留给下一个人查。 */
    console.warn(`  ⚠ codesign 失败 (${path.relative(ROOT, filePath)}): ${e?.message?.split('\n')[0] ?? e}`);
  }
}

function fixSignatures() {
  if (process.platform !== 'darwin') return;
  const signScript = path.join(ROOT, 'scripts', 'fix-native-module-signatures.cjs');
  if (!fs.existsSync(signScript)) return;
  try {
    execSync(`"${process.execPath}" "${signScript}"`, { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
  } catch { /* 签名失败不阻塞，Apple Silicon 以外的 Mac 可能不需要 */ }
}

function rebuildModule(moduleName) {
  console.log(`  [${moduleName}] ABI ${getABI()} · Node ${process.version} · ${process.platform}-${process.arch}`);

  // 1) prebuild-install：下载预编译二进制
  try {
    prebuildInstall(moduleName);
    if (isModuleOK(moduleName)) {
      console.log(`  [${moduleName}] ✓ OK (prebuilt)`);
      return;
    }
    console.log(`  [${moduleName}] prebuild-install ran but module still fails, trying npm rebuild...`);
  } catch (e) {
    console.log(`  [${moduleName}] prebuild-install failed, trying npm rebuild...`);
  }

  // 2) npm rebuild：从源码编译
  try {
    npmRebuild(moduleName);
    if (isModuleOK(moduleName)) {
      console.log(`  [${moduleName}] ✓ OK (compiled)`);
      return;
    }
  } catch { /* fall through */ }

  // 到这里说明两条路都失败了，不可接受
  console.error(`\n  ✗ FATAL: ${moduleName} cannot be loaded for Node ${process.version} (ABI ${getABI()}) on ${process.platform}-${process.arch}`);
  console.error(`  This should not happen. Possible causes:`);
  console.error(`    - Network issue (prebuild-install needs to download)`);
  console.error(`    - Missing C++ build tools (npm rebuild needs: python3, make, g++/clang)`);
  console.error(`    - Unsupported Node version (try Node 18/20/22 LTS)\n`);
  process.exit(1);
}

/** 备份已验证的 Node-ABI .node 到 dist/native/（运行时 database.ts 从这里还原）。
 *
 *  关键: 备份到**两个**位置 —
 *    1. apps/cli/dist/native/  (tsup outDir, 跟 bin 对齐)
 *    2. packages/core/dist/native/ (database.ts 解析 import.meta.url 实际查的位置)
 *  必须有 neox-core 这份: electron:rebuild 的 sync-native-to-dist 会把 neox-cli/dist/native/
 *  覆盖成 Electron-ABI, 只有 neox-core/dist/native/ 不被它动 → CLI(Node) 才有稳定的
 *  Node-ABI 备份可用, 否则桌面构建后跑 CLI 必崩 (NODE_MODULE_VERSION 143 vs 127)。 */
function backupNativeBinaries() {
  //   distNativeDirs=[] → 直接 return 不备份 → dist/native 空 → bun --compile 嵌不到
  //   better-sqlite3 (CI 上 bun 只认 database.ts 的 dist/native URL asset 路径, 不从 node_modules
  //   嵌) → 发布版 server 加载 DB 静默崩 (exit 1, "Server not connected")。本地构建因 dist 早已
  //   存在故永不复现。改成无条件 mkdir -p 两个目录再备份 (build:packages/tsc 不会清 dist/native)。
  const distNativeDirs = [
    path.join(ROOT, 'apps', 'cli', 'dist', 'native'),
    path.join(ROOT, 'packages', 'core', 'dist', 'native'),
  ];

  const files = [
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'better_sqlite3.node'],
    ['node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node', 'better_sqlite3_cipher.node'],
    ['node_modules/node-pty/build/Release/pty.node', 'pty.node'],
  ];
  for (const [src, dest] of files) {
    const srcPath = path.join(ROOT, src);
    if (!fs.existsSync(srcPath)) continue;
    // 备份前用 dlopen 验证 .node 是当前 Node ABI，不是 Electron 的
    try {
      process.dlopen({ exports: {} }, srcPath);
    } catch (e) {
      if (e.message && e.message.includes('NODE_MODULE_VERSION')) {
        console.warn(`  ⚠ Skipping ${dest} — ABI mismatch (file is not for current Node)`);
        continue;
      }
      // 其他错误（symbol already loaded 等）= ABI 对的
    }
    for (const distNative of distNativeDirs) {
      if (!fs.existsSync(distNative)) fs.mkdirSync(distNative, { recursive: true });
      const destPath = path.join(distNative, dest);
      fs.copyFileSync(srcPath, destPath);
      signAdhoc(destPath);
      console.log(`  ✓ Backed up ${dest} → ${path.relative(ROOT, distNative)}/ (ABI ${getABI()})`);
    }
  }
}

// ==================== Main ====================

const broken = NATIVE_MODULES.filter(mod => !isModuleOK(mod));

if (broken.length === 0) {
  // 全部正常 — 但仍然备份（确保 dist/native/ 始终是最新的）
  backupNativeBinaries();
  process.exit(0);
}

console.log(`Fixing native modules for Node ${process.version} (ABI ${getABI()})...`);

/* 先把桌面那份 (Electron ABI) 收好 —— 重编会覆盖它 */
const electronStash = stashForeignAbiBinaries();

for (const mod of broken) {
  rebuildModule(mod);
}

fixSignatures();

backupNativeBinaries();

/* 备份已经拿到 Node ABI 版了 (CLI 从 dist/native 读), node_modules 还给桌面。
 * 顺序很关键: 必须在 backupNativeBinaries() 之后, 否则备份会被 Electron 版污染。 */
restoreForeignAbiBinaries(electronStash);

console.log('All native modules OK.');
