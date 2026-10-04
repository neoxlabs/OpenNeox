#!/usr/bin/env tsx

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(_dirname, '..');
const OUT = join(REPO_ROOT, 'release', 'cli-node-publish');
const DIST_SRC = join(REPO_ROOT, 'apps', 'cli', 'dist');

const DIST_INCLUDE = ['cli', 'server', 'vendor', 'prompts', 'tools', 'native', 'sdk'];

const DIST_EXCLUDE_EXT = ['.map'];
const BUNDLED_SCOPES = ['@neoxlabs/'];
const ROOT_EXTRA_DEPS = ['@parcel/watcher', 'jszip', 'mammoth', 'xlsx'];
const VENDORED_NATIVE = '@neoxlabs/native';

const PLATFORMS: Record<string, { os: string; cpu: string }> = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64':   { os: 'darwin', cpu: 'x64' },
  'linux-x64':    { os: 'linux',  cpu: 'x64' },
  'linux-arm64':  { os: 'linux',  cpu: 'arm64' },
  'win32-x64':    { os: 'win32',  cpu: 'x64' },
};

function log(m: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

function readDeps(rel: string): Record<string, string> {
  const p = join(REPO_ROOT, rel);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).dependencies ?? {}) : {};
}

/** 发布包 runtime deps = union(cli+core+sdk) + root extra, 去 @neoxlabs/*. (neox-native 单独内嵌) */
function computeDeps(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const p of ['apps/cli/package.json', 'packages/core/package.json', 'packages/sdk/package.json']) {
    for (const [k, v] of Object.entries(readDeps(p))) {
      if (!BUNDLED_SCOPES.some((s) => k.startsWith(s))) merged[k] = v;
    }
  }
  const rootDeps = readDeps('package.json');
  for (const k of ROOT_EXTRA_DEPS) merged[k] = rootDeps[k] ?? '*';
  return merged;
}

function version(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'cli', 'package.json'), 'utf8')).version;
}

