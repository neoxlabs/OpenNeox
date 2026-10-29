'use strict';
/**
 * pet3dChunks — 从 vite manifest 追溯 pet3d.html 的依赖文件集合
 *
 * 用于 3D 渲染器插件外置化:
 *   · build-pet-renderer-plugin.cjs  — 取 pet3d 全部依赖 (含共享 react) 打成可上传商店的 zip
 *   · electron-builder-before-pack   — 取 pet3d *专属* 文件 (排除 pet/main 也用的共享 chunk),
 *     打包时删掉它们, 让 three 不进安装包
 */

const fs = require('fs');
const path = require('path');

const ENTRY_KEYS = { pet3d: 'pet3d.html', pet: 'pet.html', main: 'index.html' };

/** 读取 vite manifest (renderer 目录下 .vite/manifest.json) */
function readManifest(rendererDir) {
  const p = path.join(rendererDir, '.vite', 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** 递归收集某 entry (manifest key) 的全部产出文件 (js chunk + css + assets) */
function collectEntryFiles(manifest, entryKey) {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const e = manifest[key];
    if (!e) return;
    if (e.file) files.add(e.file);
    for (const f of e.css || []) files.add(f);
    for (const f of e.assets || []) files.add(f);
    for (const k of e.imports || []) visit(k);
    for (const k of e.dynamicImports || []) visit(k);
  };
  visit(entryKey);
  return files;
}

/** pet3d 的全部依赖文件 (含共享 chunk) — 用于打 zip (下载副本是独立页面, 需自带全部) */
function pet3dAllFiles(rendererDir) {
  const manifest = readManifest(rendererDir);
  if (!manifest) return null;
  return [...collectEntryFiles(manifest, ENTRY_KEYS.pet3d)];
}

/** pet3d 专属文件 = pet3d 依赖 - (pet ∪ main 依赖). 用于打包时安全删除 (不碰共享 chunk). */
function pet3dExclusiveFiles(rendererDir) {
  const manifest = readManifest(rendererDir);
  if (!manifest) return null;
  const pet3d = collectEntryFiles(manifest, ENTRY_KEYS.pet3d);
  const shared = new Set([
    ...collectEntryFiles(manifest, ENTRY_KEYS.pet),
    ...collectEntryFiles(manifest, ENTRY_KEYS.main),
  ]);
  return [...pet3d].filter((f) => !shared.has(f));
}

module.exports = { readManifest, collectEntryFiles, pet3dAllFiles, pet3dExclusiveFiles, ENTRY_KEYS };
