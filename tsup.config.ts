import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
/* CLI 入口按发行版二选一 (商业 auth/cliEntry.ts / 公开 main.ts), 判据见 scripts/cli-entry.mjs */
import { resolveCliEntry } from './scripts/cli-entry.mjs';

const cliPkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, 'apps/cli/package.json'), 'utf8'),
).version as string;

export const OUT_DIR = join('apps', 'cli', 'dist');

export default defineConfig({
  define: {
    __NEOX_VERSION__: JSON.stringify(cliPkgVersion),
    __NEOX_REGION__: JSON.stringify('intl'),
  },
  entry: {
    'cli/main': resolveCliEntry(),
    'sdk/index': 'packages/core/src/sdk/index.ts',
    'server/main': 'packages/core/src/server/main.ts',
    /* 极简版的 IPC 桥装载入口 —— 必须是**独立入口**, 跟 server/main.js 同目录。
     * 路由表是 import 时的副作用填的, 而极简版后端没有任何东西 import 那些 handler,
     * 所以由 server 在 lite 形态下按 './liteHandlers.js' 运行时动态 import。
     * (放在 desktop 侧是因为依赖方向: core 不能 import desktop。) */
    //   adapter (inline 进 main.js) 用 new URL('./runtimeWorkerEntry.js', import.meta.url) 解析.
    //   bun binary 不再 worker fail (memory feedback_bun_compile_worker_fallback).
    'cli/runtimeWorkerEntry': 'packages/core/src/sdk/runtimeWorkerEntry.ts',
    // P10: Electron main + worker 直接 bundle 到 dist/ui-electron/ 对应位置.
    // 取代老的 `tsc --project tsconfig.electron.json` + build-electron.js reorganize 流程.
    /* 索引库 worker —— 代码索引的 SQLite 全在它手里, 主线程只 postMessage。
     * 布局必须跟上面那条一致, 否则 indexDbClient 里的
     * `new URL('../workers/indexDbWorker.js', import.meta.url)` 在打包版里解析不到。 */
    /* git 状态引擎 —— 起 git / 解析 / 增量 / 监听全在它里面, 主线程只转发。
     * 布局同上: gitStatusHost 用 `new URL('../workers/gitStatusWorker.js', import.meta.url)`。 */
    /* 同一个 worker 给极简版后端 (server/liteHandlers 也 import gitHandlers → gitStatusHost),
     * 从 server/ 按 '../workers/' 解析到这里。 */
    /* agent runtime 的 worker thread 入口 —— 必须在这张表里, 否则 dist 下没有真实文件,
     * `new URL('../workers/runtimeWorkerEntry.js', import.meta.url)` 解析到一个不存在的
     * 路径, worker 起不来。跟 indexingCpuWorker 同款布局 (那条已在打包版里验证过)。 */
  },
  format: ['esm'],
  target: 'node20',
  outDir: OUT_DIR,
  clean: true,
  sourcemap: process.env.NEOX_NO_SOURCEMAP !== '1',
  dts: false, // 不生成类型声明（CLI 不需要）
  minify: true, // 压缩代码
  splitting: false, // 单文件输出
  treeshake: true, // 移除未使用代码
  bundle: true, // 打包所有依赖
  // exports 用 "./*.js" → "./src/*.ts" 直指原 TS 源,外部化后 Node 22 / Electron 40
  // 的 type-stripping 模式会撞上不支持的 TS 语法(parameter properties 等).
  //  external 待遇 —— 但那是运气不是设计, 显式列出来才不会哪天加了根依赖就静默外部化。)
  // cloud: 桌面端 GitHub 源市场 (apps/desktop/src/marketplace) 引它的能力契约; 打包版的
  // node_modules 里没有这个 workspace 包, 外部化就是运行时 "Cannot find module"。
  noExternal: [/^@neoxlabs\/(cloud|core|sdk|kernel|platform)/],
  esbuildPlugins: [
    {
      name: 'external-bun-only-worker-path',
      setup(build) {
        build.onResolve({ filter: /workers[\\/]workerPathBun/ }, () => ({
          path: './workerPathBun.js',
          external: true,
        }));
      },
    },
  ],
  external: [
    // 保持 node 内置模块为外部依赖
    'fs',
    'path',
    'os',
    'readline',
    'child_process',
    'stream',
    'events',
    'util',
    'url',
    // NPM 依赖保持外部（会在 node_modules 安装）
    'axios',
    'chalk',
    'execa',
    'fast-glob',
    'openai',
    'ora',
    'prompts',
    'react',
    'react-reconciler',
    'react-reconciler/constants.js',
    'zod',
    '@types/react',
    // Ink and related dependencies (ESM with top-level await)
    'ink',
    'ink-box',
    'ink-select-input',
    'ink-spinner',
    'ink-text-input',
    'yoga-layout',
    'yoga-layout-prebuilt',
    'yoga-wasm-web',
    // Ink internal dependencies (must stay external — contain CJS require() calls)
    'ansi-escapes',
    'cli-cursor',
    'slice-ansi',
    'string-width',
    'widest-line',
    '@alcalzone/ansi-tokenize',
    'wrap-ansi',
    'patch-console',
    'signal-exit',
    'auto-bind',
    'is-in-ci',
    'es-toolkit',
    'es-toolkit/compat',
    'throttle-debounce',
    'stack-utils',
    // WebSocket
    'ws',
    // Hono (server)
    'hono',
    'hono/cors',
    'hono/streaming',
    '@hono/node-server',
    // Native modules (contain platform-specific binaries, cannot be bundled)
    '@vscode/ripgrep',
    'better-sqlite3',
    'node-pty',
    // sharp 含平台原生 libvips 二进制 — 桌宠 sprite 图集尺寸解析用, 必须 external
    'sharp',
    // Electron runtime 提供,不能 bundle
    'electron',
    // Tree-sitter 含 native addon
    'tree-sitter',
    'tree-sitter-typescript',
    // chokidar 有 fsevents 原生依赖,保持 external 让 Electron rebuild 处理
    'chokidar',
    // @parcel/watcher 含 watcher.node — 资源管理器与 WatchCoordinator 动态加载, 禁止 bundle
    '@parcel/watcher',
    '@parcel/watcher/wrapper.js',
    // electron main 可能间接拉到但不该 bundle 的重型 renderer deps
    'monaco-editor',
    '@monaco-editor/react',
    '@xterm/xterm',
    '@xterm/addon-fit',
    '@xterm/addon-web-links',
    'three',
    '@react-three/drei',
    '@react-three/fiber',
    'puppeteer-core',
  ],
  onSuccess: async () => {
    const fs = await import('fs');
    const path = await import('path');

    // 添加执行权限
    const mainFile = path.join(OUT_DIR, 'cli', 'main.js');
    fs.chmodSync(mainFile, 0o755);

    // 递归复制目录
    const copyDir = (src: string, dest: string) => {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };

    // vendor → OUT_DIR/vendor (P5 后 vendor 搬到 cli 包)
    const vendorSrc = path.join('apps', 'cli', 'vendor');
    copyDir(vendorSrc, path.join(OUT_DIR, 'vendor'));
    console.log(`Copied vendor → ${OUT_DIR}/vendor`);

    // 提示词不再明文 copy: gpt-agents-instructions 已烘焙成 base64 常量进 kernel bundle
    // (scripts/bake-prompts.mjs + gptAgentsInstructions.generated.ts), 避免解包即 cat 核心 IP。
    // 如需恢复明文分发, 反悔前先确认没有 .md 会随 asar 泄漏。

    // Electron 进程加载 OUT_DIR/ui-electron/server/main.js
    // 必须与 OUT_DIR/server/main.js 保持一致, 否则修复代码对 Electron 无效
    const electronServerDir = path.join(OUT_DIR, 'ui-electron', 'server');
    const serverSrc = path.join(OUT_DIR, 'server', 'main.js');
    const serverDest = path.join(electronServerDir, 'main.js');
    if (fs.existsSync(serverSrc)) {
      if (!fs.existsSync(electronServerDir)) {
        fs.mkdirSync(electronServerDir, { recursive: true });
      }
      fs.copyFileSync(serverSrc, serverDest);
      console.log(`✅ Synced ${serverSrc} → ${serverDest}`);
    }

    // skills/builtin → OUT_DIR/skills/builtin (P4 后 skills 在 core)
    const skillsSrc = path.join('packages', 'core', 'src', 'skills', 'builtin');
    if (fs.existsSync(skillsSrc)) {
      fs.rmSync(path.join(OUT_DIR, 'skills', 'builtin'), { recursive: true, force: true });
      copyDir(skillsSrc, path.join(OUT_DIR, 'skills', 'builtin'));
      console.log(`Copied skills/builtin → ${OUT_DIR}/skills/builtin`);
    }

    // monorepo package.json "type": "module" 会把 .js 当 ESM, 而 preload 用
    // CommonJS `require('electron')`, 必须用 .cjs 强制 CJS 解析)
    const preloadSrc = path.join('apps', 'desktop', 'src', 'ui', 'electron', 'preload.cjs');
    const preloadDest = path.join(OUT_DIR, 'ui-electron', 'electron', 'preload.cjs');
    if (fs.existsSync(preloadSrc) && fs.existsSync(path.dirname(preloadDest))) {
      fs.copyFileSync(preloadSrc, preloadDest);
      console.log(`✅ Synced preload.cjs → ${preloadDest}`);
    }
    /* 桌宠独立窗口的 preload — 跟主 preload 同款 CJS 文件, 通道表面小一圈, 单独同步 */
    const petPreloadSrc = path.join('apps', 'desktop', 'src', 'ui', 'electron', 'preload-pet.cjs');
    const petPreloadDest = path.join(OUT_DIR, 'ui-electron', 'electron', 'preload-pet.cjs');
    if (fs.existsSync(petPreloadSrc) && fs.existsSync(path.dirname(petPreloadDest))) {
      fs.copyFileSync(petPreloadSrc, petPreloadDest);
      console.log(`✅ Synced preload-pet.cjs → ${petPreloadDest}`);
    }
    /* computer use 被操控叠加层的 preload — 同款最小面 CJS */
    const overlayPreloadSrc = path.join('apps', 'desktop', 'src', 'ui', 'electron', 'preload-overlay.cjs');
    const overlayPreloadDest = path.join(OUT_DIR, 'ui-electron', 'electron', 'preload-overlay.cjs');
    if (fs.existsSync(overlayPreloadSrc) && fs.existsSync(path.dirname(overlayPreloadDest))) {
      fs.copyFileSync(overlayPreloadSrc, overlayPreloadDest);
      console.log(`✅ Synced preload-overlay.cjs → ${overlayPreloadDest}`);
    }
    // 清理旧版 preload.js 残留 (如果有)
    const legacyPreload = path.join(OUT_DIR, 'ui-electron', 'electron', 'preload.js');
    if (fs.existsSync(legacyPreload)) {
      fs.unlinkSync(legacyPreload);
    }

    const workersDir = path.join(OUT_DIR, 'ui-electron', 'workers');
    if (fs.existsSync(workersDir)) {
      for (const f of fs.readdirSync(workersDir)) {
        if (!f.endsWith('.js')) continue;
        const code = fs.readFileSync(path.join(workersDir, f), 'utf8');
        const hit = code.match(/import\s*\{[^}]*\}\s*from\s*['"]electron['"]/);
        if (hit) {
          throw new Error(`worker bundle ${f} 顶层具名导入 electron (${hit[0]}), worker 里会加载失败。改成运行时 createRequire('electron')。`);
        }
      }
    }

    // native module 备份由 rebuild-native.cjs 负责 (tsup 之后运行)
  },
});
