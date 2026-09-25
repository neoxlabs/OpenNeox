#!/usr/bin/env node
'use strict';
/**
 * build-pet-renderer-plugin — 把 3D 桌宠渲染器 (pet3d.html + 它的全部依赖 chunk)
 * 打成一个可上传 NeoxCloud 商店的 zip: pet-renderer-3d.zip
 *
 * 商店端把它放到 `/plugins/pet-renderer-3d/download`, 客户端启用"立体"时下载解压到
 * userData/pet-renderers/3d/, 主进程 loadFile 那份 pet3d.html (见 petRendererPlugins.ts).
 *
 * 前置: 先跑过 `vite build --config vite.config.ui.ts` (产出 renderer + .vite/manifest.json).
 *
 * 用法: node scripts/build-pet-renderer-plugin.cjs
 * 产物: apps/cli/dist/pet-plugins/pet-renderer-3d.zip
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { pet3dAllFiles } = require('./lib/pet3dChunks.cjs');

const root = process.cwd();
const rendererDir = path.join(root, 'apps', 'cli', 'dist', 'ui', 'renderer');
const outDir = path.join(root, 'apps', 'cli', 'dist', 'pet-plugins');
const outZip = path.join(outDir, 'pet-renderer-3d.zip');

async function main() {
  if (!fs.existsSync(path.join(rendererDir, 'pet3d.html'))) {
    console.error(`❌ pet3d.html 不存在于 ${rendererDir} — 请先 vite build`);
    process.exit(1);
  }
  const files = pet3dAllFiles(rendererDir);
  if (!files) {
    console.error('❌ 读不到 vite manifest (.vite/manifest.json) — 确认 vite.config 已开 build.manifest');
    process.exit(1);
  }

  const zip = new JSZip();
  /* 入口 html (放根, 客户端 loadFile 这份) */
  zip.file('pet3d.html', fs.readFileSync(path.join(rendererDir, 'pet3d.html')));

  let count = 0;
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(rendererDir, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`⚠️  manifest 引用但缺失: ${rel}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    zip.file(rel, buf); /* 保持 assets/xxx 相对结构, 跟 html 引用一致 */
    count++;
    bytes += buf.length;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(outZip, content);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 打包 3D 渲染器插件: ${path.relative(root, outZip)}`);
  console.log(`   入口: pet3d.html + ${count} 个 chunk (${(bytes / 1024 / 1024).toFixed(2)} MB 未压缩)`);
  console.log(`   压缩后: ${(content.length / 1024 / 1024).toFixed(2)} MB`);
  console.log('   上传到 NeoxCloud 商店 → /plugins/pet-renderer-3d/download');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err) => {
  console.error('❌ build-pet-renderer-plugin failed:', err);
  process.exit(1);
});