function currentPlatformId(): string {
  return `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
}

/** 该文件是否要被挡在分发包外 (见 DIST_EXCLUDE_EXT 注释). */
function isLeakyDistFile(p: string): boolean {
  return DIST_EXCLUDE_EXT.some((ext) => p.endsWith(ext));
}

function copyDist(destDist: string) {
  let skipped = 0;
  for (const sub of DIST_INCLUDE) {
    const src = join(DIST_SRC, sub);
    if (!existsSync(src)) continue;
    cpSync(src, join(destDist, sub), {
      recursive: true,
      /* cpSync 的 filter: 返回 false 就不拷这一项 (目录返 true 才会递归进去) */
      filter: (from) => {
        if (isLeakyDistFile(from)) { skipped++; return false; }
        return true;
      },
    });
  }
  if (skipped > 0) log(`  🔒 剔除 ${skipped} 个 sourcemap (源码泄漏护栏)`);
}

/** 内嵌 @neoxlabs/native (闭源 HMAC signer): index.js/.d.ts/package.json + 该 runner 平台 .node. */
function vendorNeoxNative(destNodeModules: string): number {
  const src = join(REPO_ROOT, 'node_modules', VENDORED_NATIVE);
  if (!existsSync(src)) throw new Error(`${VENDORED_NATIVE} 不在 node_modules — 先 npm install / napi build`);
  const dest = join(destNodeModules, VENDORED_NATIVE);
  mkdirSync(dest, { recursive: true });
  for (const f of ['index.js', 'index.d.ts', 'package.json']) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(dest, f));
  }
  const nodeFiles = readdirSync(src).filter((f) => f.endsWith('.node'));
  for (const f of nodeFiles) cpSync(join(src, f), join(dest, f));
  return nodeFiles.length;
}

/**
 * 打单个 platform 包 = dist + 该平台全套 prebuilt native (npm install 拉) + 内嵌 neox-native.
 * 必须在目标平台 runner 上跑 (npm install 拿该平台 prebuilt; CI runner 有工具链兜底编译)。
 */
function buildPlatformPackage(id: string) {
  const meta = PLATFORMS[id];
  if (!meta) throw new Error(`未知 platform: ${id}. 可选: ${Object.keys(PLATFORMS).join(', ')}`);
  const v = version();
  const outDir = join(OUT, 'platforms', id);
  log(`platform 包 @neoxlabs/cli-${id} v${v} → ${outDir}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'dist'), { recursive: true });

  /* 1. dist (去 ui-electron) */
  copyDist(join(outDir, 'dist'));

  /* 2. 装 runtime deps 进本包 node_modules (拿该平台 prebuilt native) */
  const deps = computeDeps();
  const tmpPkg = { name: `@neoxlabs/cli-${id}-stage`, version: v, private: true, dependencies: deps };
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(tmpPkg, null, 2));
  log(`  npm install ${Object.keys(deps).length} deps (该平台 prebuilt native)...`);
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: outDir, stdio: 'inherit' });

  /* 3. 内嵌 neox-native (闭源, 不上 npm) */
  const nNative = vendorNeoxNative(join(outDir, 'node_modules'));
  log(`  内嵌 ${VENDORED_NATIVE}: ${nNative} 个 .node`);

  /* 4. bin/neox.mjs launcher (platform 包自带, main wrapper 也可直接 exec dist) */
  mkdirSync(join(outDir, 'bin'), { recursive: true });
  writeFileSync(join(outDir, 'bin', 'neox.mjs'),
    `#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { dirname, join } from 'node:path';\nconst here = dirname(fileURLToPath(import.meta.url));\nawait import(join(here, '..', 'dist', 'cli', 'main.js'));\n`);
  chmodSync(join(outDir, 'bin', 'neox.mjs'), 0o755);

  /* 5. 终版 package.json: os/cpu 锁定 + bundledDependencies=全部 (装时零下载零编译) */
  const bundled = [...Object.keys(deps), VENDORED_NATIVE];
  const pkg = {
    name: `@neoxlabs/cli-${id}`,
    version: v,
    description: `Neox CLI native package for ${id}`,
    license: 'UNLICENSED',
    type: 'module',
    os: [meta.os],
    cpu: [meta.cpu],
    engines: { node: '>=20.0.0' },
    bin: { neox: 'bin/neox.mjs' },
    files: ['bin/', 'dist/', 'README.md'],
    dependencies: { ...deps, [VENDORED_NATIVE]: nativeVersion() },
    bundledDependencies: bundled,
    publishConfig: { access: 'restricted' },
  };
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(outDir, 'README.md'), `# @neoxlabs/cli-${id}\n\nNeox CLI platform package (${meta.os}/${meta.cpu}). 由 @neoxlabs/cli 按平台自动安装, 不要直接装。\n`);

  assertNoSourceLeak(join(outDir, 'dist'), `@neoxlabs/cli-${id} dist/`);

  log(`  ✓ platform 包 ${id}: deps=${Object.keys(deps).length} bundled=${bundled.length} native=${nNative}`);
}

/** 跑 scripts/check-source-leak.mjs; 命中泄漏它 exit 1 → 这里抛错中止构建。 */
function assertNoSourceLeak(dir: string, label: string) {
  execSync(
    `node ${JSON.stringify(join(REPO_ROOT, 'scripts', 'check-source-leak.mjs'))} ${JSON.stringify(dir)} --label=${JSON.stringify(label)}`,
    { stdio: 'inherit' },
  );
}

function nativeVersion(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', VENDORED_NATIVE, 'package.json'), 'utf8')).version ?? '0.0.0';
}

