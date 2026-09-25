#!/usr/bin/env node

import { cp, access, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/* 统一 dist 根 — tsup outDir 同步定义在 tsup.config.ts OUT_DIR. */
const OUT_DIR = 'apps/cli/dist';
const distDir = join(OUT_DIR, 'ui-electron');
const viteDistDir = join(OUT_DIR, 'ui', 'renderer');

async function copyAssets() {
  try {
    const assetsDir = join(distDir, 'renderer', 'assets');
    await cp('apps/desktop/src/ui/renderer/assets', assetsDir, { recursive: true });
    console.log(`📦 Copied renderer assets → ${assetsDir}`);

    const srcIndex = join(viteDistDir, 'index.html');
    const destIndex = join(distDir, 'renderer', 'index.html');
    try {
      await access(srcIndex);
      await cp(srcIndex, destIndex);
      console.log(`📄 Copied renderer index.html → ${destIndex}`);
    } catch {
      console.log('ℹ️  Renderer index.html not found (dev mode) - skip copy');
    }

    /* 桌宠独立窗口 HTML — 跟 index.html 平行的第二入口 (vite rollupOptions.input.pet) */
    const srcPet = join(viteDistDir, 'pet.html');
    const destPet = join(distDir, 'renderer', 'pet.html');
    try {
      await access(srcPet);
      await cp(srcPet, destPet);
      console.log(`🐾 Copied renderer pet.html → ${destPet}`);
    } catch {
      console.log('ℹ️  Renderer pet.html not found (dev mode) - skip copy');
    }

    /* 3D 桌宠插件页面 — 第三入口 (vite input.pet3d). three 只在它的 bundle 里. */
    const srcPet3d = join(viteDistDir, 'pet3d.html');
    const destPet3d = join(distDir, 'renderer', 'pet3d.html');
    try {
      await access(srcPet3d);
      await cp(srcPet3d, destPet3d);
      console.log(`🧊 Copied renderer pet3d.html → ${destPet3d}`);
    } catch {
      console.log('ℹ️  Renderer pet3d.html not found (dev mode) - skip copy');
    }

    /* computer use 被操控叠加层页面 — 独立入口 (vite input.overlay) */
    const srcOverlay = join(viteDistDir, 'overlay.html');
    const destOverlay = join(distDir, 'renderer', 'overlay.html');
    try {
      await access(srcOverlay);
      await cp(srcOverlay, destOverlay);
      console.log(`🖥️  Copied renderer overlay.html → ${destOverlay}`);
    } catch {
      console.log('ℹ️  Renderer overlay.html not found (dev mode) - skip copy');
    }
  } catch (error) {
    console.warn('⚠️  Failed to copy assets:', error.message);
  }
}

/* dev 启动 (`electron ./apps/cli/dist/ui-electron/electron/main.js`) 时 Electron
 * 从 main 文件向上找最近的 package.json 当 app root, 用它的 name 算 userData 路径.
 * 不写这份 ui-electron/package.json 就会一路找到 monorepo 根, fallback 默认 'Electron',
 * userData 落在 ~/Library/Application Support/Electron/ 跟 prod (Neox/) 错开. */
async function writePackageJson() {
  try {
    const rootPkg = JSON.parse(await readFile('package.json', 'utf-8'));
    const appPkg = {
      name: 'Neox',
      productName: 'Neox',
      version: rootPkg.version,
      main: 'electron/main.js',
      type: 'module',
    };
    await writeFile(join(distDir, 'package.json'), JSON.stringify(appPkg, null, 2));
    console.log(`📋 Wrote ${distDir}/package.json (name=Neox)`);
  } catch (error) {
    console.warn('⚠️  Failed to write package.json:', error.message);
  }
}



/* builtin skills — 桌面 server 从 dist/ui-electron/server/ 起, skillRegistry.loadBuiltin
 * 解析 ../skills/builtin = dist/ui-electron/skills/builtin。跟 command worker 同坑:
 * electron-builder 只打包 dist/ui-electron/**, 不拷进来 = 桌面端 builtin skills
 * (commit/review/knowledge-ingest/knowledge-curator) 全部加载不到, 只剩用户级 skills。 */
async function copySkills() {
  try {
    const srcSkills = join(OUT_DIR, 'skills');
    const destSkills = join(distDir, 'skills');
    await cp(srcSkills, destSkills, { recursive: true });
    console.log(`✨ Copied builtin skills → ${destSkills}`);
  } catch (error) {
    console.warn('⚠️  Failed to copy builtin skills:', error.message);
  }
}

Promise.all([copyAssets(), writePackageJson(), copySkills()]).catch(err => {
  console.error('❌ Build-electron script failed:', err);
  process.exit(1);
});
