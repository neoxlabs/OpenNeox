const fs = require('node:fs');
const path = require('node:path');
const { pet3dExclusiveFiles } = require('./lib/pet3dChunks.cjs');


/* 3D 渲染器插件外置化 (env 开关, 默认关):
 *   设 NEOX_EXTERNALIZE_PET3D=1 打包时, 把 pet3d 专属文件 (pet3d.html + three 等只有它用的 chunk)
 *   从待打包的 ui-electron/renderer 里删掉 → 不进安装包. 客户端启用"立体"时从 NeoxCloud 商店
 *   下载 (见 petRendererPlugins.ts). 前提: 已用 build-pet-renderer-plugin.cjs 打好 zip 上传商店.
 *   不开这个开关 → pet3d 仍内置, 3D 开箱即用 (商店未就绪阶段的安全默认). */
function maybeExternalizePet3d(rendererDestDir) {
  if (process.env.NEOX_EXTERNALIZE_PET3D !== '1') return;
  const exclusive = pet3dExclusiveFiles(rendererDestDir);
  if (!exclusive) {
    console.warn('[beforePack] 外置化跳过: 读不到 vite manifest (确认 build.manifest 已开 + 已 vite build)');
    return;
  }
  let removed = 0;
  /* pet3d.html 本体 */
  const html = path.join(rendererDestDir, 'pet3d.html');
  if (fs.existsSync(html)) { fs.rmSync(html); removed++; }
  /* pet3d 专属 chunk (不碰 pet/main 共享的) */
  for (const rel of exclusive) {
    const abs = path.join(rendererDestDir, rel);
    if (fs.existsSync(abs)) { fs.rmSync(abs); removed++; }
  }
  console.log(`[beforePack] 🧊 3D 外置化: 从安装包剔除 pet3d 专属文件 ${removed} 个 (改由商店按需下载)`);
}

module.exports = async function beforePack(_context) {
  const root = path.resolve(__dirname, '..');
  const base = path.join(root, 'apps', 'cli', 'dist');
  const destDir = path.join(base, 'ui-electron', 'renderer');
  const destIndex = path.join(destDir, 'index.html');
  if (fs.existsSync(destIndex)) {
    console.log('[beforePack] renderer 已就绪:', destIndex);
    maybeExternalizePet3d(destDir);
    return;
  }
  const srcDir = path.join(base, 'ui', 'renderer');
  const srcIndex = path.join(srcDir, 'index.html');
  if (fs.existsSync(srcIndex)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
    console.log('[beforePack] 自动 sync 渲染产物 →', destDir);
    maybeExternalizePet3d(destDir);
    return;
  }
  throw new Error(
    '[beforePack] 渲染产物缺失, 拒绝打出崩溃包.\n' +
    '  缺: ' + destIndex + '\n' +
    '  也没有可 sync 的源: ' + srcIndex + '\n' +
    '  → 打包前必须先跑完整生产构建:  npm run ui:build\n' +
    '     (它会 vite build 出 ui/renderer + ui:sync-renderer 拷进 ui-electron/renderer)\n' +
    '     只跑 ui:build-electron 不行 — 那只编 electron main, 不产生产 renderer.'
  );
};
