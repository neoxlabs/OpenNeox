import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, join, relative, extname } from 'path';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import type { Plugin } from 'vite';

function dedupePublicAssets(): Plugin {
  let outDir = '';
  const hashOf = (p: string) => createHash('sha1').update(readFileSync(p)).digest('hex');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  return {
    name: 'neox-dedupe-public-assets',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const assetsDir = join(outDir, 'assets');
      const all = walk(outDir).filter((p) => !p.includes(`${join(outDir, '.vite')}`));
      const publicByHash = new Map<string, string>();
      for (const p of all) {
        if (p.startsWith(assetsDir + '/')) continue;
        if (statSync(p).size < 4096) continue;
        publicByHash.set(`${statSync(p).size}:${hashOf(p)}`, relative(outDir, p));
      }
      const swap = new Map<string, string>();
      for (const p of all) {
        if (!p.startsWith(assetsDir + '/') || /\.(js|mjs|css|html|map)$/.test(p)) continue;
        const hit = publicByHash.get(`${statSync(p).size}:${hashOf(p)}`);
        if (hit) swap.set(relative(assetsDir, p), `../${hit.split('\\').join('/')}`);
      }
      if (!swap.size) return;
      let saved = 0;
      for (const p of all) {
        if (!['.js', '.mjs', '.css', '.html'].includes(extname(p))) continue;
        const src = readFileSync(p, 'utf8');
        let next = src;
        for (const [hashed, pub] of swap) {
          next = next.split(`./assets/${hashed}`).join(`./assets/${pub}`)
            .split(`./${hashed}`).join(`./${pub}`)
            .split(`"${hashed}"`).join(`"${pub}"`);
        }
        if (next !== src) writeFileSync(p, next);
      }
      for (const hashed of swap.keys()) {
        const p = join(assetsDir, hashed);
        saved += statSync(p).size;
        rmSync(p);
      }
      console.log(`[dedupe-public-assets] 删掉 ${swap.size} 个跟 public 重复的带哈希文件, 省 ${(saved / 1048576).toFixed(1)} MB`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const prod = mode === 'production';
  const PROD_ENDPOINT = 'https://neox-dev.com';
  const endpointDefine: Record<string, string> = {};
  for (const key of ['VITE_NEOX_API_BASE', 'VITE_NEOX_GATEWAY_BASE', 'VITE_NEOX_WEB_BASE']) {
    const val = process.env[key] || (prod ? PROD_ENDPOINT : '');
    if (val) endpointDefine[`import.meta.env.${key}`] = JSON.stringify(val);
  }
  const regionDefine = { __NEOX_REGION__: JSON.stringify('global') };

  const subscription = (process.env.VITE_NEOX_SUBSCRIPTION || process.env.NEOX_SUBSCRIPTION || 'on').toLowerCase();
  const subscriptionDefine = { __NEOX_SUBSCRIPTION__: JSON.stringify(subscription) };
  return {
  root: resolve(__dirname, 'apps/desktop/src/ui/renderer'),
  plugins: [react(), dedupePublicAssets()],
  worker: { format: 'es' },
  esbuild: prod ? {} : { jsxDev: false },
  publicDir: resolve(__dirname, 'apps/desktop/src/ui/renderer/assets'),
  /* 极简版构建 (NEOX_EDITION=lite): 把主题壁纸模块整块换成不 import 图片的那份。
   *
   * 那 18 张 PNG 是静态 import —— 只要 import 还在, 图就一定进包 (源 25 MB / 出包约 40 MB),
   * 跟运行时选不选那个主题无关。极简版只给浅色/深色两档, 一张都用不到。
   * 用 alias 而不是在 packs.ts 里写 if: 打包器看的是 import 语句本身, 运行时的 if 删不掉字节。 */
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    warmup: {
      clientFiles: [
        './pages/settings/SettingsPage.tsx',
        './pages/settings/tabs/ThemeTab.tsx',
        './pages/settings/tabs/ProvidersTab.tsx',
        './pages/settings/tabs/StorageTab.tsx',
      ],
    },
  },
  base: './',  // 使用相对路径，支持 Electron 打包
  build: {
    /* 方案 C 后: 所有 build 产物统一在 apps/cli/dist/. vite renderer 产物
     * 作为 build-electron.js 的 source, 落到 ui/renderer 子树, 由后者拷到 ui-electron/renderer. */
    outDir: resolve(__dirname, 'apps/cli/dist/ui/renderer'),
    emptyOutDir: true,
    /* 产出 .vite/manifest.json — 供 scripts/build-pet-renderer-plugin.cjs 追溯 pet3d 专属
     * chunk 打成可上传商店的 zip, 也供 electron-builder-before-pack 钩子按需剔除 pet3d 文件
     * (3D 渲染器插件外置化). 对其它构建无副作用. */
    manifest: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    /* 多入口: 主窗口 index.html + 桌宠独立窗口 pet.html.
     *
     *   两个 entry 各自独立 bundle, 共享 node_modules (Vite 自动去重).
     *   桌宠窗口只加载 pet-entry.tsx → PetWindowRoot, 不会拖进 Neox 主 app
     *   的整 React 树 / 路由 / runtime / 编辑器等. 这是桌宠"启动 0 卡顿"的关键 —
     *   主 app bundle 几 MB, pet bundle 应该 < 200KB (含 React + 拖拽 hook).
     *   Three.js 通过 React.lazy 在桌宠窗口内按需拉, 进一步不堵首屏. */
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'apps/desktop/src/ui/renderer/index.html'),
        pet: resolve(__dirname, 'apps/desktop/src/ui/renderer/pet.html'),
        /* 3D 桌宠插件页面 — 独立 entry, 让 three/@react-three/* 只进这个 bundle,
         * 核心 pet bundle 不含 three. 主进程按需加载 pet3d.html. */
        pet3d: resolve(__dirname, 'apps/desktop/src/ui/renderer/pet3d.html'),
        /* computer use 被操控叠加层 — 独立 entry, 纯 canvas 无 React. 主进程
         * (computerOverlayWindowFactory) 按需加载 overlay.html. */
        overlay: resolve(__dirname, 'apps/desktop/src/ui/renderer/overlay.html'),
        /* Pilot 来电小窗 — 独立 entry, 无 React. 主进程 (pilotCallWindow) 来电时加载 call.html. */
        call: resolve(__dirname, 'apps/desktop/src/ui/renderer/call.html'),
      },
    },
  },
  resolve: {
    alias: [
      { find: '@ui', replacement: resolve(__dirname, 'apps/desktop/src/ui') },
      { find: 'monaco-editor', replacement: resolve(__dirname, 'packages/editor-engine/out/monaco-editor') },
      /* 极简版: 主题壁纸模块整块换成不 import 图片的那份。
       *
       * 那 18 张 PNG 是**静态 import** —— 只要 import 还在, 图就一定进包
       * (源 25 MB / 出包约 40 MB), 跟运行时选不选那个主题无关。
       * 极简版只给浅色/深色两档, 一张都用不到。
       * 用 alias 而不是在 packs.ts 里写 if: 打包器看的是 import 语句本身,
       * 运行时的 if 一个字节都删不掉。 */
      ...(process.env.NEOX_EDITION === 'lite' ? [{
        /* 必须匹配**整个**说明符 (^\.\/…$)。只匹配尾段的话 vite 只替换匹配到的那截,
         * 前面的 './' 会留下来, 拼出 './Users/...' 这种路径 —— 报的是 ENOENT,
         * 看着像文件不存在, 其实是替换姿势错了。 */
        find: /^\.\/packWallpapers$/,
        replacement: resolve(__dirname, 'apps/desktop/src/ui/state/themePacks/packWallpapers.lite.ts'),
      }] : []),
      ...['fs', 'child_process', 'worker_threads', 'net', 'tls', 'dgram', 'dns',
        'cluster', 'v8', 'vm', 'module', 'readline', 'tty', 'zlib', 'perf_hooks',
        'async_hooks', 'inspector', 'repl', 'string_decoder'].flatMap((m) => [
        { find: new RegExp(`^node:${m}$`), replacement: resolve(__dirname, 'apps/desktop/src/ui/renderer/shims/serverOnlyModule.ts') },
        { find: new RegExp(`^${m}$`), replacement: resolve(__dirname, 'apps/desktop/src/ui/renderer/shims/serverOnlyModule.ts') },
      ]),
    ],
  },
  define: {
    // 在浏览器环境中定义 global
    'global': 'globalThis',
    // 生产端点兜底 (见顶部注释)
    ...endpointDefine,
    // 出海双 channel region (cn/global) — 编译期烤死
    ...regionDefine,
    // 订阅功能闸 (on/off) — 见顶部注释
    ...subscriptionDefine,
  },
  optimizeDeps: {
    exclude: [
      'fsevents',
      // Monaco fork —— 防止 Vite 预构建从 node_modules 缓存原版，必须走 alias
      'monaco-editor',
      // Native Node.js modules —— 只在 Electron main 进程使用，不进 renderer bundle
      'tree-sitter',
      'tree-sitter-typescript',
      'better-sqlite3',
      'node-pty',
      'node-gyp-build',
      'chokidar',
      'fast-glob',
    ],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  };
});