/** thin main 包: optionalDependencies → 5 platform 包 (os/cpu 决定装哪个) + wrapper exec 进匹配平台包. */
function buildMain() {
  const v = version();
  const outDir = join(OUT, 'main');
  log(`thin main @neoxlabs/cli v${v} → ${outDir}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'bin'), { recursive: true });

  const optionalDeps: Record<string, string> = {};
  for (const id of Object.keys(PLATFORMS)) optionalDeps[`@neoxlabs/cli-${id}`] = v;

  /* cli-wrapper.cjs: 找匹配平台子包, node 跑它的 dist/cli/main.js, forward stdio/signals. */
  const wrapper = `#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const SUPPORTED = ${JSON.stringify(Object.fromEntries(Object.keys(PLATFORMS).map((id) => [id, `@neoxlabs/cli-${id}`])), null, 2)};
const key = \`\${process.platform}-\${process.arch}\`;
const pkgName = SUPPORTED[key];
if (!pkgName) { process.stderr.write(\`neox: 不支持的平台 \${key}\\n\`); process.exit(1); }
let entry;
try { entry = path.join(path.dirname(require.resolve(\`\${pkgName}/package.json\`)), 'dist', 'cli', 'main.js'); }
catch { process.stderr.write(\`neox: 平台子包 \${pkgName} 没装 (--no-optional?). 修复: npm i -g \${pkgName}\\n\`); process.exit(1); }
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });
child.on('exit', (code, sig) => { if (sig) { try { process.kill(process.pid, sig); } catch {} } process.exit(code == null ? 1 : code); });
['SIGINT','SIGTERM','SIGHUP'].forEach((s) => process.on(s, () => { try { child.kill(s); } catch {} }));
`;
  writeFileSync(join(outDir, 'cli-wrapper.cjs'), wrapper);
  writeFileSync(join(outDir, 'bin', 'neox'), `#!/usr/bin/env node\nrequire('../cli-wrapper.cjs');\n`);
  chmodSync(join(outDir, 'bin', 'neox'), 0o755);

  const pkg = {
    name: '@neoxlabs/cli',
    version: v,
    description: 'Neox CLI · Professional AI code assistant',
    license: 'UNLICENSED',
    engines: { node: '>=20.0.0' },
    main: './cli-wrapper.cjs',
    bin: { neox: './bin/neox' },
    files: ['bin/', 'cli-wrapper.cjs', 'README.md', 'LICENSE'],
    optionalDependencies: optionalDeps,
    publishConfig: { access: 'restricted' },
    keywords: ['cli', 'ai', 'agent', 'code-assistant'],
    author: 'MK-CO',
    homepage: 'https://neox.dev',
  };
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(outDir, 'README.md'), `# Neox CLI\n\n\`\`\`\nnpm i -g @neoxlabs/cli   # 需要 Node >= 20\nneox\n\`\`\`\n\n安装时按平台自动拉对应 @neoxlabs/cli-<platform> 子包 (自带全部 prebuilt native, 零编译零下载)。\n`);
  const lic = join(REPO_ROOT, 'LICENSE');
  if (existsSync(lic)) cpSync(lic, join(outDir, 'LICENSE'));
  log(`  ✓ thin main: optionalDependencies → ${Object.keys(optionalDeps).length} platform 包`);
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k: string) => { for (const a of argv) if (a.startsWith(`${k}=`)) return a.slice(k.length + 1); return undefined; };
  const doMain = argv.includes('--main');
  let platform = get('--platform');
  if (platform === 'current') platform = currentPlatformId();

  if (!existsSync(join(DIST_SRC, 'cli', 'main.js'))) {
    console.error('❌ dist 没 build. 先: npm run build:packages && npx tsup');
    process.exit(2);
  }
  if (!doMain && !platform) {
    console.error('用法: --platform=current|<id> 和/或 --main');
    process.exit(2);
  }
  if (platform) buildPlatformPackage(platform);
  if (doMain) buildMain();

  console.log('');
  log('✓ 完成');
  if (platform) {
    console.log(`验收: cd ${join(OUT, 'platforms', platform)} && npm pack → 干净 npm install → 跑 eval`);
  }
}

main();
